from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import Money, ORMModel


class CategoryRef(BaseModel):
    id: str
    name: str


class LocationView(BaseModel):
    shelf_location_id: str
    shelf_code: str
    aisle_code: str | None
    aisle_label: str
    fixture_label: str
    level: int
    x: float
    y: float


class PromotionBadge(BaseModel):
    id: str
    name: str
    price: float
    ends_at: str


class MarkdownBadge(BaseModel):
    price: float
    pct: int | None
    quantity: int
    expiry_date: str | None
    batch_code: str


class ProductCard(BaseModel):
    id: str
    sku: str
    name: str
    brand: str | None
    description: str
    unit: str
    category: CategoryRef | None
    price: float
    promotion: PromotionBadge | None
    markdown: MarkdownBadge | None
    in_stock: bool
    stock_level: str
    location: LocationView | None
    image_url: str | None
    tags: list[str]
    is_perishable: bool
    score: float | None = None
    # assistant / recommendation extras
    reason: str | None = None
    source: str | None = None
    quantity: float | None = None
    line_total: float | None = None
    slot: str | None = None
    visual_similarity: float | None = None


class ProductSearchResponse(BaseModel):
    items: list[ProductCard]
    total: int
    page: int
    page_size: int
    search: dict[str, Any]


class ProductDetailResponse(BaseModel):
    product: ProductCard
    complementary: list[ProductCard]
    complement_reasons: dict[str, str]


class StoreOut(ORMModel):
    id: uuid.UUID
    code: str
    name: str
    address: str
    city: str
    latitude: float
    longitude: float
    geofence_radius_m: int
    merchant_id: uuid.UUID


class CategoryOut(ORMModel):
    id: uuid.UUID
    name: str
    slug: str
    is_perishable: bool
    requires_chilling: bool


class CategoryWithCount(BaseModel):
    id: str
    name: str
    slug: str
    product_count: int


# ---- merchant catalog ---------------------------------------------------------------


class ProductAdminOut(ORMModel):
    id: uuid.UUID
    sku: str
    name: str
    description: str
    category_id: uuid.UUID | None
    category_name: str | None = None
    brand: str | None
    unit: str
    price: Money
    cost_price: Money
    min_allowed_price: Money | None
    target_segment: str | None
    promotion_eligible: bool
    is_perishable: bool
    is_child_product: bool
    weight_kg: float | None
    tags: list[str]
    status: str
    total_stock: int | None = None
    margin_pct: float | None = None


class ProductCreate(BaseModel):
    sku: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-\.]*$")
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=2000)
    category_id: uuid.UUID | None = None
    brand: str | None = Field(default=None, max_length=80)
    unit: str = Field(default="each", max_length=32)
    price: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    cost_price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)
    min_allowed_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    target_segment: str | None = Field(default=None, max_length=64)
    promotion_eligible: bool = True
    is_perishable: bool = False
    is_child_product: bool = False
    weight_kg: float | None = Field(default=None, ge=0, le=500)
    tags: list[str] = Field(default_factory=list, max_length=20)


class ProductUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    category_id: uuid.UUID | None = None
    brand: str | None = Field(default=None, max_length=80)
    unit: str | None = Field(default=None, max_length=32)
    cost_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    min_allowed_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    target_segment: str | None = Field(default=None, max_length=64)
    promotion_eligible: bool | None = None
    is_perishable: bool | None = None
    is_child_product: bool | None = None
    weight_kg: float | None = Field(default=None, ge=0, le=500)
    tags: list[str] | None = Field(default=None, max_length=20)
    status: str | None = Field(default=None, pattern="^(active|archived)$")
