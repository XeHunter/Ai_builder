"""Promotions & coupons (merchant) and offers (shopper)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_customer, require_permission
from app.core.exceptions import NotFoundError
from app.db.models import Coupon, Promotion, Store, User
from app.db.session import get_db
from app.services import catalog_service, pricing_service
from app.services.pricing_policy import margin_pct, promotion_price
from app.services.sales_stats import daily_velocity

router = APIRouter(tags=["promotions"])


class PromotionIn(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    description: str = Field(default="", max_length=1000)
    store_id: uuid.UUID | None = None
    product_ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    promo_type: str = Field(pattern="^(percent_off|amount_off)$")
    discount_value: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    starts_at: datetime
    ends_at: datetime
    usage_limit: int | None = Field(default=None, ge=1, le=1_000_000)
    per_customer_limit: int = Field(default=1, ge=1, le=10)
    geofence_radius_m: int | None = Field(default=None, ge=100, le=20000)
    trigger: str = Field(default="manual", pattern="^(manual|weather|expiry|overstock)$")
    evidence: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _window(self) -> PromotionIn:
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        return self


def _promo_out(db: Session, p: Promotion) -> dict:
    store = db.get(Store, p.store_id) if p.store_id else None
    products = []
    for pp in p.products:
        prod = pp.product
        new = promotion_price(prod.price, p.promo_type, p.discount_value)
        products.append({"product_id": str(prod.id), "name": prod.name, "sku": prod.sku, "regular_price": float(prod.price),
                         "promo_price": float(new), "margin_at_promo_pct": margin_pct(new, prod.cost_price)})
    return {"id": str(p.id), "name": p.name, "description": p.description,
            "store_id": str(p.store_id) if p.store_id else None, "store_name": store.name if store else "All stores",
            "promo_type": p.promo_type, "discount_value": float(p.discount_value), "status": p.status, "trigger": p.trigger,
            "starts_at": p.starts_at.isoformat(), "ends_at": p.ends_at.isoformat(), "usage_limit": p.usage_limit,
            "per_customer_limit": p.per_customer_limit, "usage_count": p.usage_count,
            "geofence_radius_m": p.geofence_radius_m, "is_simulation": p.is_simulation, "evidence": p.evidence or {},
            "products": products, "approved_at": p.approved_at.isoformat() if p.approved_at else None,
            "created_at": p.created_at.isoformat()}


def _owned(db: Session, ctx: MerchantContext, promo_id: uuid.UUID) -> Promotion:
    p = db.get(Promotion, promo_id)
    if p is None or p.merchant_id != ctx.merchant_id:
        raise NotFoundError("Promotion not found")
    if p.store_id:
        get_store_scoped(db, ctx, p.store_id)
    return p


@router.get("/merchant/promotions")
def list_promotions(status_filter: str | None = Query(None, alias="status"), include_simulations: bool = False,
                    ctx: MerchantContext = Depends(require_permission("pricing.read")), db: Session = Depends(get_db)) -> list[dict]:
    stmt = select(Promotion).where(Promotion.merchant_id == ctx.merchant_id)
    if status_filter:
        stmt = stmt.where(Promotion.status.in_(status_filter.split(",")))
    if not include_simulations:
        stmt = stmt.where(Promotion.is_simulation.is_(False))
    return [_promo_out(db, p) for p in db.scalars(stmt.order_by(Promotion.created_at.desc()).limit(200))]


@router.post("/merchant/promotions", status_code=status.HTTP_201_CREATED)
def create_promotion(body: PromotionIn, ctx: MerchantContext = Depends(require_permission("pricing.recommend")),
                     db: Session = Depends(get_db)) -> dict:
    """Create a draft. Guardrails (floor, max discount, eligibility, recent price rises) are enforced now
    and re-checked at approval."""
    if body.store_id:
        get_store_scoped(db, ctx, body.store_id)
    p = pricing_service.create_promotion(
        db, merchant_id=ctx.merchant_id, actor=ctx.user, name=body.name, description=body.description,
        store_id=body.store_id, product_ids=body.product_ids, promo_type=body.promo_type,
        discount_value=body.discount_value, starts_at=body.starts_at, ends_at=body.ends_at, usage_limit=body.usage_limit,
        per_customer_limit=body.per_customer_limit, geofence_radius_m=body.geofence_radius_m, trigger=body.trigger,
        evidence=body.evidence)
    db.commit()
    return _promo_out(db, p)


@router.post("/merchant/promotions/simulate")
def simulate(body: PromotionIn, ctx: MerchantContext = Depends(require_permission("pricing.read")),
             db: Session = Depends(get_db)) -> dict:
    """Dry run: guardrail check plus a margin projection at recent velocity (no uplift assumed; nothing saved)."""
    from app.db.models import Product

    products = db.scalars(select(Product).where(Product.id.in_(body.product_ids), Product.merchant_id == ctx.merchant_id)).all()
    issues = pricing_service.validate_promotion(db, ctx.merchant_id, body.store_id, list(products), body.promo_type,
                                                body.discount_value)
    days = (body.ends_at - body.starts_at).total_seconds() / 86400
    store_ids = [body.store_id] if body.store_id else list(db.scalars(select(Store.id).where(Store.merchant_id == ctx.merchant_id)))
    lines = []
    for p in products:
        v = sum(daily_velocity(db, sid, [p.id]).get(p.id, 0.0) for sid in store_ids)
        new = promotion_price(p.price, body.promo_type, body.discount_value)
        units = v * days
        lines.append({"product_id": str(p.id), "name": p.name, "regular_price": float(p.price), "promo_price": float(new),
                      "baseline_units": round(units, 1),
                      "margin_regular": round(units * float(p.price - p.cost_price), 2),
                      "margin_at_promo_same_volume": round(units * float(new - p.cost_price), 2),
                      "breakeven_volume_increase_pct": (round((float(p.price - p.cost_price) / float(new - p.cost_price) - 1) * 100, 1)
                                                        if new > p.cost_price else None)})
    return {"valid": not issues, "issues": issues, "window_days": round(days, 1), "lines": lines,
            "method": "baseline_velocity_projection",
            "caveat": "Assumes unchanged volume; the break-even column shows the volume increase needed to keep "
                      "gross margin flat. Actual response is unknown until measured."}


@router.get("/merchant/promotions/{promo_id}")
def get_promotion(promo_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("pricing.read")),
                  db: Session = Depends(get_db)) -> dict:
    p = _owned(db, ctx, promo_id)
    return {**_promo_out(db, p), "performance": pricing_service.promotion_performance(db, p)}


class StatusBody(BaseModel):
    action: str = Field(pattern="^(submit|approve|reject|pause|resume|end|cancel)$")


@router.post("/merchant/promotions/{promo_id}/actions")
def promotion_action(promo_id: uuid.UUID, body: StatusBody,
                     ctx: MerchantContext = Depends(require_permission("pricing.recommend")),
                     db: Session = Depends(get_db)) -> dict:
    p = _owned(db, ctx, promo_id)
    if body.action == "submit":
        pricing_service.submit_promotion(db, p, ctx.user)
    elif body.action == "approve":
        ctx.require("pricing.approve")
        pricing_service.approve_promotion(db, p, ctx.user)
    else:
        if body.action == "reject":
            ctx.require("pricing.approve")
        target = {"reject": "rejected", "pause": "paused", "resume": "active", "end": "ended", "cancel": "cancelled"}[body.action]
        pricing_service.set_promotion_status(db, p, target, ctx.user)
    db.commit()
    catalog_service.invalidate_index(ctx.merchant_id)
    return _promo_out(db, p)


class RedeemBody(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    discount_amount: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)


@router.post("/merchant/coupons/redeem")
def redeem(body: RedeemBody, ctx: MerchantContext = Depends(require_permission("pricing.read")),
           db: Session = Depends(get_db)) -> dict:
    """Simulated point-of-sale coupon redemption (enforces expiry, status and usage limits)."""
    r = pricing_service.redeem_coupon(db, ctx.merchant_id, body.code, ctx.user, discount_amount=body.discount_amount)
    db.commit()
    return {"coupon_id": str(r.coupon_id), "redeemed_at": r.redeemed_at.isoformat(), "simulated_pos": True}


# ---------------------------------------------------------------------------- shopper offers


@router.get("/offers")
def offers(store_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    store = db.get(Store, store_id)
    if store is None:
        raise NotFoundError("Store not found")
    now = datetime.now(UTC)
    promos = db.scalars(select(Promotion).where(Promotion.merchant_id == store.merchant_id, Promotion.status == "active",
                                                Promotion.is_simulation.is_(False), Promotion.starts_at <= now,
                                                Promotion.ends_at > now,
                                                or_(Promotion.store_id.is_(None), Promotion.store_id == store.id))).all()
    coupons = db.scalars(select(Coupon).where(Coupon.customer_id == user.id, Coupon.merchant_id == store.merchant_id)
                         .order_by(Coupon.created_at.desc())).all()
    return {
        "promotions": [{"id": str(p.id), "name": p.name, "description": p.description, "ends_at": p.ends_at.isoformat(),
                        "promo_type": p.promo_type, "discount_value": float(p.discount_value),
                        "nearby_only": p.geofence_radius_m is not None,
                        "products": [pp.product.name for pp in p.products][:6]} for p in promos],
        "coupons": [{"id": str(c.id), "code": c.code, "status": c.status, "promotion": c.promotion.name,
                     "issued_via": c.issued_via, "expires_at": c.expires_at.isoformat()} for c in coupons],
    }


@router.post("/offers/{promo_id}/claim")
def claim(promo_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    """Claim a coupon for an active, non-proximity promotion (proximity offers are issued by the geofence flow)."""
    p = db.get(Promotion, promo_id)
    if p is None or p.is_simulation:
        raise NotFoundError("Promotion not found")
    if p.geofence_radius_m is not None:
        from app.core.exceptions import BusinessRuleError

        raise BusinessRuleError("This offer is only available when you are near the store")
    c, new = pricing_service.issue_coupon(db, p, user.id, via="in_app")
    db.commit()
    return {"code": c.code, "new": new, "expires_at": c.expires_at.isoformat()}
