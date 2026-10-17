"""Pricing: price-change workflow, pricing rules, merchant pricing policy and weather opportunities."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import (
    MerchantContext,
    get_store_scoped,
    page_params,
    require_permission,
    resolve_store_ids,
)
from app.core.exceptions import NotFoundError
from app.db.models import InventoryItem, PriceChange, PricingRule, Product, Store, User
from app.db.session import get_db
from app.schemas.common import Page, PageParams
from app.services import pricing_service, weather_service
from app.services.audit_service import record_audit
from app.services.pricing_policy import price_floor, promotion_price
from app.services.sales_stats import daily_sales_frame

router = APIRouter(prefix="/merchant/pricing", tags=["pricing"])


class PriceChangeOut(BaseModel):
    id: str
    store_id: str
    store_code: str
    product_id: str
    product: str
    sku: str
    batch_id: str | None
    batch_code: str | None
    source: str
    status: str
    current_price: float
    proposed_price: float
    discount_pct: float
    floor_price: float
    unit_cost: float
    projected_margin_pct: float
    quantity_affected: int
    reason: str
    evidence: dict[str, Any]
    clearance_instruction: str | None
    publish_reference: str | None
    failure_reason: str | None
    requested_by: str | None
    approved_by: str | None
    created_at: str
    approved_at: str | None
    published_at: str | None
    effective_until: str | None
    events: list[dict[str, Any]]


def _pc_out(db: Session, pc: PriceChange) -> dict:
    store = db.get(Store, pc.store_id)
    users = {u.id: u.full_name for u in db.scalars(select(User).where(User.id.in_(
        {i for i in [pc.requested_by_id, pc.approved_by_id, *[e.actor_id for e in pc.events]] if i})))}
    from app.db.models import InventoryBatch

    batch = db.get(InventoryBatch, pc.batch_id) if pc.batch_id else None
    return {
        "id": str(pc.id), "store_id": str(pc.store_id), "store_code": store.code, "product_id": str(pc.product_id),
        "product": pc.product.name, "sku": pc.product.sku, "batch_id": str(pc.batch_id) if pc.batch_id else None,
        "batch_code": batch.batch_code if batch else None, "source": pc.source, "status": pc.status,
        "current_price": float(pc.current_price), "proposed_price": float(pc.proposed_price),
        "discount_pct": pc.discount_pct, "floor_price": float(pc.floor_price), "unit_cost": float(pc.unit_cost),
        "projected_margin_pct": pc.projected_margin_pct, "quantity_affected": pc.quantity_affected, "reason": pc.reason,
        "evidence": pc.evidence or {}, "clearance_instruction": pc.clearance_instruction,
        "publish_reference": pc.publish_reference, "failure_reason": pc.failure_reason,
        "requested_by": users.get(pc.requested_by_id, "system" if pc.requested_by_id is None else None),
        "approved_by": users.get(pc.approved_by_id) if pc.approved_by_id else ("policy" if pc.approved_at else None),
        "created_at": pc.created_at.isoformat(),
        "approved_at": pc.approved_at.isoformat() if pc.approved_at else None,
        "published_at": pc.published_at.isoformat() if pc.published_at else None,
        "effective_until": pc.effective_until.isoformat() if pc.effective_until else None,
        "events": [{"from": e.from_status, "to": e.to_status, "actor": users.get(e.actor_id, "system"), "note": e.note,
                    "at": e.created_at.isoformat()} for e in pc.events],
    }


@router.get("/changes", response_model=Page[PriceChangeOut])
def list_changes(store_id: uuid.UUID | None = None, status_filter: str | None = Query(None, alias="status"),
                 source: str | None = None, pp: PageParams = Depends(page_params),
                 ctx: MerchantContext = Depends(require_permission("pricing.read")), db: Session = Depends(get_db)) -> dict:
    store_ids = resolve_store_ids(db, ctx, store_id)
    stmt = select(PriceChange).where(PriceChange.merchant_id == ctx.merchant_id, PriceChange.store_id.in_(store_ids))
    if status_filter:
        stmt = stmt.where(PriceChange.status.in_(status_filter.split(",")))
    if source:
        stmt = stmt.where(PriceChange.source == source)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(PriceChange.created_at.desc()).offset(pp.offset).limit(pp.page_size)).all()
    return {"items": [_pc_out(db, pc) for pc in rows], "total": total, "page": pp.page, "page_size": pp.page_size}


def _owned(db: Session, ctx: MerchantContext, pc_id: uuid.UUID) -> PriceChange:
    pc = pricing_service.get_price_change(db, ctx.merchant_id, pc_id)
    get_store_scoped(db, ctx, pc.store_id)
    return pc


@router.get("/changes/{pc_id}", response_model=PriceChangeOut)
def get_change(pc_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("pricing.read")),
               db: Session = Depends(get_db)) -> dict:
    return _pc_out(db, _owned(db, ctx, pc_id))


class ActionBody(BaseModel):
    note: str | None = Field(default=None, max_length=500)


@router.post("/changes/{pc_id}/submit", response_model=PriceChangeOut)
def submit(pc_id: uuid.UUID, body: ActionBody, ctx: MerchantContext = Depends(require_permission("pricing.recommend")),
           db: Session = Depends(get_db)) -> dict:
    pc = pricing_service.submit_for_approval(db, _owned(db, ctx, pc_id), ctx.user, body.note)
    db.commit()
    return _pc_out(db, pc)


class ApproveBody(ActionBody):
    publish: bool = True


@router.post("/changes/{pc_id}/approve", response_model=PriceChangeOut)
def approve(pc_id: uuid.UUID, body: ApproveBody, ctx: MerchantContext = Depends(require_permission("pricing.approve")),
            db: Session = Depends(get_db)) -> dict:
    """Approve (guardrails re-checked) and, by default, publish through the simulated price publisher."""
    if body.publish:
        ctx.require("pricing.publish")
    pc = pricing_service.approve(db, _owned(db, ctx, pc_id), ctx.user, body.note, publish_now=body.publish)
    db.commit()
    return _pc_out(db, pc)


@router.post("/changes/{pc_id}/publish", response_model=PriceChangeOut)
def publish(pc_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("pricing.publish")),
            db: Session = Depends(get_db)) -> dict:
    pc = pricing_service.publish(db, _owned(db, ctx, pc_id), ctx.user)
    db.commit()
    return _pc_out(db, pc)


@router.post("/changes/{pc_id}/reject", response_model=PriceChangeOut)
def reject(pc_id: uuid.UUID, body: ActionBody, ctx: MerchantContext = Depends(require_permission("pricing.approve")),
           db: Session = Depends(get_db)) -> dict:
    pc = pricing_service.reject(db, _owned(db, ctx, pc_id), ctx.user, body.note)
    db.commit()
    return _pc_out(db, pc)


@router.post("/changes/{pc_id}/cancel", response_model=PriceChangeOut)
def cancel(pc_id: uuid.UUID, body: ActionBody, ctx: MerchantContext = Depends(require_permission("pricing.recommend")),
           db: Session = Depends(get_db)) -> dict:
    pc = pricing_service.cancel(db, _owned(db, ctx, pc_id), ctx.user, body.note)
    db.commit()
    return _pc_out(db, pc)


class ManualPriceChange(BaseModel):
    store_id: uuid.UUID
    product_id: uuid.UUID
    new_price: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    reason: str = Field(min_length=3, max_length=500)


@router.post("/changes", response_model=PriceChangeOut, status_code=status.HTTP_201_CREATED)
def create_manual(body: ManualPriceChange, ctx: MerchantContext = Depends(require_permission("pricing.recommend")),
                  db: Session = Depends(get_db)) -> dict:
    """Propose a store-level price change. It always goes through approval before publication."""
    store = get_store_scoped(db, ctx, body.store_id)
    product = db.get(Product, body.product_id)
    if product is None or product.merchant_id != ctx.merchant_id:
        raise NotFoundError("Product not found")
    pc = pricing_service.create_price_change(db, store=store, product=product, proposed_price=body.new_price,
                                             source="manual", reason=body.reason, actor=ctx.user)
    db.commit()
    return _pc_out(db, pc)


# ---------------------------------------------------------------------------- policy & rules


class PolicyOut(BaseModel):
    auto_publish_markdowns: bool
    auto_publish_max_pct: int
    max_markdown_pct: int
    min_margin_pct: int
    expiry_warning_days: int
    expiry_critical_hours: int
    sell_by_buffer_hours: int
    low_stock_threshold_days: int
    forecast_horizon_days: int
    fraud_alert_threshold: int
    default_geofence_radius_m: int
    notification_cooldown_minutes: int
    clearance_location_code: str | None


class PolicyUpdate(BaseModel):
    auto_publish_markdowns: bool | None = None
    auto_publish_max_pct: int | None = Field(default=None, ge=0, le=50)
    max_markdown_pct: int | None = Field(default=None, ge=0, le=90)
    min_margin_pct: int | None = Field(default=None, ge=-50, le=90)
    expiry_warning_days: int | None = Field(default=None, ge=1, le=30)
    expiry_critical_hours: int | None = Field(default=None, ge=1, le=168)
    sell_by_buffer_hours: int | None = Field(default=None, ge=0, le=72)
    forecast_horizon_days: int | None = Field(default=None, ge=1, le=60)
    fraud_alert_threshold: int | None = Field(default=None, ge=1, le=100)
    default_geofence_radius_m: int | None = Field(default=None, ge=100, le=20000)
    notification_cooldown_minutes: int | None = Field(default=None, ge=0, le=10080)
    clearance_location_code: str | None = Field(default=None, max_length=32)


@router.get("/policy", response_model=PolicyOut)
def get_policy(ctx: MerchantContext = Depends(require_permission("pricing.read")), db: Session = Depends(get_db)):
    return PolicyOut.model_validate(pricing_service.merchant_settings(db, ctx.merchant_id), from_attributes=True)


@router.patch("/policy", response_model=PolicyOut)
def update_policy(body: PolicyUpdate, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                  db: Session = Depends(get_db)):
    s = pricing_service.merchant_settings(db, ctx.merchant_id)
    changes = body.model_dump(exclude_unset=True)
    before = {k: getattr(s, k) for k in changes}
    for k, v in changes.items():
        setattr(s, k, v)
    record_audit(db, action="settings.policy.updated", entity_type="merchant_settings", entity_id=ctx.merchant_id,
                 summary=f"Policy updated: {', '.join(changes)}", actor=ctx.user, merchant_id=ctx.merchant_id,
                 before=before, after=changes)
    db.commit()
    return PolicyOut.model_validate(s, from_attributes=True)


class RuleOut(BaseModel):
    id: str
    store_id: str | None
    name: str
    rule_type: str
    is_active: bool
    priority: int
    conditions: dict
    parameters: dict


class RuleIn(BaseModel):
    store_id: uuid.UUID | None = None
    name: str = Field(min_length=2, max_length=120)
    rule_type: str = Field(pattern="^(expiry_markdown|weather_promotion|overstock_clearance)$")
    is_active: bool = True
    priority: int = Field(default=100, ge=0, le=1000)
    conditions: dict = Field(default_factory=dict)
    parameters: dict = Field(default_factory=dict)


def _rule_out(r: PricingRule) -> dict:
    return {"id": str(r.id), "store_id": str(r.store_id) if r.store_id else None, "name": r.name,
            "rule_type": r.rule_type, "is_active": r.is_active, "priority": r.priority, "conditions": r.conditions,
            "parameters": r.parameters}


def _validate_rule_params(body: RuleIn) -> None:
    from app.core.exceptions import ValidationFailedError

    if body.rule_type == "expiry_markdown":
        e = body.parameters.get("elasticity", 2.0)
        if not isinstance(e, (int, float)) or not 0.1 <= e <= 10:
            raise ValidationFailedError("elasticity must be a number between 0.1 and 10")
        for t in body.parameters.get("tiers", []):
            if not (isinstance(t, dict) and 0 < t.get("max_hours", 0) <= 720 and 0 <= t.get("max_discount_pct", -1) <= 90):
                raise ValidationFailedError("each tier needs max_hours (1-720) and max_discount_pct (0-90)")
    if body.rule_type == "weather_promotion":
        d = body.parameters.get("discount_pct", 10)
        if not isinstance(d, (int, float)) or not 1 <= d <= 50:
            raise ValidationFailedError("discount_pct must be between 1 and 50")


@router.get("/rules", response_model=list[RuleOut])
def list_rules(ctx: MerchantContext = Depends(require_permission("pricing.read")), db: Session = Depends(get_db)) -> list[dict]:
    return [_rule_out(r) for r in db.scalars(select(PricingRule).where(PricingRule.merchant_id == ctx.merchant_id)
                                             .order_by(PricingRule.priority))]


@router.post("/rules", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(body: RuleIn, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                db: Session = Depends(get_db)) -> dict:
    if body.store_id:
        get_store_scoped(db, ctx, body.store_id)
    _validate_rule_params(body)
    r = PricingRule(merchant_id=ctx.merchant_id, created_by_id=ctx.user.id, **body.model_dump())
    db.add(r)
    db.flush()
    record_audit(db, action="pricing.rule.created", entity_type="pricing_rule", entity_id=r.id, summary=r.name,
                 actor=ctx.user, merchant_id=ctx.merchant_id, after=body.model_dump(mode="json"))
    db.commit()
    return _rule_out(r)


@router.put("/rules/{rule_id}", response_model=RuleOut)
def update_rule(rule_id: uuid.UUID, body: RuleIn, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                db: Session = Depends(get_db)) -> dict:
    r = db.get(PricingRule, rule_id)
    if r is None or r.merchant_id != ctx.merchant_id:
        raise NotFoundError("Rule not found")
    _validate_rule_params(body)
    before = _rule_out(r)
    for k, v in body.model_dump().items():
        setattr(r, k, v)
    record_audit(db, action="pricing.rule.updated", entity_type="pricing_rule", entity_id=r.id, summary=r.name,
                 actor=ctx.user, merchant_id=ctx.merchant_id, before=before, after=body.model_dump(mode="json"))
    db.commit()
    return _rule_out(r)


# ---------------------------------------------------------------------------- weather opportunities


@router.get("/weather-opportunities")
def weather_opportunities(store_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("pricing.read")),
                          db: Session = Depends(get_db)) -> dict:
    """Evaluate whether rain-associated products qualify for a promotion at this store.

    Qualifies only if: rain >= 5 mm is forecast in the next 3 days, the product historically sold more on
    rainy days (>= 5 rainy and dry days observed), stock covers expected demand (we never discount scarce
    stock), and the discounted price respects the floor. The output is a recommendation; creating the
    promotion still requires approval.
    """
    store = get_store_scoped(db, ctx, store_id)
    rule = db.scalars(select(PricingRule).where(PricingRule.merchant_id == ctx.merchant_id,
                                                PricingRule.rule_type == "weather_promotion",
                                                PricingRule.is_active.is_(True))).first()
    params = rule.parameters if rule else {}
    tag = params.get("product_tag", "rain")
    discount = Decimal(str(params.get("discount_pct", 10)))
    source = weather_service.refresh_forecast(db, store, 7)
    forecast = weather_service.forecast_view(db, store, 3)
    rainy = [d for d in forecast if d["precipitation_mm"] >= params.get("min_precip_mm", 5)]
    settings = pricing_service.merchant_settings(db, ctx.merchant_id)
    today = datetime.now(UTC).date()
    start = today - timedelta(days=120)
    weather_service.ensure_history(db, store, start, today - timedelta(days=1))
    hist = weather_service.weather_frame(db, store, start, today - timedelta(days=1))
    rain_days = {d for d, w in hist.items() if w.precipitation_mm >= 5 and not w.is_forecast}
    products = [p for p in db.scalars(select(Product).where(Product.merchant_id == ctx.merchant_id, Product.status == "active"))
                if tag in (p.tags or [])]
    frame = daily_sales_frame(db, store.id, start, today - timedelta(days=1), [p.id for p in products])
    candidates = []
    for p in products:
        item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store.id, InventoryItem.product_id == p.id)).first()
        if item is None:
            continue
        rows = frame[frame["product_id"] == p.id] if len(frame) else frame
        on_rain = rows[rows["date"].isin(rain_days)]["units"] if len(rows) else []
        on_dry = rows[~rows["date"].isin(rain_days)]["units"] if len(rows) else []
        n_r, n_d = len(on_rain), len(on_dry)
        mr = float(on_rain.mean()) if n_r else 0.0
        md = float(on_dry.mean()) if n_d else 0.0
        expected = mr * len(rainy) + md * (3 - len(rainy))
        regular = item.price_override if item.price_override is not None else p.price
        new_price = promotion_price(regular, "percent_off", discount)
        floor = price_floor(p.cost_price, p.min_allowed_price, settings.min_margin_pct)
        checks = {
            "rain_forecast": bool(rainy),
            "historical_association": n_r >= 5 and n_d >= 5 and md > 0 and mr / md >= 1.3,
            "stock_sufficient": item.quantity_on_hand >= expected * 1.2,
            "promotion_eligible": p.promotion_eligible,
            "above_price_floor": new_price >= floor,
        }
        candidates.append({
            "product_id": str(p.id), "name": p.name, "sku": p.sku, "regular_price": float(regular),
            "promo_price": float(new_price), "floor_price": float(floor), "stock": item.quantity_on_hand,
            "expected_units_3d": round(expected, 1),
            "evidence": {"rain_days_observed": n_r, "dry_days_observed": n_d, "avg_units_rain": round(mr, 2),
                         "avg_units_dry": round(md, 2), "ratio": round(mr / md, 2) if md else None},
            "checks": checks, "qualifies": all(checks.values()),
        })
    db.commit()
    q = [c for c in candidates if c["qualifies"]]
    return {
        "store_id": str(store.id), "weather_source": source, "forecast": forecast, "rain_days": [d["date"] for d in rainy],
        "discount_pct": float(discount), "candidates": candidates,
        "recommendation": (
            {"name": f"Rainy-day essentials at {store.name}", "product_ids": [c["product_id"] for c in q],
             "discount_pct": float(discount), "starts_at": datetime.now(UTC).isoformat(),
             "ends_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
             "geofence_radius_m": settings.default_geofence_radius_m,
             "rationale": "Rain is forecast and these products have sold more on past rainy days at this store "
                          "(association, not proven causation); stock is sufficient and discounts respect price floors."}
            if q else None),
        "method": "deterministic_rule_with_historical_evidence",
    }
