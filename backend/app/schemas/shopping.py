from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.catalog import ProductCard


class AssistantRequest(BaseModel):
    store_id: uuid.UUID
    message: str = Field(min_length=1, max_length=1000)
    context_product_id: uuid.UUID | None = None


class AssistantResponse(BaseModel):
    message: str
    intent: dict[str, Any]
    products: list[ProductCard]
    complementary: list[ProductCard]
    reference: ProductCard | None
    basket: dict[str, Any] | None
    unmatched: list[str]
    directions: list[dict[str, Any]]
    clarifying_question: str | None
    provider: dict[str, Any]
    grounding: dict[str, Any]


class VisualSearchResponse(BaseModel):
    matches: list[ProductCard]
    method: str
    method_description: str
    caption: str | None
    image: dict[str, int]


class ParseRequest(BaseModel):
    store_id: uuid.UUID
    text: str = Field(min_length=1, max_length=4000)


class Candidate(BaseModel):
    product_id: str
    name: str
    price: float
    in_stock: bool
    score: float | None
    location: str | None


class ParsedItemOut(BaseModel):
    raw_text: str
    quantity: float
    unit: str | None
    product_id: str | None
    display_name: str
    confidence: float
    status: str
    needs_review: bool
    candidates: list[Candidate]


class ParseResponse(BaseModel):
    items: list[ParsedItemOut]
    duplicates_merged: list[dict[str, str]]
    unresolved: list[str]
    parser: dict[str, Any]


class ListItemIn(BaseModel):
    raw_text: str | None = Field(default=None, max_length=160)
    skip_match: bool = False  # keep as typed (unresolved) instead of auto-matching
    product_id: uuid.UUID | None = None
    quantity: float = Field(default=1, gt=0, le=1000)
    unit: str | None = Field(default=None, max_length=16)


class ListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    store_id: uuid.UUID | None = None
    raw_input: str | None = Field(default=None, max_length=4000)
    items: list[ListItemIn] = Field(default_factory=list, max_length=100)


class ListUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    store_id: uuid.UUID | None = None
    status: Literal["active", "completed", "archived"] | None = None


class ItemUpdate(BaseModel):
    quantity: float | None = Field(default=None, gt=0, le=1000)
    unit: str | None = Field(default=None, max_length=16)
    product_id: uuid.UUID | None = None
    status: Literal["collected", "pending"] | None = None
    expected_version: int | None = None
    client_event_id: str | None = Field(default=None, max_length=64)


class ListItemView(BaseModel):
    id: str
    raw_text: str
    display_name: str
    product_id: str | None
    quantity: float
    unit: str | None
    status: str
    match_confidence: float | None
    candidates: list[dict[str, Any]]
    position: int
    version: int
    collected_by_id: str | None
    collected_at: str | None
    updated_at: str | None
    product: ProductCard | None


class ListGroup(BaseModel):
    key: str
    label: str
    order: str
    item_ids: list[str]


class ListMember(BaseModel):
    user_id: str
    name: str
    role: str


class ListView(BaseModel):
    id: str
    name: str
    status: str
    is_shared: bool
    version: int
    store: dict[str, str] | None
    raw_input: str | None
    items: list[ListItemView]
    groups: list[ListGroup]
    progress: dict[str, int]
    my_role: str | None
    members: list[ListMember]
    updated_at: str


class ListSummary(BaseModel):
    id: str
    name: str
    status: str
    is_shared: bool
    store_id: str | None
    store_name: str | None
    item_count: int
    collected_count: int
    my_role: str
    updated_at: str


class EventView(BaseModel):
    seq: int
    type: str
    item_id: str | None
    actor_id: str | None
    actor_name: str | None
    payload: dict[str, Any]
    client_event_id: str | None
    created_at: str


class OperationResult(BaseModel):
    event: EventView
    item: dict[str, Any] | None
    list_version: int


class RouteRequest(BaseModel):
    start_x: float | None = Field(default=None, ge=0, le=500)
    start_y: float | None = Field(default=None, ge=0, le=500)
    accessible_only: bool = False
    include_collected: bool = False
    end: Literal["checkout", "exit"] = "checkout"


class ProductRouteRequest(RouteRequest):
    product_ids: list[uuid.UUID] = Field(min_length=1, max_length=40)


class RouteResponse(BaseModel):
    list_id: str | None = None
    store_id: str
    layout_id: str
    list_version: int | None = None
    algorithm: str
    total_distance_m: float
    unoptimized_distance_m: float
    saved_distance_m: float
    stops: list[dict[str, Any]]
    path: list[dict[str, Any]]
    steps: list[dict[str, Any]]
    unrouted: list[dict[str, Any]]
    accessible_only: bool
    positioning: str


class InvitationCreate(BaseModel):
    role: Literal["editor", "viewer"] = "editor"
    ttl_hours: int | None = Field(default=None, ge=1, le=336)
    max_uses: int = Field(default=5, ge=1, le=50)


class InvitationOut(BaseModel):
    id: str
    role: str
    expires_at: str
    max_uses: int
    use_count: int
    revoked: bool
    created_at: str


class InvitationCreated(InvitationOut):
    token: str
    url: str
    qr_svg: str


class InvitationPreview(BaseModel):
    list_name: str
    owner_name: str
    role: str
    expires_at: str
    item_count: int
