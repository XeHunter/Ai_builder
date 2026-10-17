"""Users, roles, permissions, merchants (tenants) and memberships."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, Table, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


class Permission(UUIDPk, Base):
    __tablename__ = "permissions"
    code: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(255), default="")


class Role(UUIDPk, Base):
    __tablename__ = "roles"
    name: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(255), default="")
    permissions: Mapped[list[Permission]] = relationship(secondary=role_permissions, lazy="selectin")


class User(UUIDPk, Timestamps, Base):
    __tablename__ = "users"
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    # "customer" shoppers or "merchant" staff. Merchant permissions come from memberships.
    account_type: Mapped[str] = mapped_column(String(16), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    phone: Mapped[str | None] = mapped_column(String(32))
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    preferred_store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="SET NULL"))

    memberships: Mapped[list[MerchantMembership]] = relationship(
        back_populates="user", lazy="selectin", foreign_keys="MerchantMembership.user_id"
    )


class Merchant(UUIDPk, Timestamps, Base):
    __tablename__ = "merchants"
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)


class MerchantSettings(Timestamps, Base):
    """Merchant-wide operating policy. Pricing guardrails are enforced from these values."""

    __tablename__ = "merchant_settings"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), primary_key=True)
    auto_publish_markdowns: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_publish_max_pct: Mapped[int] = mapped_column(Integer, default=15)
    max_markdown_pct: Mapped[int] = mapped_column(Integer, default=50)
    min_margin_pct: Mapped[int] = mapped_column(Integer, default=0)
    expiry_warning_days: Mapped[int] = mapped_column(Integer, default=3)
    expiry_critical_hours: Mapped[int] = mapped_column(Integer, default=48)
    sell_by_buffer_hours: Mapped[int] = mapped_column(Integer, default=0)
    low_stock_threshold_days: Mapped[int] = mapped_column(Integer, default=3)
    forecast_horizon_days: Mapped[int] = mapped_column(Integer, default=14)
    fraud_alert_threshold: Mapped[int] = mapped_column(Integer, default=50)
    default_geofence_radius_m: Mapped[int] = mapped_column(Integer, default=1000)
    notification_cooldown_minutes: Mapped[int] = mapped_column(Integer, default=240)
    clearance_location_code: Mapped[str | None] = mapped_column(String(32))


class MerchantMembership(UUIDPk, Timestamps, Base):
    __tablename__ = "merchant_memberships"
    __table_args__ = (UniqueConstraint("user_id", "merchant_id"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    role_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("roles.id"))
    # When false the member may only act on stores listed in store_memberships.
    all_stores: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    user: Mapped[User] = relationship(back_populates="memberships", foreign_keys=[user_id])
    merchant: Mapped[Merchant] = relationship(lazy="selectin")
    role: Mapped[Role] = relationship(lazy="selectin")


class StoreMembership(UUIDPk, Timestamps, Base):
    __tablename__ = "store_memberships"
    __table_args__ = (UniqueConstraint("user_id", "store_id"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)


class AuthSession(UUIDPk, Timestamps, Base):
    """Server-side session record. Revoking it invalidates the JWT immediately (logout)."""

    __tablename__ = "auth_sessions"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    user_agent: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str | None] = mapped_column(String(64))
