"""Durable job queue backed by the ``job_runs`` table.

Why not Celery: the only broker-free option that works identically on PostgreSQL and SQLite and
needs no Redis for local development. Claiming uses a conditional UPDATE (status='queued' ->
'running'), which is safe with several worker processes on PostgreSQL. Retries use exponential
backoff; ``dedupe_key`` prevents duplicate enqueues of the same logical job.
"""

from __future__ import annotations

import traceback
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import JobRun
from app.db.session import SessionLocal

log = get_logger(__name__)

Handler = Callable[[Session, JobRun], dict | None]
_HANDLERS: dict[str, Handler] = {}


def job_handler(job_type: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        _HANDLERS[job_type] = fn
        return fn

    return deco


def registered_job_types() -> list[str]:
    _ensure_handlers()
    return sorted(_HANDLERS)


def _ensure_handlers() -> None:
    if not _HANDLERS:
        import app.tasks.handlers  # noqa: F401  (registers handlers)


def enqueue(
    db: Session,
    job_type: str,
    payload: dict | None = None,
    *,
    merchant_id: uuid.UUID | None = None,
    dedupe_key: str | None = None,
    created_by_id: uuid.UUID | None = None,
    run_at: datetime | None = None,
    max_attempts: int = 3,
) -> JobRun:
    """Persist a job (commits). With JOBS_EAGER the job runs before this returns."""
    _ensure_handlers()
    if job_type not in _HANDLERS:
        raise ValueError(f"Unknown job type {job_type}")
    if dedupe_key:
        existing = db.scalars(
            select(JobRun).where(JobRun.dedupe_key == dedupe_key, JobRun.status.in_(("queued", "running", "succeeded")))
        ).first()
        if existing:
            return existing
    job = JobRun(job_type=job_type, payload=payload or {}, merchant_id=merchant_id, dedupe_key=dedupe_key,
                 created_by_id=created_by_id, scheduled_for=run_at or datetime.now(UTC), max_attempts=max_attempts)
    db.add(job)
    db.commit()
    if get_settings().jobs_eager:
        run_job(job.id)
        db.refresh(job)
    return job


def claim_next(db: Session) -> uuid.UUID | None:
    now = datetime.now(UTC)
    candidates = db.scalars(
        select(JobRun.id).where(JobRun.status == "queued", JobRun.scheduled_for <= now)
        .order_by(JobRun.scheduled_for).limit(5)
    ).all()
    for jid in candidates:
        res = db.execute(
            update(JobRun).where(JobRun.id == jid, JobRun.status == "queued")
            .values(status="running", started_at=now, attempts=JobRun.attempts + 1)
        )
        db.commit()
        if res.rowcount == 1:
            return jid
    return None


def run_job(job_id: uuid.UUID) -> JobRun | None:
    """Execute one job in its own session; records success, retry or failure."""
    _ensure_handlers()
    db = SessionLocal()
    try:
        job = db.get(JobRun, job_id)
        if job is None:
            return None
        if job.status == "queued":  # eager path: claim inline
            job.status, job.started_at, job.attempts = "running", datetime.now(UTC), job.attempts + 1
            db.commit()
        handler = _HANDLERS[job.job_type]
        try:
            result = handler(db, job) or {}
            db.commit()
            job = db.get(JobRun, job_id)
            job.status, job.result, job.error, job.finished_at = "succeeded", result, None, datetime.now(UTC)
            db.commit()
        except Exception as exc:
            db.rollback()
            job = db.get(JobRun, job_id)
            job.error = f"{exc}\n{traceback.format_exc(limit=5)}"[:4000]
            if job.attempts < job.max_attempts and not get_settings().jobs_eager:
                job.status = "queued"
                job.scheduled_for = datetime.now(UTC) + timedelta(seconds=10 * 2 ** job.attempts)
                log.warning("Job %s (%s) failed, retrying: %s", job.id, job.job_type, exc)
            else:
                job.status, job.finished_at = "failed", datetime.now(UTC)
                log.error("Job %s (%s) failed permanently: %s", job.id, job.job_type, exc)
            db.commit()
        return job
    finally:
        db.close()


def run_pending(max_jobs: int = 100) -> int:
    """Drain due jobs synchronously (used by scripts and tests)."""
    count = 0
    while count < max_jobs:
        db = SessionLocal()
        try:
            jid = claim_next(db)
        finally:
            db.close()
        if jid is None:
            break
        run_job(jid)
        count += 1
    return count
