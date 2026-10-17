"""Pricing rules, price-change workflow, promotions and coupons."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Money, Timestamps, UTCDateTime, UUIDPk, utcnow


class PricingRule(UUIDPk, Timestamps, Base):
    __tablename__ = "pricing_rules"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    rule_type: Mapped[str] = mapped_column(String(32))  # expiry_markdown|weather_promotion|overstock_clearance
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=100)
    conditions: Mapped[dict] = mapped_column(default=dict)
    parameters: Mapped[dict] = mapped_column(default=dict)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


PRICE_CHANGE_STATUSES = (
    "RECOMMENDED",
    "PENDING_APPROVAL",
    "APPROVED",
    "PUBLISHED",
    "REJECTED",
    "CANCELLED",
    "EXPIRED",
    "FAILED",
)


class PriceChange(UUIDPk, Timestamps, Base):
    __tablename__ = "price_changes"
    __table_args__ = (Index("ix_price_changes_merchant_status", "merchant_id", "status"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("inventory_batches.id", ondelete="SET NULL"))
    rule_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pricing_rules.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(String(24))  # expiry_markdown|overstock|manual
    status: Mapped[str] = mapped_column(String(20), default="RECOMMENDED")
    current_price: Mapped[Decimal] = mapped_column(Money)
    proposed_price: Mapped[Decimal] = mapped_column(Money)
    discount_pct: Mapped[float] = mapped_column(Float)
    floor_price: Mapped[Decimal] = mapped_column(Money)
    unit_cost: Mapped[Decimal] = mapped_column(Money)
    projected_margin_pct: Mapped[float] = mapped_column(Float)
    quantity_affected: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str] = mapped_column(Text)
    evidence: Mapped[dict] = mapped_column(default=dict)
    clearance_instruction: Mapped[str | None] = mapped_column(Text)
    effective_from: Mapped[datetime | None] = mapped_column(UTCDateTime())
    effective_until: Mapped[datetime | None] = mapped_column(UTCDateTime())
    requested_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    publish_reference: Mapped[str | None] = mapped_column(String(80))
    failure_reason: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(String(160), unique=True)

    product = relationship("Product", lazy="joined")
    events: Mapped[list[PriceChangeEvent]] = relationship(
        lazy="selectin", order_by="PriceChangeEvent.created_at", cascade="all, delete-orphan"
    )


class PriceChangeEvent(UUIDPk, Base):
    __tablename__ = "price_change_events"
    price_change_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("price_changes.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Promotion(UUIDPk, Timestamps, Base):
    __tablename__ = "promotions"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    promo_type: Mapped[str] = mapped_column(String(16))  # percent_off|amount_off
    discount_value: Mapped[Decimal] = mapped_column(Money)
    # draft|pending_approval|scheduled|active|paused|ended|rejected|cancelled
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # manual|weather|expiry|overstock
    starts_at: Mapped[datetime] = mapped_column(UTCDateTime())
    ends_at: Mapped[datetime] = mapped_column(UTCDateTime())
    usage_limit: Mapped[int | None] = mapped_column(Integer)
    per_customer_limit: Mapped[int] = mapped_column(Integer, default=1)
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    geofence_radius_m: Mapped[int | None] = mapped_column(Integer)
    is_simulation: Mapped[bool] = mapped_column(Boolean, default=False)
    evidence: Mapped[dict] = mapped_column(default=dict)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    products: Mapped[list[PromotionProduct]] = relationship(lazy="selectin", cascade="all, delete-orphan")


class PromotionProduct(UUIDPk, Base):
    __tablename__ = "promotion_products"
    __table_args__ = (UniqueConstraint("promotion_id", "product_id"),)
    promotion_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("promotions.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)

    product = relationship("Product", lazy="joined")


class Coupon(UUIDPk, Timestamps, Base):
    __tablename__ = "coupons"
    __table_args__ = (UniqueConstraint("promotion_id", "customer_id"),)
    promotion_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("promotions.id", ondelete="CASCADE"), index=True)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="issued")  # issued|redeemed|expired|revoked
    issued_via: Mapped[str] = mapped_column(String(16), default="in_app")  # in_app|geofence|manual
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())

    promotion = relationship("Promotion", lazy="joined")


class CouponRedemption(UUIDPk, Base):
    __tablename__ = "coupon_redemptions"
    coupon_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("coupons.id", ondelete="CASCADE"), unique=True)
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sales_transactions.id", ondelete="SET NULL"))
    discount_amount: Mapped[Decimal] = mapped_column(Money)
    redeemed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
