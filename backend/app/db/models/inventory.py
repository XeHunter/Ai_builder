"""Store inventory, batches (all stock lives in batches), adjustments, imports, alerts, staff tasks."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Money, Timestamps, UTCDateTime, UUIDPk, utcnow


class InventoryItem(UUIDPk, Timestamps, Base):
    """Store-level stock for a product. ``quantity_on_hand`` always equals the sum of its batches."""

    __tablename__ = "inventory_items"
    __table_args__ = (UniqueConstraint("store_id", "product_id"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    quantity_on_hand: Mapped[int] = mapped_column(Integer, default=0)
    reorder_point: Mapped[int] = mapped_column(Integer, default=10)
    reorder_quantity: Mapped[int] = mapped_column(Integer, default=24)
    price_override: Mapped[Decimal | None] = mapped_column(Money)

    product = relationship("Product", lazy="joined")
    batches: Mapped[list[InventoryBatch]] = relationship(back_populates="inventory_item", lazy="selectin")


class InventoryBatch(UUIDPk, Timestamps, Base):
    __tablename__ = "inventory_batches"
    __table_args__ = (
        UniqueConstraint("store_id", "product_id", "batch_code"),
        Index("ix_batches_store_expiry", "store_id", "expiry_date"),
    )
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    inventory_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("inventory_items.id", ondelete="CASCADE"))
    batch_code: Mapped[str] = mapped_column(String(64))
    quantity_received: Mapped[int] = mapped_column(Integer)
    quantity_remaining: Mapped[int] = mapped_column(Integer)
    received_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expiry_date: Mapped[date | None] = mapped_column(Date)
    # active|markdown|clearance|expired|depleted|withdrawn
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    markdown_price: Mapped[Decimal | None] = mapped_column(Money)
    markdown_pct: Mapped[int | None] = mapped_column(Integer)
    in_clearance: Mapped[bool] = mapped_column(Boolean, default=False)

    inventory_item: Mapped[InventoryItem] = relationship(back_populates="batches")
    product = relationship("Product", lazy="joined")


class StockAdjustment(UUIDPk, Base):
    """Append-only stock ledger; every quantity change writes one row."""

    __tablename__ = "stock_adjustments"
    __table_args__ = (Index("ix_stock_adj_store_created", "store_id", "created_at"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    batch_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("inventory_batches.id", ondelete="SET NULL"))
    delta: Mapped[int] = mapped_column(Integer)
    quantity_after: Mapped[int] = mapped_column(Integer)
    # receive|import|count_correction|damage|sale|return|expiry_writeoff|manual
    reason: Mapped[str] = mapped_column(String(32))
    note: Mapped[str | None] = mapped_column(String(255))
    reference: Mapped[str | None] = mapped_column(String(64))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ImportJob(UUIDPk, Timestamps, Base):
    __tablename__ = "import_jobs"
    __table_args__ = (UniqueConstraint("merchant_id", "idempotency_key"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    file_sha256: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(80))
    # validated|committing|completed|failed|cancelled
    status: Mapped[str] = mapped_column(String(16), default="validated")
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    valid_rows: Mapped[int] = mapped_column(Integer, default=0)
    error_rows: Mapped[int] = mapped_column(Integer, default=0)
    warning_rows: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[dict] = mapped_column(default=dict)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    committed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class ImportJobRow(UUIDPk, Base):
    __tablename__ = "import_job_rows"
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("import_jobs.id", ondelete="CASCADE"), index=True)
    row_number: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(default=dict)
    normalized: Mapped[dict | None] = mapped_column()
    errors: Mapped[list] = mapped_column(default=list)
    warnings: Mapped[list] = mapped_column(default=list)
    action: Mapped[str] = mapped_column(String(16), default="skip")  # create|update|skip
    is_valid: Mapped[bool] = mapped_column(Boolean, default=False)


class ExpiryAlert(UUIDPk, Timestamps, Base):
    __tablename__ = "expiry_alerts"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("inventory_batches.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    severity: Mapped[str] = mapped_column(String(16))  # warning|critical|expired
    hours_to_expiry: Mapped[int] = mapped_column(Integer)
    quantity_at_alert: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open|acknowledged|resolved
    message: Mapped[str] = mapped_column(Text)
    dedupe_key: Mapped[str] = mapped_column(String(160), unique=True)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    product = relationship("Product", lazy="joined")
    batch = relationship("InventoryBatch", lazy="joined")


class StoreTask(UUIDPk, Timestamps, Base):
    """Operational instruction for store staff (e.g. move a batch to the clearance bin)."""

    __tablename__ = "store_tasks"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    task_type: Mapped[str] = mapped_column(String(32))  # move_to_clearance|relabel_price|remove_expired|restock
    title: Mapped[str] = mapped_column(String(160))
    instruction: Mapped[str] = mapped_column(Text)
    related_entity_type: Mapped[str | None] = mapped_column(String(32))
    related_entity_id: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open|done|cancelled
    dedupe_key: Mapped[str | None] = mapped_column(String(160), unique=True)
    completed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
