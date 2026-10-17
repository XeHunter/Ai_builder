"""Notifications, consent/preferences, geofence events, audit log, integrations and background jobs."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk, utcnow


class Notification(UUIDPk, Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_created", "user_id", "created_at"),)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    merchant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    # shared_list|shopping_reminder|nearby_offer|expiry_alert|stockout_alert|pricing_approval|promotion|fraud_review
    notification_type: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(255))
    data: Mapped[dict] = mapped_column(default=dict)
    channel: Mapped[str] = mapped_column(String(16), default="in_app")
    delivery_status: Mapped[str] = mapped_column(String(16), default="delivered")  # delivered|failed|skipped
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class NotificationPreference(Timestamps, Base):
    __tablename__ = "notification_preferences"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    in_app_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    email_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    sms_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    marketing_opt_in: Mapped[bool] = mapped_column(Boolean, default=False)
    location_consent: Mapped[bool] = mapped_column(Boolean, default=False)
    location_consent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    abandoned_list_reminders: Mapped[bool] = mapped_column(Boolean, default=True)
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=240)


class GeofenceEvent(UUIDPk, Base):
    __tablename__ = "geofence_events"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    event_type: Mapped[str] = mapped_column(String(16))  # enter|exit|outside
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    distance_m: Mapped[float] = mapped_column(Float)
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=True)
    outcome: Mapped[dict] = mapped_column(default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AuditEvent(UUIDPk, Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_merchant_created", "merchant_id", "created_at"),
        Index("ix_audit_entity", "entity_type", "entity_id"),
    )
    merchant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_label: Mapped[str] = mapped_column(String(160), default="system")
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(48))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    summary: Mapped[str] = mapped_column(Text, default="")
    before: Mapped[dict | None] = mapped_column()
    after: Mapped[dict | None] = mapped_column()
    request_id: Mapped[str | None] = mapped_column(String(64))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class IntegrationConfig(UUIDPk, Timestamps, Base):
    """Per-merchant integration settings. Secrets are never stored here; they come from env vars."""

    __tablename__ = "integration_configs"
    __table_args__ = (UniqueConstraint("merchant_id", "kind"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # weather|pos|ecommerce|payments|pricing_publisher|email|sms|push
    provider: Mapped[str] = mapped_column(String(48))
    mode: Mapped[str] = mapped_column(String(16), default="simulated")  # simulated|live|disabled
    settings: Mapped[dict] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="ok")
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_error: Mapped[str | None] = mapped_column(Text)


class JobRun(UUIDPk, Timestamps, Base):
    """Durable background job record (queue + status tracking)."""

    __tablename__ = "job_runs"
    __table_args__ = (Index("ix_jobs_status_scheduled", "status", "scheduled_for"),)
    job_type: Mapped[str] = mapped_column(String(48))
    merchant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    payload: Mapped[dict] = mapped_column(default=dict)
    # queued|running|succeeded|failed
    status: Mapped[str] = mapped_column(String(16), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    dedupe_key: Mapped[str | None] = mapped_column(String(160), index=True)
    scheduled_for: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    result: Mapped[dict | None] = mapped_column()
    error: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class ApiKey(UUIDPk, Timestamps, Base):
    """Credential a POS, e-commerce platform or other system uses to push sales/orders (``X-Api-Key``).

    Only a SHA-256 hash is stored; the key is shown once at creation. ``prefix`` identifies it in the UI.
    """

    __tablename__ = "api_keys"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(80))
    # pos|ecommerce|payments|other - which connector the key belongs to
    channel: Mapped[str] = mapped_column(String(16))
    provider: Mapped[str] = mapped_column(String(48), default="generic")
    prefix: Mapped[str] = mapped_column(String(16))
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
