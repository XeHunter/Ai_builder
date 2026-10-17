"""Fraud monitoring: review queue, investigations, rules, evaluation and simulated transaction ingestion."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, page_params, require_permission
from app.core.exceptions import NotFoundError, ValidationFailedError
from app.db.models import FraudAlert, FraudRule, Product, SalesTransaction, TransactionItem, User
from app.db.session import get_db
from app.schemas.common import Page, PageParams
from app.services import fraud_service
from app.services.audit_service import record_audit
from app.tasks.queue import enqueue

router = APIRouter(prefix="/merchant/fraud", tags=["fraud"])


def _alert_out(db: Session, a: FraudAlert, detail: bool = False) -> dict:
    out = {"id": str(a.id), "store_id": str(a.store_id) if a.store_id else None, "subject_type": a.subject_type,
           "subject_ref": a.subject_ref, "transaction_id": str(a.transaction_id) if a.transaction_id else None,
           "rule_score": a.rule_score, "anomaly_score": a.anomaly_score, "risk_score": a.risk_score,
           "risk_level": a.risk_level, "signals": a.signals, "summary": a.summary, "status": a.status,
           "outcome": a.outcome, "detected_at": a.detected_at.isoformat()}
    if detail:
        if a.transaction_id:
            t = db.get(SalesTransaction, a.transaction_id)
            orig = db.get(SalesTransaction, t.original_transaction_id) if t.original_transaction_id else None
            names = dict(db.execute(select(Product.id, Product.name).where(
                Product.id.in_({i.product_id for i in t.items} | ({i.product_id for i in orig.items} if orig else set())))).all())

            def tx(x: SalesTransaction) -> dict:
                return {"id": str(x.id), "receipt_number": x.receipt_number, "type": x.transaction_type, "channel": x.channel,
                        "occurred_at": x.occurred_at.isoformat(), "total": float(x.total), "terminal_id": x.terminal_id,
                        "is_simulated": x.is_simulated,
                        "items": [{"product": names.get(i.product_id), "quantity": i.quantity,
                                   "detected_quantity": i.detected_quantity, "unit_price": float(i.unit_price),
                                   "line_total": float(i.line_total)} for i in x.items]}

            out["transaction"] = tx(t)
            out["original_transaction"] = tx(orig) if orig else None
            if t.customer_id:
                hist = db.execute(select(SalesTransaction.transaction_type, func.count(), func.sum(SalesTransaction.total))
                                  .where(SalesTransaction.customer_id == t.customer_id)
                                  .group_by(SalesTransaction.transaction_type)).all()
                out["customer_history"] = {k: {"count": int(c), "value": float(v or 0)} for k, c, v in hist}
                out["customer_ref"] = f"customer-{str(t.customer_id)[:8]}"
        inv = a.investigation
        out["investigation"] = None if inv is None else {
            "id": str(inv.id), "status": inv.status, "outcome": inv.outcome,
            "closed_at": inv.closed_at.isoformat() if inv.closed_at else None,
            "notes": [{"author": n.author.full_name if n.author else "system", "note": n.note,
                       "created_at": n.created_at.isoformat()} for n in inv.notes]}
        out["guidance"] = ("Scores prioritise human review. Do not accuse the customer or refuse service based on "
                           "this score alone; verify receipts, CCTV policy and staff accounts per store procedure.")
    return out


@router.get("/alerts", response_model=Page[dict])
def list_alerts(status_filter: str | None = Query(None, alias="status"), risk_level: str | None = None,
                store_id: uuid.UUID | None = None,
                subject_type: str | None = None, pp: PageParams = Depends(page_params),
                ctx: MerchantContext = Depends(require_permission("fraud.read")), db: Session = Depends(get_db)) -> dict:
    stmt = select(FraudAlert).where(FraudAlert.merchant_id == ctx.merchant_id)
    if status_filter:
        stmt = stmt.where(FraudAlert.status.in_(status_filter.split(",")))
    if risk_level:
        stmt = stmt.where(FraudAlert.risk_level == risk_level)
    if subject_type:
        stmt = stmt.where(FraudAlert.subject_type == subject_type)
    if store_id:
        get_store_scoped(db, ctx, store_id)
        stmt = stmt.where(FraudAlert.store_id == store_id)
    rows = [a for a in db.scalars(stmt.order_by(FraudAlert.risk_score.desc(), FraudAlert.detected_at.desc()))
            if a.store_id is None or ctx.can_access_store(a.store_id)]
    return {"items": [_alert_out(db, a) for a in rows[pp.offset : pp.offset + pp.page_size]], "total": len(rows),
            "page": pp.page, "page_size": pp.page_size}


def _alert(db: Session, ctx: MerchantContext, alert_id: uuid.UUID) -> FraudAlert:
    a = fraud_service.get_alert(db, ctx.merchant_id, alert_id)
    if a.store_id:
        get_store_scoped(db, ctx, a.store_id)
    return a


@router.get("/alerts/{alert_id}")
def get_alert(alert_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("fraud.read")),
              db: Session = Depends(get_db)) -> dict:
    return _alert_out(db, _alert(db, ctx, alert_id), detail=True)


class NoteBody(BaseModel):
    note: str = Field(min_length=2, max_length=2000)


@router.post("/alerts/{alert_id}/investigation")
def start_investigation(alert_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
                        db: Session = Depends(get_db)) -> dict:
    a = _alert(db, ctx, alert_id)
    fraud_service.open_investigation(db, a, ctx.user)
    db.commit()
    return _alert_out(db, a, detail=True)


@router.post("/alerts/{alert_id}/notes")
def add_note(alert_id: uuid.UUID, body: NoteBody, ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
             db: Session = Depends(get_db)) -> dict:
    a = _alert(db, ctx, alert_id)
    fraud_service.add_note(db, a, ctx.user, body.note)
    db.commit()
    db.refresh(a)
    return _alert_out(db, a, detail=True)


class CloseBody(BaseModel):
    outcome: str = Field(pattern="^(confirmed_fraud|false_positive|inconclusive)$")
    note: str = Field(min_length=5, max_length=2000)


@router.post("/alerts/{alert_id}/close")
def close_alert(alert_id: uuid.UUID, body: CloseBody, ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
                db: Session = Depends(get_db)) -> dict:
    a = _alert(db, ctx, alert_id)
    fraud_service.close(db, a, ctx.user, body.outcome, body.note)
    db.commit()
    db.refresh(a)
    return _alert_out(db, a, detail=True)


@router.post("/alerts/{alert_id}/escalate")
def escalate(alert_id: uuid.UUID, body: NoteBody, ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
             db: Session = Depends(get_db)) -> dict:
    a = _alert(db, ctx, alert_id)
    fraud_service.escalate(db, a, ctx.user, body.note)
    db.commit()
    db.refresh(a)
    return _alert_out(db, a, detail=True)


@router.post("/scan", status_code=status.HTTP_202_ACCEPTED)
def scan(days: int = Query(30, ge=1, le=365), ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
         db: Session = Depends(get_db)) -> dict:
    job = enqueue(db, "fraud_scan", {"days": days}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id, max_attempts=1)
    return {"job_id": str(job.id), "status": job.status, "result": job.result}


@router.get("/evaluation")
def evaluation(ctx: MerchantContext = Depends(require_permission("fraud.read")), db: Session = Depends(get_db)) -> dict:
    return fraud_service.evaluate(db, ctx.merchant_id)


@router.get("/rules")
def rules(ctx: MerchantContext = Depends(require_permission("fraud.read")), db: Session = Depends(get_db)) -> list[dict]:
    fraud_service.ensure_rules(db, ctx.merchant_id)
    db.commit()
    return [{"id": str(r.id), "code": r.code, "name": r.name, "description": r.description, "weight": r.weight,
             "params": r.params, "is_active": r.is_active}
            for r in db.scalars(select(FraudRule).where(FraudRule.merchant_id == ctx.merchant_id).order_by(FraudRule.code))]


class RuleUpdate(BaseModel):
    weight: int | None = Field(default=None, ge=0, le=100)
    params: dict | None = None
    is_active: bool | None = None


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: uuid.UUID, body: RuleUpdate, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                db: Session = Depends(get_db)) -> dict:
    r = db.get(FraudRule, rule_id)
    if r is None or r.merchant_id != ctx.merchant_id:
        raise NotFoundError("Rule not found")
    changes = body.model_dump(exclude_unset=True)
    if "params" in changes:
        for k, v in changes["params"].items():
            if not isinstance(v, (int, float)) or v < 0:
                raise ValidationFailedError(f"Parameter {k} must be a non-negative number")
    before = {"weight": r.weight, "params": r.params, "is_active": r.is_active}
    for k, v in changes.items():
        setattr(r, k, v)
    record_audit(db, action="fraud.rule.updated", entity_type="fraud_rule", entity_id=r.id, summary=r.name,
                 actor=ctx.user, merchant_id=ctx.merchant_id, before=before, after=changes)
    db.commit()
    return {"id": str(r.id), "code": r.code, "weight": r.weight, "params": r.params, "is_active": r.is_active}


class TxnItemIn(BaseModel):
    product_id: uuid.UUID
    quantity: int = Field(ge=1, le=1000)
    detected_quantity: int | None = Field(default=None, ge=0, le=1000)
    unit_price: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)


class TxnIn(BaseModel):
    store_id: uuid.UUID
    channel: str = Field(pattern="^(pos|self_checkout|online)$")
    transaction_type: str = Field(pattern="^(sale|return)$")
    customer_id: uuid.UUID | None = None
    original_receipt_number: str | None = Field(default=None, max_length=40)
    terminal_id: str | None = Field(default=None, max_length=32)
    items: list[TxnItemIn] = Field(min_length=1, max_length=100)


@router.post("/transactions", status_code=status.HTTP_201_CREATED)
def ingest_transaction(body: TxnIn, ctx: MerchantContext = Depends(require_permission("fraud.investigate")),
                       db: Session = Depends(get_db)) -> dict:
    """Simulated POS/self-checkout/e-commerce ingestion: records the transaction and scores it immediately.

    Inventory is not decremented by simulated ingestion (it is a fraud-signal test harness)."""
    store = get_store_scoped(db, ctx, body.store_id)
    if body.customer_id:
        cu = db.get(User, body.customer_id)
        if cu is None or cu.account_type != "customer":
            raise NotFoundError("Customer not found")
    original = None
    if body.original_receipt_number:
        original = db.scalars(select(SalesTransaction).where(SalesTransaction.merchant_id == ctx.merchant_id,
                                                             SalesTransaction.receipt_number == body.original_receipt_number,
                                                             SalesTransaction.transaction_type == "sale")).first()
        if original is None:
            raise NotFoundError("Original receipt not found")
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_([i.product_id for i in body.items]),
                                                                  Product.merchant_id == ctx.merchant_id))}
    if len(products) != len({i.product_id for i in body.items}):
        raise NotFoundError("One or more products were not found")
    t = SalesTransaction(merchant_id=ctx.merchant_id, store_id=store.id, customer_id=body.customer_id, channel=body.channel,
                         transaction_type=body.transaction_type,
                         receipt_number=original.receipt_number if original else f"SIM-{secrets.token_hex(4).upper()}",
                         original_transaction_id=original.id if original else None, occurred_at=datetime.now(UTC),
                         subtotal=Decimal(0), total=Decimal(0), terminal_id=body.terminal_id, is_simulated=True)
    db.add(t)
    db.flush()
    total = Decimal(0)
    for i in body.items:
        price = i.unit_price or products[i.product_id].price
        line = price * i.quantity
        total += line
        db.add(TransactionItem(transaction_id=t.id, product_id=i.product_id, quantity=i.quantity,
                               detected_quantity=i.detected_quantity, unit_price=price, line_total=line))
    t.subtotal = t.total = total
    t.item_count = sum(i.quantity for i in body.items)
    record_audit(db, action="fraud.transaction.ingested", entity_type="sales_transaction", entity_id=t.id,
                 summary=f"Simulated {t.transaction_type} {t.receipt_number} ₹{total}", actor=ctx.user,
                 merchant_id=ctx.merchant_id)
    db.commit()
    res = fraud_service.scan(db, ctx.merchant_id, days=30)  # anomaly scores need the 30-day context
    alert = db.scalars(select(FraudAlert).where(FraudAlert.transaction_id == t.id)).first()
    return {"transaction_id": str(t.id), "receipt_number": t.receipt_number, "scan": res,
            "alert": _alert_out(db, alert) if alert else None}
