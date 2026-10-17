"""Merchant dashboard metrics, shopping insights, audit log, background jobs, integrations and stores."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai.providers import get_ai_provider
from app.api.dependencies import (
    MerchantContext,
    get_merchant_context,
    page_params,
    require_permission,
    resolve_store_ids,
)
from app.core.config import get_settings
from app.core.exceptions import NotFoundError, ValidationFailedError
from app.db.models import AuditEvent, IntegrationConfig, JobRun, Store
from app.db.session import get_db
from app.schemas.common import Page, PageParams
from app.services import brief_service, dashboard_service
from app.services.audit_service import record_audit
from app.tasks.queue import enqueue, registered_job_types

router = APIRouter(prefix="/merchant", tags=["analytics"])


@router.get("/stores")
def merchant_stores(ctx: MerchantContext = Depends(get_merchant_context), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(select(Store).where(Store.merchant_id == ctx.merchant_id).order_by(Store.name)).all()
    return [{"id": str(s.id), "code": s.code, "name": s.name, "city": s.city, "latitude": s.latitude,
             "longitude": s.longitude, "geofence_radius_m": s.geofence_radius_m, "timezone": s.timezone}
            for s in rows if ctx.can_access_store(s.id)]


@router.get("/overview")
def overview(store_id: uuid.UUID | None = None, days: int = Query(30, ge=1, le=365),
             ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> dict:
    return dashboard_service.overview(db, ctx.merchant_id, resolve_store_ids(db, ctx, store_id), days)


@router.get("/ai-brief")
def ai_brief(store_id: uuid.UUID | None = None, refresh: bool = False,
             ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> dict:
    """Morning brief written by the configured AI provider (Gemini) from verified operational facts."""
    return brief_service.operations_brief(db, ctx.merchant_id, resolve_store_ids(db, ctx, store_id), refresh=refresh)


@router.get("/insights")
def insights(store_id: uuid.UUID | None = None, days: int = Query(30, ge=1, le=365),
             ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> dict:
    return dashboard_service.customer_insights(db, ctx.merchant_id, resolve_store_ids(db, ctx, store_id), days)


@router.get("/audit-events", response_model=Page[dict])
def audit_events(entity_type: str | None = None, action: str | None = Query(None, max_length=64),
                 entity_id: str | None = None, pp: PageParams = Depends(page_params),
                 ctx: MerchantContext = Depends(require_permission("audit.read")), db: Session = Depends(get_db)) -> dict:
    stmt = select(AuditEvent).where(AuditEvent.merchant_id == ctx.merchant_id)
    if entity_type:
        stmt = stmt.where(AuditEvent.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditEvent.entity_id == entity_id)
    if action:
        stmt = stmt.where(AuditEvent.action.like(f"{action}%"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(AuditEvent.created_at.desc()).offset(pp.offset).limit(pp.page_size)).all()
    return {"items": [{"id": str(e.id), "action": e.action, "entity_type": e.entity_type, "entity_id": e.entity_id,
                       "summary": e.summary, "actor": e.actor_label, "before": e.before, "after": e.after,
                       "request_id": e.request_id, "created_at": e.created_at.isoformat()} for e in rows],
            "total": total, "page": pp.page, "page_size": pp.page_size}


@router.get("/jobs")
def jobs(job_type: str | None = None, limit: int = Query(30, ge=1, le=200),
         ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> list[dict]:
    stmt = select(JobRun).where(JobRun.merchant_id == ctx.merchant_id)
    if job_type:
        stmt = stmt.where(JobRun.job_type == job_type)
    return [_job_out(j) for j in db.scalars(stmt.order_by(JobRun.created_at.desc()).limit(limit))]


def _job_out(j: JobRun) -> dict:
    return {"id": str(j.id), "job_type": j.job_type, "status": j.status, "attempts": j.attempts,
            "max_attempts": j.max_attempts, "result": j.result, "error": (j.error or "").split("\n")[0] or None,
            "scheduled_for": j.scheduled_for.isoformat(), "started_at": j.started_at.isoformat() if j.started_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None, "created_at": j.created_at.isoformat()}


@router.get("/jobs/{job_id}")
def job(job_id: uuid.UUID, ctx: MerchantContext = Depends(get_merchant_context), db: Session = Depends(get_db)) -> dict:
    j = db.get(JobRun, job_id)
    if j is None or j.merchant_id != ctx.merchant_id:
        raise NotFoundError("Job not found")
    return _job_out(j)


class JobTrigger(BaseModel):
    job_type: str = Field(max_length=48)


@router.post("/jobs")
def trigger_job(body: JobTrigger, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                db: Session = Depends(get_db)) -> dict:
    allowed = {"expiry_reevaluation", "forecast_refresh", "stockout_risk_refresh", "promotion_lifecycle",
               "analytics_refresh", "fraud_scan", "embedding_reindex"}
    if body.job_type not in allowed or body.job_type not in registered_job_types():
        raise ValidationFailedError(f"job_type must be one of {sorted(allowed)}")
    j = enqueue(db, body.job_type, {"manual": True}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id)
    return _job_out(j)


# ---------------------------------------------------------------------------- integrations

INTEGRATION_CATALOG = {
    "weather": {"providers": ["simulated", "openweathermap"], "env": ["WEATHER_PROVIDER", "OPENWEATHER_API_KEY"]},
    "pricing_publisher": {"providers": ["simulated_esl"], "env": []},
    "pos": {"providers": ["simulated_pos"], "env": []},
    "ecommerce": {"providers": ["simulated_feed"], "env": []},
    "payments": {"providers": ["simulated_gateway"], "env": []},
    "email": {"providers": ["log", "smtp"], "env": ["EMAIL_PROVIDER", "SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"]},
    "sms": {"providers": ["log"], "env": ["SMS_PROVIDER"]},
    "push": {"providers": ["log"], "env": ["PUSH_PROVIDER"]},
    "ai": {"providers": ["demo", "openai", "gemini"], "env": ["AI_PROVIDER", "OPENAI_API_KEY", "GEMINI_API_KEY"]},
}


def _effective(kind: str) -> dict:
    s = get_settings()
    if kind == "weather":
        live = s.weather_provider == "openweathermap" and bool(s.openweather_api_key)
        return {"live_capable": live, "active_provider": "openweathermap" if live else "simulated"}
    if kind == "email":
        live = s.email_provider == "smtp" and bool(s.smtp_host)
        return {"live_capable": live, "active_provider": "smtp" if live else "log (simulated)"}
    if kind == "ai":
        p = get_ai_provider()
        return {"live_capable": p.kind == "llm", "active_provider": p.name, "details": p.info()}
    return {"live_capable": False, "active_provider": "simulated"}


@router.get("/integrations")
def integrations(ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> list[dict]:
    cfgs = {c.kind: c for c in db.scalars(select(IntegrationConfig).where(IntegrationConfig.merchant_id == ctx.merchant_id))}
    out = []
    for kind, meta in INTEGRATION_CATALOG.items():
        c = cfgs.get(kind)
        out.append({"kind": kind, "providers": meta["providers"], "env_vars": meta["env"],
                    "configured_provider": c.provider if c else None, "mode": c.mode if c else "simulated",
                    "settings": c.settings if c else {}, "status": c.status if c else "ok",
                    "last_checked_at": c.last_checked_at.isoformat() if c and c.last_checked_at else None,
                    **_effective(kind)})
    return out


class IntegrationUpdate(BaseModel):
    mode: str = Field(pattern="^(simulated|live|disabled)$")
    provider: str | None = Field(default=None, max_length=48)
    settings: dict = Field(default_factory=dict)


@router.put("/integrations/{kind}")
def update_integration(kind: str, body: IntegrationUpdate, ctx: MerchantContext = Depends(require_permission("integrations.manage")),
                       db: Session = Depends(get_db)) -> dict:
    """Store non-secret integration settings. Secrets (API keys, passwords) are only read from environment variables."""
    if kind not in INTEGRATION_CATALOG:
        raise NotFoundError("Unknown integration")
    if any(k.lower() in ("api_key", "password", "secret", "token") for k in body.settings):
        raise ValidationFailedError("Secrets must be configured through environment variables, not stored here")
    c = db.scalars(select(IntegrationConfig).where(IntegrationConfig.merchant_id == ctx.merchant_id,
                                                   IntegrationConfig.kind == kind)).first()
    if c is None:
        c = IntegrationConfig(merchant_id=ctx.merchant_id, kind=kind, provider=body.provider or INTEGRATION_CATALOG[kind]["providers"][0])
        db.add(c)
    before = {"mode": c.mode, "settings": c.settings}
    c.mode, c.settings = body.mode, body.settings
    if body.provider:
        c.provider = body.provider
    c.last_checked_at = datetime.now(UTC)
    record_audit(db, action="integration.updated", entity_type="integration_config", entity_id=kind,
                 summary=f"{kind} integration set to {body.mode}", actor=ctx.user, merchant_id=ctx.merchant_id,
                 before=before, after={"mode": body.mode, "settings": body.settings})
    db.commit()
    return {"kind": kind, "mode": c.mode, "provider": c.provider, "settings": c.settings}
