"""Shopping lists, collaborative membership, invitations and the list event log."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk, utcnow


class ShoppingList(UUIDPk, Timestamps, Base):
    __tablename__ = "shopping_lists"
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="SET NULL"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    raw_input: Mapped[str | None] = mapped_column(Text)
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|completed|archived
    # Monotonic sequence number; incremented on every event. Clients resync from it.
    version: Mapped[int] = mapped_column(Integer, default=0)

    items: Mapped[list[ShoppingListItem]] = relationship(
        back_populates="shopping_list", cascade="all, delete-orphan", lazy="selectin",
        order_by="ShoppingListItem.position",
    )


class ShoppingListItem(UUIDPk, Timestamps, Base):
    __tablename__ = "shopping_list_items"
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shopping_lists.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    raw_text: Mapped[str] = mapped_column(String(160))
    display_name: Mapped[str] = mapped_column(String(160))
    quantity: Mapped[float] = mapped_column(Float, default=1)
    unit: Mapped[str | None] = mapped_column(String(16))
    # pending|collected|unavailable|unresolved
    status: Mapped[str] = mapped_column(String(16), default="pending")
    match_confidence: Mapped[float | None] = mapped_column(Float)
    candidates: Mapped[list] = mapped_column(default=list)
    position: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    added_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    collected_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    collected_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    shopping_list: Mapped[ShoppingList] = relationship(back_populates="items")
    product = relationship("Product", lazy="joined")


class ListMembership(UUIDPk, Timestamps, Base):
    __tablename__ = "list_memberships"
    __table_args__ = (UniqueConstraint("list_id", "user_id"),)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shopping_lists.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default="editor")  # owner|editor|viewer
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    user = relationship("User", lazy="joined")


class ListInvitation(UUIDPk, Timestamps, Base):
    __tablename__ = "list_invitations"
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shopping_lists.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    role: Mapped[str] = mapped_column(String(16), default="editor")
    created_by_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    max_uses: Mapped[int] = mapped_column(Integer, default=5)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class ShoppingListEvent(UUIDPk, Base):
    __tablename__ = "shopping_list_events"
    __table_args__ = (
        UniqueConstraint("list_id", "seq"),
        Index("ix_list_events_list_seq", "list_id", "seq"),
    )
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shopping_lists.id", ondelete="CASCADE"))
    seq: Mapped[int] = mapped_column(Integer)
    # item_added|item_updated|item_removed|item_collected|item_uncollected|member_joined|list_updated
    event_type: Mapped[str] = mapped_column(String(32))
    item_id: Mapped[uuid.UUID | None] = mapped_column()
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    payload: Mapped[dict] = mapped_column(default=dict)
    client_event_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
