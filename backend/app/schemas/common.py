"""Shared schema primitives."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

T = TypeVar("T")

# Money is held as Decimal internally and serialised as a JSON number (2 dp) for the frontend.
Money = Annotated[Decimal, PlainSerializer(lambda v: float(round(v, 2)), return_type=float, when_used="json")]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class PageParams(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(25, ge=1, le=200)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


class Message(BaseModel):
    message: str


class DataProvenance(BaseModel):
    """Attached to analytics outputs so the UI can label how a number was produced."""

    method: str  # deterministic_rule|heuristic|statistical_model|ml_model|llm|simulated
    description: str
    simulated_inputs: list[str] = []
