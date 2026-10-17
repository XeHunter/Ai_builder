"""Stores, versioned floor layouts, fixtures, shelf locations, walkable graph and placements."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk


class Store(UUIDPk, Timestamps, Base):
    __tablename__ = "stores"
    __table_args__ = (UniqueConstraint("merchant_id", "code"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str] = mapped_column(String(255), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    geofence_radius_m: Mapped[int] = mapped_column(Integer, default=1000)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    merchant = relationship("Merchant", lazy="joined")


class StoreLayout(UUIDPk, Timestamps, Base):
    """A versioned floor plan. Exactly one layout per store is ``active``; ``draft`` layouts are proposals."""

    __tablename__ = "store_layouts"
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)  # active|draft|archived
    based_on_layout_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("store_layouts.id", ondelete="SET NULL"))
    width_m: Mapped[float] = mapped_column(Float)
    height_m: Mapped[float] = mapped_column(Float)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    fixtures: Mapped[list[LayoutFixture]] = relationship(
        back_populates="layout", cascade="all, delete-orphan", lazy="selectin"
    )


class LayoutFixture(UUIDPk, Base):
    __tablename__ = "layout_fixtures"
    __table_args__ = (UniqueConstraint("layout_id", "code"),)
    layout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("store_layouts.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    # aisle_shelf|wall_shelf|endcap|display|chiller|freezer|checkout|entrance|exit|service|clearance
    kind: Mapped[str] = mapped_column(String(24))
    label: Mapped[str] = mapped_column(String(80))
    aisle_code: Mapped[str | None] = mapped_column(String(16), index=True)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    levels: Mapped[int] = mapped_column(Integer, default=1)
    is_chilled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_movable: Mapped[bool] = mapped_column(Boolean, default=False)
    properties: Mapped[dict] = mapped_column(default=dict)

    layout: Mapped[StoreLayout] = relationship(back_populates="fixtures")


class NavNode(UUIDPk, Base):
    __tablename__ = "nav_nodes"
    __table_args__ = (UniqueConstraint("layout_id", "code"),)
    layout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("store_layouts.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    kind: Mapped[str] = mapped_column(String(16), default="walkway")  # entrance|exit|checkout|walkway
    label: Mapped[str | None] = mapped_column(String(80))


class NavEdge(UUIDPk, Base):
    __tablename__ = "nav_edges"
    layout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("store_layouts.id", ondelete="CASCADE"), index=True)
    from_node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nav_nodes.id", ondelete="CASCADE"))
    to_node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nav_nodes.id", ondelete="CASCADE"))
    distance_m: Mapped[float] = mapped_column(Float)
    is_accessible: Mapped[bool] = mapped_column(Boolean, default=True)
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)


class ShelfLocation(UUIDPk, Base):
    __tablename__ = "shelf_locations"
    __table_args__ = (UniqueConstraint("layout_id", "code"),)
    layout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("store_layouts.id", ondelete="CASCADE"), index=True)
    fixture_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("layout_fixtures.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))  # e.g. A3-L-2-4 (aisle-side-section-level)
    aisle_code: Mapped[str | None] = mapped_column(String(16), index=True)
    section: Mapped[int] = mapped_column(Integer, default=1)
    level: Mapped[int] = mapped_column(Integer, default=1)  # 1 = bottom shelf
    height_cm: Mapped[int] = mapped_column(Integer, default=60)
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    capacity_facings: Mapped[int] = mapped_column(Integer, default=6)
    access_node_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("nav_nodes.id", ondelete="SET NULL"))
    is_clearance: Mapped[bool] = mapped_column(Boolean, default=False)

    fixture: Mapped[LayoutFixture] = relationship(lazy="joined")


class ProductPlacement(UUIDPk, Timestamps, Base):
    __tablename__ = "product_placements"
    __table_args__ = (UniqueConstraint("layout_id", "shelf_location_id", "product_id"),)
    layout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("store_layouts.id", ondelete="CASCADE"), index=True)
    shelf_location_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shelf_locations.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    facings: Mapped[int] = mapped_column(Integer, default=1)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)

    shelf_location: Mapped[ShelfLocation] = relationship(lazy="joined")
