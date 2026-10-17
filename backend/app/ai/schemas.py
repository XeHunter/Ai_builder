"""Structured outputs exchanged with AI providers. Every provider output is validated against these."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

IntentName = Literal[
    "find_products",
    "budget_basket",
    "locate_product",
    "complementary",
    "similar_product",
    "clarify",
    "greeting",
    "unsupported",
]


class ShoppingIntent(BaseModel):
    intent: IntentName
    search_queries: list[str] = Field(default_factory=list, max_length=12)
    occasion: str | None = None
    budget: float | None = Field(default=None, ge=0)
    people: int | None = Field(default=None, ge=1, le=50)
    max_unit_price: float | None = Field(default=None, ge=0)
    reference_product: str | None = None
    clarifying_question: str | None = None


class ParsedListItem(BaseModel):
    text: str = Field(min_length=1, max_length=160)
    quantity: float = Field(default=1, gt=0, le=1000)
    unit: str | None = None


class ParsedList(BaseModel):
    items: list[ParsedListItem] = Field(default_factory=list, max_length=100)


class ComposedReply(BaseModel):
    message: str = Field(max_length=2000)
    highlight_product_ids: list[str] = Field(default_factory=list)


class ImageDescription(BaseModel):
    caption: str
    keywords: list[str] = Field(default_factory=list)


class BriefAction(BaseModel):
    title: str = Field(min_length=3, max_length=120)
    detail: str = Field(max_length=400)
    priority: Literal["high", "medium", "low"] = "medium"
    fact_ids: list[str] = Field(default_factory=list, max_length=6)


class OperationsBrief(BaseModel):
    headline: str = Field(max_length=240)
    actions: list[BriefAction] = Field(default_factory=list, max_length=5)
