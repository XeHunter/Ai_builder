"""Sales and return transactions, account-security events and weather records."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, Float, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Money, UTCDateTime, UUIDPk, utcnow


class SalesTransaction(UUIDPk, Base):
    __tablename__ = "sales_transactions"
    __table_args__ = (
        Index("ix_sales_store_time", "store_id", "occurred_at"),
        Index("ix_sales_merchant_time", "merchant_id", "occurred_at"),
        Index("ix_sales_receipt", "merchant_id", "receipt_number"),
    )
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"))
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    customer_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    channel: Mapped[str] = mapped_column(String(16))  # pos|self_checkout|online
    transaction_type: Mapped[str] = mapped_column(String(8))  # sale|return
    receipt_number: Mapped[str] = mapped_column(String(40))
    original_transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sales_transactions.id", ondelete="SET NULL")
    )
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime())
    subtotal: Mapped[Decimal] = mapped_column(Money)
    discount_total: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    total: Mapped[Decimal] = mapped_column(Money)
    payment_method: Mapped[str] = mapped_column(String(16), default="card")
    terminal_id: Mapped[str | None] = mapped_column(String(32))
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=False)

    items: Mapped[list[TransactionItem]] = relationship(back_populates="transaction", lazy="selectin")


class TransactionItem(UUIDPk, Base):
    __tablename__ = "transaction_items"
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sales_transactions.id", ondelete="CASCADE"), index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    quantity: Mapped[int] = mapped_column(Integer)  # quantity charged
    # Self-checkout only: quantity detected by the (simulated) bagging scale. A detected quantity
    # higher than the charged quantity is a fraud *signal*, never proof.
    detected_quantity: Mapped[int | None] = mapped_column(Integer)
    unit_price: Mapped[Decimal] = mapped_column(Money)
    discount: Mapped[Decimal] = mapped_column(Money, default=Decimal("0"))
    line_total: Mapped[Decimal] = mapped_column(Money)

    transaction: Mapped[SalesTransaction] = relationship(back_populates="items")


class AccountSecurityEvent(UUIDPk, Base):
    __tablename__ = "account_security_events"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(32))  # failed_login|password_reset|new_device|email_change
    ip_address: Mapped[str | None] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=False)


class WeatherRecord(UUIDPk, Base):
    __tablename__ = "weather_records"
    __table_args__ = (UniqueConstraint("store_id", "date", "is_forecast"),)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date)
    temp_max_c: Mapped[float] = mapped_column(Float)
    temp_min_c: Mapped[float] = mapped_column(Float)
    precipitation_mm: Mapped[float] = mapped_column(Float)
    condition: Mapped[str] = mapped_column(String(24))  # clear|cloudy|rain|heavy_rain|storm
    is_forecast: Mapped[bool] = mapped_column(Boolean, default=False)
    source: Mapped[str] = mapped_column(String(24))  # simulated|openweathermap
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
