"""Background worker and scheduler.

Run standalone with ``python -m app.tasks.worker`` (recommended in production, see docker-compose),
or in-process inside the API when RUN_WORKER_IN_PROCESS=true (default for local demo).

The scheduler enqueues periodic jobs per merchant with a time-bucketed ``dedupe_key`` so that
several workers never enqueue the same scheduled run twice.
"""

from __future__ import annotations

import signal
import threading
import time
from datetime import UTC, datetime

from sqlalchemy import select

from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.db.models import Merchant
from app.db.session import SessionLocal
from app.tasks.queue import claim_next, enqueue, run_job

log = get_logger(__name__)

# job_type -> interval seconds
SCHEDULE: dict[str, int] = {
    "expiry_reevaluation": 60 * 60,
    "stockout_risk_refresh": 6 * 60 * 60,
    "forecast_refresh": 24 * 60 * 60,
    "promotion_lifecycle": 15 * 60,
    "analytics_refresh": 24 * 60 * 60,
    "fraud_scan": 6 * 60 * 60,
    "embedding_reindex": 24 * 60 * 60,
}


def schedule_due_jobs() -> int:
    started = datetime.now(UTC)
    now = started.timestamp()
    created = 0
    db = SessionLocal()
    try:
        merchants = db.scalars(select(Merchant.id)).all()
        for job_type, interval in SCHEDULE.items():
            bucket = int(now // interval)
            for mid in merchants:
                job = enqueue(db, job_type, {"scheduled": True}, merchant_id=mid,
                              dedupe_key=f"sched:{job_type}:{mid}:{bucket}")
                created += job.created_at >= started
    finally:
        db.close()
    return created


class Worker:
    def __init__(self, poll_seconds: float | None = None, scheduler: bool | None = None) -> None:
        s = get_settings()
        self.poll = poll_seconds if poll_seconds is not None else s.worker_poll_seconds
        self.scheduler = s.enable_scheduler if scheduler is None else scheduler
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_schedule = 0.0

    def run_forever(self) -> None:
        log.info("Worker started (scheduler=%s)", self.scheduler)
        while not self._stop.is_set():
            try:
                if self.scheduler and time.time() - self._last_schedule > 60:
                    self._last_schedule = time.time()
                    schedule_due_jobs()
                db = SessionLocal()
                try:
                    jid = claim_next(db)
                finally:
                    db.close()
                if jid is not None:
                    run_job(jid)
                    continue
            except Exception as exc:  # keep the worker alive
                log.exception("Worker loop error: %s", exc)
            self._stop.wait(self.poll)
        log.info("Worker stopped")

    def start_background(self) -> None:
        self._thread = threading.Thread(target=self.run_forever, name="omnipulse-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    w = Worker()
    signal.signal(signal.SIGINT, lambda *_: w.stop())
    signal.signal(signal.SIGTERM, lambda *_: w.stop())
    w.run_forever()


if __name__ == "__main__":
    main()
