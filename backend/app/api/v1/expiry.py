"""Expiry management: upcoming batches, alerts, evaluation runs and staff tasks."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_permission, resolve_store_ids
from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import ExpiryAlert, InventoryBatch, PriceChange, Store, StoreTask
from app.db.session import get_db
from app.services import expiry_service, pricing_service
from app.services.audit_service import record_audit
from app.services.sales_stats import daily_velocity
from app.tasks.queue import enqueue

router = APIRouter(prefix="/merchant/expiry", tags=["expiry"])


@router.get("/batches")
def upcoming_batches(store_id: uuid.UUID | None = None, days: int = Query(7, ge=0, le=60),
                     include_expired: bool = False,
                     ctx: MerchantContext = Depends(require_permission("inventory.read")),
                     db: Session = Depends(get_db)) -> list[dict]:
    """Batches expiring within ``days``, prioritised by urgency x remaining stock."""
    store_ids = resolve_store_ids(db, ctx, store_id)
    today = date.today()
    stmt = select(InventoryBatch).where(InventoryBatch.store_id.in_(store_ids), InventoryBatch.expiry_date.is_not(None),
                                        InventoryBatch.expiry_date <= today + timedelta(days=days))
    if include_expired:
        stmt = stmt.where(InventoryBatch.status.in_(("active", "markdown", "clearance", "expired")))
    else:
        stmt = stmt.where(InventoryBatch.status.in_(("active", "markdown", "clearance")), InventoryBatch.quantity_remaining > 0,
                          InventoryBatch.expiry_date >= today)
    batches = db.scalars(stmt).all()
    stores = {s.id: s for s in db.scalars(select(Store).where(Store.id.in_(store_ids)))}
    settings = pricing_service.merchant_settings(db, ctx.merchant_id)
    vel: dict = {}
    for sid in {b.store_id for b in batches}:
        vel[sid] = daily_velocity(db, sid, list({b.product_id for b in batches if b.store_id == sid}))
    open_pc = {pc.batch_id: pc for pc in db.scalars(select(PriceChange).where(
        PriceChange.batch_id.in_([b.id for b in batches]), PriceChange.status.in_(pricing_service.OPEN_STATUSES)))}
    out = []
    now = datetime.now(UTC)
    for b in batches:
        st = stores[b.store_id]
        hours = (expiry_service.sell_by_deadline(b.expiry_date, st, settings.sell_by_buffer_hours) - now).total_seconds() / 3600
        v = vel[b.store_id].get(b.product_id, 0.0)
        expected = v * max(hours, 0) / 24
        at_risk = max(b.quantity_remaining - expected, 0)
        pc = open_pc.get(b.id)
        out.append({
            "batch_id": str(b.id), "store_id": str(st.id), "store_code": st.code, "product_id": str(b.product_id),
            "product": b.product.name, "sku": b.product.sku, "batch_code": b.batch_code,
            "expiry_date": b.expiry_date.isoformat(), "hours_to_sell_by": round(hours, 1),
            "quantity_remaining": b.quantity_remaining, "daily_velocity": round(v, 2),
            "expected_sell_through": round(min(expected, b.quantity_remaining), 1), "units_at_risk": round(at_risk, 1),
            "value_at_risk": round(at_risk * float(b.product.cost_price), 2), "status": b.status,
            "markdown_price": float(b.markdown_price) if b.markdown_price is not None else None,
            "in_clearance": b.in_clearance,
            "price_change": {"id": str(pc.id), "status": pc.status, "discount_pct": pc.discount_pct,
                             "proposed_price": float(pc.proposed_price)} if pc else None,
            "priority": round((at_risk * float(b.product.cost_price)) / max(hours, 1), 2),
        })
    out.sort(key=lambda r: (-r["priority"], r["hours_to_sell_by"]))
    return out


@router.post("/evaluate", status_code=status.HTTP_202_ACCEPTED)
def evaluate(store_id: uuid.UUID | None = None, ctx: MerchantContext = Depends(require_permission("expiry.manage")),
             db: Session = Depends(get_db)) -> dict:
    """Re-evaluate expiry exposure now. With a store id it runs synchronously and returns details."""
    if store_id:
        store = get_store_scoped(db, ctx, store_id)
        res = expiry_service.evaluate_store(db, store, ctx.user)
        record_audit(db, action="expiry.evaluated", entity_type="store", entity_id=store.id,
                     summary=f"Expiry evaluation: {res['batches_evaluated']} batches", actor=ctx.user,
                     merchant_id=ctx.merchant_id)
        db.commit()
        return res
    job = enqueue(db, "expiry_reevaluation", {}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id)
    return {"job_id": str(job.id), "status": job.status}


@router.get("/alerts")
def alerts(store_id: uuid.UUID | None = None, status_filter: str | None = Query(None, alias="status"),
           ctx: MerchantContext = Depends(require_permission("inventory.read")), db: Session = Depends(get_db)) -> list[dict]:
    store_ids = resolve_store_ids(db, ctx, store_id)
    stmt = select(ExpiryAlert).where(ExpiryAlert.store_id.in_(store_ids))
    if status_filter:
        stmt = stmt.where(ExpiryAlert.status == status_filter)
    rows = db.scalars(stmt.order_by(ExpiryAlert.created_at.desc()).limit(200)).all()
    return [{"id": str(a.id), "store_id": str(a.store_id), "batch_id": str(a.batch_id), "product": a.product.name,
             "batch_code": a.batch.batch_code, "severity": a.severity, "hours_to_expiry": a.hours_to_expiry,
             "quantity_at_alert": a.quantity_at_alert, "status": a.status, "message": a.message,
             "created_at": a.created_at.isoformat()} for a in rows]


class AlertUpdate(BaseModel):
    status: str = Field(pattern="^(acknowledged|resolved)$")


@router.patch("/alerts/{alert_id}")
def update_alert(alert_id: uuid.UUID, body: AlertUpdate, ctx: MerchantContext = Depends(require_permission("expiry.manage")),
                 db: Session = Depends(get_db)) -> dict:
    a = expiry_service.acknowledge_alert(db, ctx.merchant_id, alert_id, body.status)
    get_store_scoped(db, ctx, a.store_id)
    record_audit(db, action=f"expiry.alert.{body.status}", entity_type="expiry_alert", entity_id=a.id,
                 summary=a.message, actor=ctx.user, merchant_id=ctx.merchant_id)
    db.commit()
    return {"id": str(a.id), "status": a.status}


@router.get("/tasks")
def store_tasks(store_id: uuid.UUID | None = None, status_filter: str = Query("open", alias="status"),
                ctx: MerchantContext = Depends(require_permission("inventory.read")), db: Session = Depends(get_db)) -> list[dict]:
    store_ids = resolve_store_ids(db, ctx, store_id)
    rows = db.scalars(select(StoreTask).where(StoreTask.store_id.in_(store_ids), StoreTask.status == status_filter)
                      .order_by(StoreTask.created_at.desc()).limit(200)).all()
    return [{"id": str(t.id), "store_id": str(t.store_id), "task_type": t.task_type, "title": t.title,
             "instruction": t.instruction, "status": t.status, "related_entity_type": t.related_entity_type,
             "related_entity_id": t.related_entity_id, "created_at": t.created_at.isoformat(),
             "completed_at": t.completed_at.isoformat() if t.completed_at else None} for t in rows]


@router.post("/tasks/{task_id}/complete")
def complete_task(task_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("inventory.write")),
                  db: Session = Depends(get_db)) -> dict:
    t = db.get(StoreTask, task_id)
    if t is None or t.merchant_id != ctx.merchant_id:
        raise NotFoundError("Task not found")
    get_store_scoped(db, ctx, t.store_id)
    if t.status != "open":
        raise BusinessRuleError(f"Task is already {t.status}")
    t.status, t.completed_by_id, t.completed_at = "done", ctx.user.id, datetime.now(UTC)
    record_audit(db, action="store_task.completed", entity_type="store_task", entity_id=t.id, summary=t.title,
                 actor=ctx.user, merchant_id=ctx.merchant_id)
    db.commit()
    return {"id": str(t.id), "status": t.status}
