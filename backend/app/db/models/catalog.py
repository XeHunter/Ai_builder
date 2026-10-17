"""Product catalog: categories, products, images, embeddings and product relations."""

from __future__ import annotations

import uuid
from decimal import Decimal

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Money, Timestamps, UUIDPk


class ProductCategory(UUIDPk, Timestamps, Base):
    __tablename__ = "product_categories"
    __table_args__ = (UniqueConstraint("merchant_id", "slug"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    slug: Mapped[str] = mapped_column(String(80))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("product_categories.id", ondelete="SET NULL"))
    is_perishable: Mapped[bool] = mapped_column(Boolean, default=False)
    requires_chilling: Mapped[bool] = mapped_column(Boolean, default=False)


class Product(UUIDPk, Timestamps, Base):
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("merchant_id", "sku"),
        Index("ix_products_merchant_name", "merchant_id", "name"),
    )
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    sku: Mapped[str] = mapped_column(String(64))  # "product_id" in the import format
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("product_categories.id", ondelete="SET NULL"), index=True
    )
    brand: Mapped[str | None] = mapped_column(String(80))
    unit: Mapped[str] = mapped_column(String(32), default="each")
    price: Mapped[Decimal] = mapped_column(Money)
    cost_price: Mapped[Decimal] = mapped_column(Money)
    min_allowed_price: Mapped[Decimal | None] = mapped_column(Money)
    target_segment: Mapped[str | None] = mapped_column(String(64))
    promotion_eligible: Mapped[bool] = mapped_column(Boolean, default=True)
    is_perishable: Mapped[bool] = mapped_column(Boolean, default=False)
    is_child_product: Mapped[bool] = mapped_column(Boolean, default=False)
    weight_kg: Mapped[float | None] = mapped_column(Float)
    tags: Mapped[list] = mapped_column(default=list)
    attributes: Mapped[dict] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    search_text: Mapped[str] = mapped_column(Text, default="")

    category: Mapped[ProductCategory | None] = relationship(lazy="joined")
    images: Mapped[list[ProductImage]] = relationship(
        back_populates="product", cascade="all, delete-orphan", lazy="selectin"
    )


class ProductImage(UUIDPk, Timestamps, Base):
    __tablename__ = "product_images"
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    file_path: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(64), default="image/png")
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    # Deterministic visual descriptor (colour histogram + spatial layout), see app/ai/visual_search.
    features: Mapped[list] = mapped_column(default=list)
    feature_version: Mapped[str] = mapped_column(String(32), default="")

    product: Mapped[Product] = relationship(back_populates="images")


class ProductEmbedding(UUIDPk, Timestamps, Base):
    """Text embedding of a product with the model metadata needed to detect stale vectors."""

    __tablename__ = "product_embeddings"
    __table_args__ = (UniqueConstraint("product_id", "model"),)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(80), index=True)
    dimensions: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    vector: Mapped[list] = mapped_column(default=list)


class ProductRelation(UUIDPk, Timestamps, Base):
    """Merchant-curated relationships, e.g. a memory card that is compatible with a camera."""

    __tablename__ = "product_relations"
    __table_args__ = (UniqueConstraint("product_id", "related_product_id", "relation_type"),)
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    related_product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    relation_type: Mapped[str] = mapped_column(String(32))  # compatible_accessory|complement|substitute
    note: Mapped[str | None] = mapped_column(String(255))
