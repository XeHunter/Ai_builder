"""Perishable stock management: expiry alerts, markdown recommendations, clearance and write-offs.

``evaluate_store`` is idempotent and runs on a schedule (job ``expiry_reevaluation``) or on demand.
For each sellable batch with an expiry date it:
1. computes hours to the sell-by limit (end of expiry day in store time minus SELL_BY buffer),
2. opens/escalates an expiry alert (warning / critical) with a dedupe key per batch+severity,
3. asks ``pricing_policy.compute_markdown`` for a markdown decision (heuristic, documented),
4. creates a RECOMMENDED price change (or a clearance-only staff task),
5. withdraws batches past their sell-by limit (status ``expired``, stock written off, staff task).
Expired stock is never offered for sale: catalog availability already excludes expired batches.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import (
    ExpiryAlert,
    InventoryBatch,
    InventoryItem,
    PriceChange,
    PricingRule,
    Product,
    ShelfLocation,
    Store,
    StoreTask,
    User,
)
from app.services import catalog_service, inventory_service, pricing_service
from app.services.notification_service import notify_merchant_staff
from app.services.pricing_policy import MarkdownInput, compute_markdown
from app.services.sales_stats import daily_velocity


def sell_by_deadline(expiry: date, store: Store, buffer_hours: int) -> datetime:
    tz = ZoneInfo(store.timezone or "UTC")
    end_of_day = datetime.combine(expiry, time(23, 59, 59), tzinfo=tz)
    return (end_of_day - timedelta(hours=buffer_hours)).astimezone(UTC)


def _rule_params(db: Session, store: Store) -> tuple[PricingRule | None, dict]:
    rule = db.scalars(
        select(PricingRule).where(PricingRule.merchant_id == store.merchant_id, PricingRule.rule_type == "expiry_markdown",
                                  PricingRule.is_active.is_(True),
                                  (PricingRule.store_id.is_(None)) | (PricingRule.store_id == store.id))
        .order_by(PricingRule.store_id.is_(None), PricingRule.priority)
    ).first()
    return rule, (rule.parameters if rule else {})


def _clearance_shelf(db: Session, store: Store, code: str | None) -> ShelfLocation | None:
    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        return None
    stmt = select(ShelfLocation).where(ShelfLocation.layout_id == layout.id)
    stmt = stmt.where(ShelfLocation.code == code) if code else stmt.where(ShelfLocation.is_clearance.is_(True))
    return db.scalars(stmt).first()


def evaluate_batch(db: Session, store: Store, batch: InventoryBatch, *, velocity: float, now: datetime,
                   actor: User | None = None) -> dict:
    settings = pricing_service.merchant_settings(db, store.merchant_id)
    product: Product = batch.product
    deadline = sell_by_deadline(batch.expiry_date, store, settings.sell_by_buffer_hours)
    hours_left = (deadline - now).total_seconds() / 3600
    outcome = {"batch_id": str(batch.id), "product": product.name, "hours_left": round(hours_left, 1),
               "quantity": batch.quantity_remaining, "actions": []}

    if hours_left <= 0:
        qty = batch.quantity_remaining
        if qty > 0:
            inventory_service.set_batch_quantity(db, batch, 0, reason="expiry_writeoff", actor=actor,
                                                 note="past sell-by limit")
        batch.status = "expired"
        batch.markdown_price = None
        _alert(db, store, batch, "expired", 0, qty,
               f"{product.name} batch {batch.batch_code} passed its sell-by limit; {qty} units withdrawn.")
        _task(db, store, "remove_expired", f"Remove expired {product.name}",
              f"Remove {qty} units of {product.name} (batch {batch.batch_code}) from the shelf and record waste.",
              batch, f"expired:{batch.id}")
        outcome["actions"].append("withdrawn")
        return outcome

    critical = hours_left <= settings.expiry_critical_hours
    warning = hours_left <= settings.expiry_warning_days * 24
    if not (critical or warning):
        return outcome
    severity = "critical" if critical else "warning"
    _alert(db, store, batch, severity, int(hours_left), batch.quantity_remaining,
           f"{batch.quantity_remaining} units of {product.name} (batch {batch.batch_code}) expire in "
           f"{hours_left:.0f} h.")
    outcome["severity"] = severity

    open_pc = db.scalars(select(PriceChange).where(PriceChange.batch_id == batch.id,
                                                   PriceChange.status.in_(pricing_service.OPEN_STATUSES))).first()
    if open_pc is not None:
        outcome["actions"].append(f"existing price change {open_pc.status}")
        return outcome

    rule, params = _rule_params(db, store)
    item = db.get(InventoryItem, batch.inventory_item_id)
    current = item.price_override if item and item.price_override is not None else product.price
    decision = compute_markdown(MarkdownInput(
        current_price=current, unit_cost=product.cost_price, min_allowed_price=product.min_allowed_price,
        quantity=batch.quantity_remaining, hours_left=hours_left, daily_velocity=velocity,
        max_markdown_pct=settings.max_markdown_pct, min_margin_pct=settings.min_margin_pct,
        elasticity=float(params.get("elasticity", 2.0)), tiers=params.get("tiers"),
    ))
    clearance = _clearance_shelf(db, store, settings.clearance_location_code)
    clearance_txt = None
    if decision.send_to_clearance:
        where = f"the clearance bin ({clearance.code})" if clearance else "the clearance area"
        clearance_txt = (f"Move {product.name} batch {batch.batch_code} ({batch.quantity_remaining} units) to {where} "
                         f"and keep the shelf-edge label in sync.")
    evidence = {
        "method": "heuristic_markdown_rule",
        "assumption": f"price elasticity {params.get('elasticity', 2.0)} (configurable; not a learned model)",
        "hours_to_sell_by": round(hours_left, 1),
        "sell_by_deadline": deadline.isoformat(),
        "remaining_units": batch.quantity_remaining,
        "daily_velocity_14d": round(velocity, 2),
        "expected_units_no_action": decision.expected_units_no_action,
        "expected_units_with_action": decision.expected_units_with_action,
        "expected_leftover_units": decision.expected_leftover_units,
        "tier_cap_pct": decision.cap_pct,
        "floor_price": float(decision.floor_price),
        "unit_cost": float(product.cost_price),
        "reasons": decision.reasons,
    }
    if decision.action == "markdown":
        pc = pricing_service.create_price_change(
            db, store=store, product=product, proposed_price=decision.proposed_price, source="expiry_markdown",
            reason=" ".join(decision.reasons), actor=actor, batch=batch, evidence=evidence,
            clearance_instruction=clearance_txt, rule_id=rule.id if rule else None,
            dedupe_key=f"expiry-md:{batch.id}:{decision.discount_pct}", effective_until=deadline,
            quantity_affected=batch.quantity_remaining)
        outcome["actions"].append(f"markdown {decision.discount_pct}% ({pc.status})")
        outcome["price_change_id"] = str(pc.id)
    elif decision.action == "clearance_only":
        _task(db, store, "move_to_clearance", f"Move {product.name} to clearance", clearance_txt or "", batch,
              f"clearance-only:{batch.id}")
        outcome["actions"].append("clearance task (markdown blocked by floor/caps)")
    else:
        outcome["actions"].append("no markdown needed")
    outcome["decision"] = {"action": decision.action, "discount_pct": decision.discount_pct, "reasons": decision.reasons}
    return outcome


def _alert(db: Session, store: Store, batch: InventoryBatch, severity: str, hours: int, qty: int, message: str) -> None:
    key = f"{batch.id}:{severity}"
    existing = db.scalars(select(ExpiryAlert).where(ExpiryAlert.dedupe_key == key)).first()
    if existing:
        existing.hours_to_expiry, existing.quantity_at_alert = hours, qty
        return
    for older in db.scalars(select(ExpiryAlert).where(ExpiryAlert.batch_id == batch.id, ExpiryAlert.status != "resolved")):
        older.status, older.resolved_at = "resolved", datetime.now(UTC)
    db.add(ExpiryAlert(merchant_id=store.merchant_id, store_id=store.id, batch_id=batch.id, product_id=batch.product_id,
                       severity=severity, hours_to_expiry=hours, quantity_at_alert=qty, message=message, dedupe_key=key))
    if severity in ("critical", "expired"):
        notify_merchant_staff(db, store.merchant_id, "expiry.manage", notification_type="expiry_alert",
                              title=f"{severity.title()} expiry: {batch.product.name}", body=message,
                              idempotency_key=f"expiry:{key}", link="/merchant/expiry")


def _task(db: Session, store: Store, task_type: str, title: str, instruction: str, batch: InventoryBatch, key: str) -> None:
    if db.scalars(select(StoreTask).where(StoreTask.dedupe_key == key)).first():
        return
    db.add(StoreTask(merchant_id=store.merchant_id, store_id=store.id, task_type=task_type, title=title,
                     instruction=instruction, related_entity_type="inventory_batch", related_entity_id=str(batch.id),
                     dedupe_key=key))


def evaluate_store(db: Session, store: Store, actor: User | None = None, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    settings = pricing_service.merchant_settings(db, store.merchant_id)
    horizon = (now + timedelta(days=max(settings.expiry_warning_days, 2) + 1)).date()
    batches = db.scalars(
        select(InventoryBatch).where(InventoryBatch.store_id == store.id, InventoryBatch.expiry_date.is_not(None),
                                     InventoryBatch.expiry_date <= horizon,
                                     InventoryBatch.status.in_(("active", "markdown", "clearance")),
                                     InventoryBatch.quantity_remaining > 0)
        .order_by(InventoryBatch.expiry_date)
    ).all()
    velocity = daily_velocity(db, store.id, list({b.product_id for b in batches}))
    # Batches of the same product sell first-expiry-first-out: a later batch only receives the demand
    # left after earlier batches are sold, so its effective velocity is reduced accordingly.
    ahead: dict = {}
    for b in db.scalars(select(InventoryBatch).where(
            InventoryBatch.store_id == store.id, InventoryBatch.product_id.in_({b.product_id for b in batches}),
            InventoryBatch.quantity_remaining > 0, InventoryBatch.status.in_(("active", "markdown", "clearance")))):
        if b.expiry_date is None:
            continue
        ahead.setdefault(b.product_id, []).append(b)
    results = []
    for b in batches:
        v = velocity.get(b.product_id, 0.0)
        earlier = sum(o.quantity_remaining for o in ahead.get(b.product_id, [])
                      if o.id != b.id and (o.expiry_date, o.received_at) < (b.expiry_date, b.received_at))
        days_left = max((sell_by_deadline(b.expiry_date, store, settings.sell_by_buffer_hours) - now).total_seconds() / 86400, 1e-6)
        effective = max(v * days_left - earlier, 0.0) / days_left
        results.append(evaluate_batch(db, store, b, velocity=effective, now=now, actor=actor))
    for alert in db.scalars(select(ExpiryAlert).where(ExpiryAlert.store_id == store.id, ExpiryAlert.status != "resolved")):
        b = alert.batch
        if b.quantity_remaining <= 0 and alert.severity != "expired":
            alert.status, alert.resolved_at = "resolved", now
    expired_pcs = pricing_service.expire_finished_markdowns(db, store.merchant_id)
    return {"store": store.code, "batches_evaluated": len(batches), "results": results,
            "price_changes_expired": expired_pcs}


def evaluate_merchant(db: Session, merchant_id: uuid.UUID, actor: User | None = None) -> dict:
    out = []
    for store in db.scalars(select(Store).where(Store.merchant_id == merchant_id, Store.is_active.is_(True))):
        out.append(evaluate_store(db, store, actor))
    db.commit()
    return {"stores": [{k: v for k, v in r.items() if k != "results"} for r in out],
            "batches_evaluated": sum(r["batches_evaluated"] for r in out)}


def acknowledge_alert(db: Session, merchant_id: uuid.UUID, alert_id: uuid.UUID, status: str) -> ExpiryAlert:
    alert = db.get(ExpiryAlert, alert_id)
    if alert is None or alert.merchant_id != merchant_id:
        raise NotFoundError("Alert not found")
    if status not in ("acknowledged", "resolved"):
        raise BusinessRuleError("Status must be acknowledged or resolved")
    alert.status = status
    if status == "resolved":
        alert.resolved_at = datetime.now(UTC)
    return alert
