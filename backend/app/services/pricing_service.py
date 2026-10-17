"""Price-change workflow, promotions and coupons.

State machine for ``price_changes``::

    RECOMMENDED -> PENDING_APPROVAL -> APPROVED -> PUBLISHED -> EXPIRED
         |               |               |  \\-> FAILED -> APPROVED (retry)
         +-> REJECTED / CANCELLED / EXPIRED (from any non-terminal state)

Recommendation generation (expiry_service, weather rules) is separate from publication: nothing
reaches customers until a change is PUBLISHED via the price publisher adapter. Auto-publication
happens only when the merchant explicitly enabled ``auto_publish_markdowns`` and the discount is
within ``auto_publish_max_pct``. Guardrails are re-validated at approval and at publication.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, lazyload

from app.core.exceptions import BusinessRuleError, ConflictError, NotFoundError, ValidationFailedError
from app.db.models import (
    Coupon,
    CouponRedemption,
    IntegrationConfig,
    InventoryBatch,
    InventoryItem,
    MerchantSettings,
    PriceChange,
    PriceChangeEvent,
    Product,
    Promotion,
    PromotionProduct,
    SalesTransaction,
    Store,
    StoreTask,
    TransactionItem,
    User,
)
from app.integrations.pos.pricing_publisher import SimulatedPricePublisher
from app.services import catalog_service
from app.services.audit_service import record_audit
from app.services.notification_service import notify_merchant_staff
from app.services.pricing_policy import margin_pct, price_floor, promotion_price, validate_price

TRANSITIONS: dict[str, set[str]] = {
    "RECOMMENDED": {"PENDING_APPROVAL", "REJECTED", "CANCELLED", "EXPIRED"},
    "PENDING_APPROVAL": {"APPROVED", "REJECTED", "CANCELLED", "EXPIRED"},
    "APPROVED": {"PUBLISHED", "FAILED", "CANCELLED", "EXPIRED"},
    "FAILED": {"APPROVED", "CANCELLED", "EXPIRED"},
    "PUBLISHED": {"EXPIRED"},
    "REJECTED": set(),
    "CANCELLED": set(),
    "EXPIRED": set(),
}
OPEN_STATUSES = ("RECOMMENDED", "PENDING_APPROVAL", "APPROVED", "FAILED", "PUBLISHED")


def merchant_settings(db: Session, merchant_id: uuid.UUID) -> MerchantSettings:
    s = db.get(MerchantSettings, merchant_id)
    if s is None:
        s = MerchantSettings(merchant_id=merchant_id)
        db.add(s)
        db.flush()
    return s


def _transition(db: Session, pc: PriceChange, to: str, actor: User | None, note: str | None = None) -> None:
    if to not in TRANSITIONS[pc.status]:
        raise BusinessRuleError(f"Cannot move a price change from {pc.status} to {to}")
    pc.events.append(PriceChangeEvent(from_status=pc.status, to_status=to, actor_id=actor.id if actor else None,
                                      note=note))
    before = pc.status
    pc.status = to
    record_audit(db, action=f"pricing.price_change.{to.lower()}", entity_type="price_change", entity_id=pc.id,
                 summary=f"{pc.product.name}: {before} -> {to}" + (f" ({note})" if note else ""), actor=actor,
                 merchant_id=pc.merchant_id, before={"status": before},
                 after={"status": to, "proposed_price": str(pc.proposed_price), "discount_pct": pc.discount_pct})


def get_price_change(db: Session, merchant_id: uuid.UUID, pc_id: uuid.UUID) -> PriceChange:
    pc = db.get(PriceChange, pc_id)
    if pc is None or pc.merchant_id != merchant_id:
        raise NotFoundError("Price change not found")
    return pc


def _guardrail_check(db: Session, pc: PriceChange) -> list[str]:
    settings = merchant_settings(db, pc.merchant_id)
    product = pc.product
    floor = price_floor(product.cost_price, product.min_allowed_price, settings.min_margin_pct)
    problems = validate_price(pc.proposed_price, pc.current_price, floor, settings.max_markdown_pct)
    if pc.proposed_price > pc.current_price and pc.source != "manual":
        problems.append("Automated recommendations may not increase prices.")
    if pc.batch_id:
        batch = db.get(InventoryBatch, pc.batch_id)
        today = datetime.now(UTC).date()
        if batch is None or batch.quantity_remaining <= 0:
            problems.append("The batch has no remaining stock.")
        elif batch.expiry_date is not None and batch.expiry_date < today:
            problems.append("The batch is past its expiry date and cannot be sold.")
        elif batch.status in ("expired", "withdrawn"):
            problems.append(f"The batch is {batch.status}.")
    return problems


def create_price_change(db: Session, *, store: Store, product: Product, proposed_price: Decimal, source: str,
                        reason: str, actor: User | None, batch: InventoryBatch | None = None,
                        evidence: dict | None = None, clearance_instruction: str | None = None,
                        rule_id: uuid.UUID | None = None, dedupe_key: str | None = None,
                        effective_until: datetime | None = None, quantity_affected: int = 0) -> PriceChange:
    settings = merchant_settings(db, store.merchant_id)
    item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store.id,
                                                  InventoryItem.product_id == product.id)).first()
    current = item.price_override if item and item.price_override is not None else product.price
    floor = price_floor(product.cost_price, product.min_allowed_price, settings.min_margin_pct)
    problems = validate_price(proposed_price, current, floor, settings.max_markdown_pct)
    if problems:
        raise BusinessRuleError("Price change violates pricing guardrails", details={"violations": problems})
    discount = float(round((current - proposed_price) / current * 100, 2)) if current else 0.0
    pc = PriceChange(merchant_id=store.merchant_id, store_id=store.id, product_id=product.id,
                     batch_id=batch.id if batch else None, rule_id=rule_id, source=source, status="RECOMMENDED",
                     current_price=current, proposed_price=proposed_price, discount_pct=discount, floor_price=floor,
                     unit_cost=product.cost_price, projected_margin_pct=margin_pct(proposed_price, product.cost_price),
                     quantity_affected=quantity_affected or (batch.quantity_remaining if batch else 0),
                     reason=reason, evidence=evidence or {}, clearance_instruction=clearance_instruction,
                     requested_by_id=actor.id if actor else None, dedupe_key=dedupe_key,
                     effective_until=effective_until)
    pc.product = product
    db.add(pc)
    db.flush()
    pc.events.append(PriceChangeEvent(from_status=None, to_status="RECOMMENDED", actor_id=actor.id if actor else None,
                                      note="created"))
    record_audit(db, action="pricing.price_change.recommended", entity_type="price_change", entity_id=pc.id,
                 summary=f"{product.name} @ {store.code}: ₹{current} -> ₹{proposed_price} ({source})", actor=actor,
                 merchant_id=store.merchant_id, after={"proposed_price": str(proposed_price), "discount_pct": discount})
    if (source == "expiry_markdown" and settings.auto_publish_markdowns and discount <= settings.auto_publish_max_pct):
        _transition(db, pc, "PENDING_APPROVAL", None, "auto-policy")
        _transition(db, pc, "APPROVED", None, f"auto-approved by policy (≤{settings.auto_publish_max_pct}%)")
        pc.approved_at = datetime.now(UTC)
        publish(db, pc, None)
    else:
        notify_merchant_staff(db, store.merchant_id, "pricing.approve", notification_type="pricing_approval",
                              title=f"Price recommendation: {product.name}",
                              body=f"{discount:.0f}% markdown proposed at {store.name} ({reason[:120]})",
                              idempotency_key=f"pc-created:{pc.id}", link=f"/merchant/pricing?change={pc.id}")
    return pc


def submit_for_approval(db: Session, pc: PriceChange, actor: User, note: str | None = None) -> PriceChange:
    _transition(db, pc, "PENDING_APPROVAL", actor, note)
    return pc


def approve(db: Session, pc: PriceChange, actor: User, note: str | None = None, publish_now: bool = True) -> PriceChange:
    if pc.status == "RECOMMENDED":
        _transition(db, pc, "PENDING_APPROVAL", actor, "submitted on approval")
    problems = _guardrail_check(db, pc)
    if problems:
        raise BusinessRuleError("Cannot approve: guardrail check failed", details={"violations": problems})
    _transition(db, pc, "APPROVED", actor, note)
    pc.approved_by_id, pc.approved_at = actor.id, datetime.now(UTC)
    if publish_now:
        publish(db, pc, actor)
    return pc


def reject(db: Session, pc: PriceChange, actor: User, note: str | None) -> PriceChange:
    _transition(db, pc, "REJECTED", actor, note)
    return pc


def cancel(db: Session, pc: PriceChange, actor: User, note: str | None) -> PriceChange:
    if pc.status == "PUBLISHED":
        raise BusinessRuleError("A published price change cannot be cancelled; it ends when the batch expires or sells out")
    _transition(db, pc, "CANCELLED", actor, note)
    return pc


def _publisher_for(db: Session, merchant_id: uuid.UUID) -> SimulatedPricePublisher:
    cfg = db.scalars(select(IntegrationConfig).where(IntegrationConfig.merchant_id == merchant_id,
                                                     IntegrationConfig.kind == "pricing_publisher")).first()
    return SimulatedPricePublisher(mode=cfg.mode if cfg else "simulated", settings=cfg.settings if cfg else {})


def publish(db: Session, pc: PriceChange, actor: User | None) -> PriceChange:
    if pc.status == "FAILED":
        _transition(db, pc, "APPROVED", actor, "retry publication")
    if pc.status != "APPROVED":
        raise BusinessRuleError(f"Only approved price changes can be published (status is {pc.status})")
    problems = _guardrail_check(db, pc)
    if problems:
        pc.failure_reason = "; ".join(problems)
        _transition(db, pc, "FAILED", actor, pc.failure_reason)
        return pc
    store = db.get(Store, pc.store_id)
    batch = db.get(InventoryBatch, pc.batch_id) if pc.batch_id else None
    result = _publisher_for(db, pc.merchant_id).publish(
        store_code=store.code, sku=pc.product.sku, batch_code=batch.batch_code if batch else None,
        price=pc.proposed_price, change_id=str(pc.id))
    if not result.ok:
        pc.failure_reason = result.error
        _transition(db, pc, "FAILED", actor, result.error)
        return pc
    pc.publish_reference, pc.published_at, pc.failure_reason = result.reference, datetime.now(UTC), None
    pc.effective_from = pc.published_at
    if batch is not None:
        batch.markdown_price = pc.proposed_price
        batch.markdown_pct = int(round(pc.discount_pct))
        batch.status = "markdown"
        if pc.clearance_instruction:
            batch.in_clearance = True
            batch.status = "clearance"
    else:
        item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == pc.store_id,
                                                      InventoryItem.product_id == pc.product_id)).first()
        if item is not None:
            item.price_override = pc.proposed_price
    _transition(db, pc, "PUBLISHED", actor, f"published via simulated price publisher ({result.reference})")
    label = f"batch {batch.batch_code}" if batch else "all units"
    _task(db, store, "relabel_price", f"Relabel {pc.product.name} ({label})",
          f"Apply new price ₹{pc.proposed_price} to {pc.product.name} — {label}. Reference {result.reference}.",
          pc, f"relabel:{pc.id}")
    if pc.clearance_instruction:
        _task(db, store, "move_to_clearance", f"Move {pc.product.name} to clearance", pc.clearance_instruction, pc,
              f"clearance:{pc.id}")
    return pc


def _task(db: Session, store: Store, task_type: str, title: str, instruction: str, pc: PriceChange, key: str) -> None:
    if db.scalars(select(StoreTask).where(StoreTask.dedupe_key == key)).first():
        return
    db.add(StoreTask(merchant_id=store.merchant_id, store_id=store.id, task_type=task_type, title=title,
                     instruction=instruction, related_entity_type="price_change", related_entity_id=str(pc.id),
                     dedupe_key=key))


def expire_finished_markdowns(db: Session, merchant_id: uuid.UUID) -> int:
    """PUBLISHED batch markdowns end when the batch sells out or expires."""
    today = datetime.now(UTC).date()
    n = 0
    for pc in db.scalars(select(PriceChange).where(PriceChange.merchant_id == merchant_id,
                                                   PriceChange.status.in_(("RECOMMENDED", "PENDING_APPROVAL", "APPROVED", "PUBLISHED")),
                                                   PriceChange.batch_id.is_not(None))):
        batch = db.get(InventoryBatch, pc.batch_id)
        if batch is None or batch.quantity_remaining <= 0 or (batch.expiry_date and batch.expiry_date < today):
            _transition(db, pc, "EXPIRED", None, "batch sold out or expired")
            n += 1
    return n


# ---------------------------------------------------------------------------
# Promotions
# ---------------------------------------------------------------------------

PROMO_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"pending_approval", "cancelled"},
    "pending_approval": {"scheduled", "active", "rejected", "cancelled"},
    "scheduled": {"active", "cancelled", "paused"},
    "active": {"paused", "ended"},
    "paused": {"active", "ended", "cancelled"},
    "ended": set(), "rejected": set(), "cancelled": set(),
}


def _promo_transition(db: Session, promo: Promotion, to: str, actor: User | None, note: str | None = None) -> None:
    if to not in PROMO_TRANSITIONS[promo.status]:
        raise BusinessRuleError(f"Cannot move a promotion from {promo.status} to {to}")
    before = promo.status
    promo.status = to
    record_audit(db, action=f"pricing.promotion.{to}", entity_type="promotion", entity_id=promo.id,
                 summary=f"Promotion '{promo.name}': {before} -> {to}" + (f" ({note})" if note else ""),
                 actor=actor, merchant_id=promo.merchant_id, before={"status": before}, after={"status": to})


def validate_promotion(db: Session, merchant_id: uuid.UUID, store_id: uuid.UUID | None, products: list[Product],
                       promo_type: str, value: Decimal) -> list[dict]:
    settings = merchant_settings(db, merchant_id)
    issues = []
    since = datetime.now(UTC) - timedelta(days=30)
    for p in products:
        regular = p.price
        if store_id:
            item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store_id,
                                                          InventoryItem.product_id == p.id)).first()
            if item and item.price_override is not None:
                regular = item.price_override
        problems = []
        if not p.promotion_eligible:
            problems.append("Product is not promotion-eligible.")
        new = promotion_price(regular, promo_type, value)
        floor = price_floor(p.cost_price, p.min_allowed_price, settings.min_margin_pct)
        problems += validate_price(new, regular, floor, settings.max_markdown_pct)
        raised = db.scalar(select(func.count(PriceChange.id)).where(
            PriceChange.product_id == p.id, PriceChange.status == "PUBLISHED", PriceChange.published_at >= since,
            PriceChange.proposed_price > PriceChange.current_price))
        if raised:
            problems.append("Regular price was raised within the last 30 days; a discount from it could mislead customers.")
        if problems:
            issues.append({"product_id": str(p.id), "sku": p.sku, "name": p.name, "promo_price": float(new),
                           "floor_price": float(floor), "problems": problems})
    return issues


def create_promotion(db: Session, *, merchant_id: uuid.UUID, actor: User | None, name: str, description: str,
                     store_id: uuid.UUID | None, product_ids: list[uuid.UUID], promo_type: str, discount_value: Decimal,
                     starts_at: datetime, ends_at: datetime, usage_limit: int | None, per_customer_limit: int,
                     geofence_radius_m: int | None, trigger: str = "manual", is_simulation: bool = False,
                     evidence: dict | None = None) -> Promotion:
    if ends_at <= starts_at:
        raise ValidationFailedError("ends_at must be after starts_at")
    if promo_type == "percent_off" and not (Decimal(0) < discount_value < Decimal(100)):
        raise ValidationFailedError("Percentage discount must be between 0 and 100")
    if promo_type == "amount_off" and discount_value <= 0:
        raise ValidationFailedError("Amount discount must be positive")
    products = db.scalars(select(Product).where(Product.id.in_(product_ids), Product.merchant_id == merchant_id)).all()
    if len(products) != len(set(product_ids)):
        raise NotFoundError("One or more products were not found")
    issues = validate_promotion(db, merchant_id, store_id, list(products), promo_type, discount_value)
    if issues:
        raise BusinessRuleError("Promotion violates pricing guardrails", details={"products": issues})
    promo = Promotion(merchant_id=merchant_id, store_id=store_id, name=name, description=description,
                      promo_type=promo_type, discount_value=discount_value, status="draft", trigger=trigger,
                      starts_at=starts_at, ends_at=ends_at, usage_limit=usage_limit,
                      per_customer_limit=per_customer_limit, geofence_radius_m=geofence_radius_m,
                      is_simulation=is_simulation, evidence=evidence or {}, created_by_id=actor.id if actor else None)
    promo.products = [PromotionProduct(product_id=p.id) for p in products]
    db.add(promo)
    db.flush()
    record_audit(db, action="pricing.promotion.created", entity_type="promotion", entity_id=promo.id,
                 summary=f"Promotion '{name}' drafted for {len(products)} products", actor=actor, merchant_id=merchant_id)
    return promo


def submit_promotion(db: Session, promo: Promotion, actor: User) -> Promotion:
    _promo_transition(db, promo, "pending_approval", actor)
    notify_merchant_staff(db, promo.merchant_id, "pricing.approve", notification_type="pricing_approval",
                          title=f"Promotion awaiting approval: {promo.name}", body=promo.description or promo.name,
                          idempotency_key=f"promo-submitted:{promo.id}", link=f"/merchant/pricing?promotion={promo.id}")
    return promo


def approve_promotion(db: Session, promo: Promotion, actor: User) -> Promotion:
    if promo.is_simulation:
        raise BusinessRuleError("Simulation promotions cannot be approved; create a real promotion from it")
    products = [pp.product for pp in promo.products]
    issues = validate_promotion(db, promo.merchant_id, promo.store_id, products, promo.promo_type, promo.discount_value)
    if issues:
        raise BusinessRuleError("Promotion no longer passes guardrails", details={"products": issues})
    now = datetime.now(UTC)
    if promo.ends_at <= now:
        raise BusinessRuleError("Promotion window has already ended")
    _promo_transition(db, promo, "active" if promo.starts_at <= now else "scheduled", actor)
    promo.approved_by_id, promo.approved_at = actor.id, now
    catalog_service.invalidate_index(promo.merchant_id)
    return promo


def set_promotion_status(db: Session, promo: Promotion, to: str, actor: User) -> Promotion:
    _promo_transition(db, promo, to, actor)
    return promo


def promotion_lifecycle(db: Session, merchant_id: uuid.UUID) -> dict:
    now = datetime.now(UTC)
    started = ended = 0
    for p in db.scalars(select(Promotion).where(Promotion.merchant_id == merchant_id, Promotion.status == "scheduled",
                                                Promotion.starts_at <= now)):
        _promo_transition(db, p, "active", None, "start time reached")
        started += 1
    for p in db.scalars(select(Promotion).where(Promotion.merchant_id == merchant_id,
                                                Promotion.status.in_(("active", "paused")), Promotion.ends_at <= now)):
        _promo_transition(db, p, "ended", None, "end time reached")
        ended += 1
    for c in db.scalars(select(Coupon).where(Coupon.merchant_id == merchant_id, Coupon.status == "issued",
                                             Coupon.expires_at <= now)):
        c.status = "expired"
    return {"started": started, "ended": ended}


def issue_coupon(db: Session, promo: Promotion, customer_id: uuid.UUID, via: str = "in_app") -> tuple[Coupon, bool]:
    if promo.status != "active":
        raise BusinessRuleError("Coupons can only be issued for active promotions")
    existing = db.scalars(select(Coupon).where(Coupon.promotion_id == promo.id, Coupon.customer_id == customer_id)).first()
    if existing:
        return existing, False
    if promo.usage_limit is not None and promo.usage_count >= promo.usage_limit:
        raise BusinessRuleError("This promotion has reached its usage limit")
    code = "OP-" + secrets.token_hex(4).upper()
    c = Coupon(promotion_id=promo.id, merchant_id=promo.merchant_id, code=code, customer_id=customer_id,
               issued_via=via, expires_at=promo.ends_at)
    db.add(c)
    db.flush()
    return c, True


def redeem_coupon(db: Session, merchant_id: uuid.UUID, code: str, actor: User | None,
                  transaction_id: uuid.UUID | None = None, discount_amount: Decimal | None = None) -> CouponRedemption:
    """Redeem at the (simulated) point of sale. Usage limits are enforced atomically per promotion."""
    # Row locks (PostgreSQL) serialise concurrent redemptions; eager joins are disabled because
    # FOR UPDATE cannot lock the nullable side of an outer join.
    c = db.scalars(select(Coupon).options(lazyload("*")).where(Coupon.code == code.upper(), Coupon.merchant_id == merchant_id)
                   .with_for_update(of=Coupon)).first()
    if c is None:
        raise NotFoundError("Coupon not found")
    now = datetime.now(UTC)
    if c.status != "issued":
        raise ConflictError(f"Coupon is {c.status}")
    if c.expires_at <= now:
        c.status = "expired"
        db.commit()
        raise BusinessRuleError("Coupon has expired")
    promo = db.scalars(select(Promotion).options(lazyload("*")).where(Promotion.id == c.promotion_id)
                       .with_for_update(of=Promotion)).first()
    if promo.status != "active":
        raise BusinessRuleError("Promotion is not active")
    if promo.usage_limit is not None and promo.usage_count >= promo.usage_limit:
        raise BusinessRuleError("Promotion usage limit reached")
    promo.usage_count += 1
    c.status = "redeemed"
    r = CouponRedemption(coupon_id=c.id, customer_id=c.customer_id, transaction_id=transaction_id,
                         discount_amount=discount_amount or Decimal(0))
    db.add(r)
    record_audit(db, action="pricing.coupon.redeemed", entity_type="coupon", entity_id=c.id,
                 summary=f"Coupon {c.code} redeemed for '{promo.name}'", actor=actor, merchant_id=merchant_id)
    return r


def promotion_performance(db: Session, promo: Promotion) -> dict:
    """Observational comparison: targeted-product units in the promo window vs the preceding window.

    This is *not* a causal uplift estimate (no control group); the response says so.
    """
    now = datetime.now(UTC)
    start = promo.starts_at
    end = min(promo.ends_at, now)
    product_ids = [pp.product_id for pp in promo.products]
    coupons_issued = db.scalar(select(func.count(Coupon.id)).where(Coupon.promotion_id == promo.id)) or 0
    redemptions = db.scalar(select(func.count(CouponRedemption.id)).join(Coupon, Coupon.id == CouponRedemption.coupon_id)
                            .where(Coupon.promotion_id == promo.id)) or 0
    if end <= start or not product_ids:
        return {"coupons_issued": coupons_issued, "redemptions": redemptions, "window_days": 0,
                "units_during": 0, "units_before": 0, "change_pct": None,
                "method": "observational_before_after", "caveat": "Promotion has not run yet."}
    span = end - start

    def units(a: datetime, b: datetime) -> int:
        stmt = (select(func.coalesce(func.sum(TransactionItem.quantity), 0))
                .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
                .where(SalesTransaction.merchant_id == promo.merchant_id, SalesTransaction.transaction_type == "sale",
                       SalesTransaction.occurred_at >= a, SalesTransaction.occurred_at < b,
                       TransactionItem.product_id.in_(product_ids)))
        if promo.store_id:
            stmt = stmt.where(SalesTransaction.store_id == promo.store_id)
        return int(db.scalar(stmt) or 0)

    during, before = units(start, end), units(start - span, start)
    change = round((during - before) / before * 100, 1) if before else None
    return {"coupons_issued": coupons_issued, "redemptions": redemptions,
            "window_days": round(span.total_seconds() / 86400, 1), "units_during": during, "units_before": before,
            "change_pct": change, "method": "observational_before_after",
            "caveat": "Before/after comparison without a control group; seasonality, weather and other campaigns "
                      "can explain differences. Use an A/B test to measure causal uplift."}
