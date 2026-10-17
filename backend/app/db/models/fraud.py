"""Fraud rules, alerts, human investigations and (synthetic) ground-truth labels."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk, utcnow


class FraudRule(UUIDPk, Timestamps, Base):
    __tablename__ = "fraud_rules"
    __table_args__ = (UniqueConstraint("merchant_id", "code"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(48))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    weight: Mapped[int] = mapped_column(Integer, default=20)
    params: Mapped[dict] = mapped_column(default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class FraudAlert(UUIDPk, Timestamps, Base):
    __tablename__ = "fraud_alerts"
    __table_args__ = (UniqueConstraint("merchant_id", "dedupe_key"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sales_transactions.id", ondelete="CASCADE"), index=True
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    subject_type: Mapped[str] = mapped_column(String(16))  # transaction|customer|inventory
    subject_ref: Mapped[str] = mapped_column(String(80))
    rule_score: Mapped[float] = mapped_column(Float)
    anomaly_score: Mapped[float | None] = mapped_column(Float)
    risk_score: Mapped[float] = mapped_column(Float, index=True)
    risk_level: Mapped[str] = mapped_column(String(8))  # low|medium|high
    signals: Mapped[list] = mapped_column(default=list)
    summary: Mapped[str] = mapped_column(Text)
    # open|in_review|escalated|closed
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)
    # confirmed_fraud|false_positive|inconclusive (set when closed by a human reviewer)
    outcome: Mapped[str | None] = mapped_column(String(24))
    dedupe_key: Mapped[str] = mapped_column(String(160))
    detected_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    investigation: Mapped[FraudInvestigation | None] = relationship(
        back_populates="alert", uselist=False, lazy="selectin"
    )


class FraudInvestigation(UUIDPk, Timestamps, Base):
    __tablename__ = "fraud_investigations"
    alert_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("fraud_alerts.id", ondelete="CASCADE"), unique=True)
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|closed
    outcome: Mapped[str | None] = mapped_column(String(24))
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    alert: Mapped[FraudAlert] = relationship(back_populates="investigation")
    notes: Mapped[list[InvestigationNote]] = relationship(
        lazy="selectin", order_by="InvestigationNote.created_at", cascade="all, delete-orphan"
    )


class InvestigationNote(UUIDPk, Base):
    __tablename__ = "investigation_notes"
    investigation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("fraud_investigations.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    note: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    author = relationship("User", lazy="joined")


class FraudLabel(UUIDPk, Base):
    """Ground truth used only for evaluation. Seeded synthetic labels are marked ``source='synthetic'``."""

    __tablename__ = "fraud_labels"
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sales_transactions.id", ondelete="CASCADE"), unique=True
    )
    is_fraud: Mapped[bool] = mapped_column(Boolean)
    scenario: Mapped[str | None] = mapped_column(String(48))
    source: Mapped[str] = mapped_column(String(16), default="synthetic")
