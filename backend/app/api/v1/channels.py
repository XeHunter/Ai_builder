"""Channels & connectors: API keys, live orders, POS simulator, sales-history import, and the public
ingestion endpoints that POS / e-commerce systems call with an ``X-Api-Key``."""

from __future__ import annotations

import random
import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, File, Header, Query, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_permission
from app.core.config import get_settings
from app.core.exceptions import NotFoundError, ValidationFailedError
from app.core.rate_limit import rate_limiter
from app.db.models import ApiKey, Store, User
from app.db.session import get_db
from app.integrations.firebase import firebase
from app.services import channel_service
from app.services.channel_service import OrderLine

router = APIRouter(tags=["channels"])


class KeyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    channel: str = Field(pattern="^(pos|ecommerce|payments|other)$")
    provider: str = Field("generic", pattern="^[a-z0-9_]{2,48}$")
    store_id: uuid.UUID | None = None


class SimLine(BaseModel):
    product_id: uuid.UUID
    quantity: int = Field(ge=1, le=50)


class SimulateOrder(BaseModel):
    store_id: uuid.UUID
    channel: str = Field("pos", pattern="^(pos|self_checkout|online)$")
    lines: list[SimLine] = Field(default_factory=list, max_length=30)
    payment_method: str = Field("upi", pattern="^(card|upi|cash|wallet)$")


class OrderLineIn(BaseModel):
    sku: str | None = Field(default=None, max_length=64)
    product_id: uuid.UUID | None = None
    quantity: int = Field(ge=1, le=1000)
    unit_price: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)


class OrderIn(BaseModel):
    external_id: str | None = Field(default=None, max_length=40, description="Your bill/order number (idempotency key)")
    store_code: str | None = Field(default=None, max_length=32)
    channel: str = Field("pos", pattern="^(pos|self_checkout|online)$")
    occurred_at: datetime | None = None
    payment_method: str = Field("card", max_length=16)
    terminal_id: str | None = Field(default=None, max_length=32)
    items: list[OrderLineIn] = Field(min_length=1, max_length=200)


def _base_url(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-host")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{proto}://{fwd}" if fwd else str(request.base_url).rstrip("/")


# ------------------------------------------------------------------------------- merchant side


@router.get("/merchant/channels")
def overview(request: Request, ctx: MerchantContext = Depends(require_permission("insights.read")),
             db: Session = Depends(get_db)) -> dict:
    keys = db.scalars(select(ApiKey).where(ApiKey.merchant_id == ctx.merchant_id).order_by(ApiKey.created_at.desc())).all()
    codes = {s.id: s.code for s in db.scalars(select(Store).where(Store.merchant_id == ctx.merchant_id))}
    base = _base_url(request)
    return {
        "connectors": channel_service.CONNECTORS,
        "keys": [channel_service.key_view(k, codes.get(k.store_id)) for k in keys],
        "today": channel_service.channel_stats(db, ctx.merchant_id, days=1),
        "realtime": "firestore" if firebase.available() else "polling",
        "endpoints": {
            "orders": f"{base}/api/v1/ingest/orders",
            "shopify_orders": f"{base}/api/v1/ingest/shopify/orders",
            "catalog_feed": f"{base}/api/v1/ingest/catalog",
        },
    }


@router.post("/merchant/channels/keys", status_code=status.HTTP_201_CREATED)
def create_key(body: KeyCreate, ctx: MerchantContext = Depends(require_permission("integrations.manage")),
               db: Session = Depends(get_db)) -> dict:
    """Create an API key for a POS / storefront. The secret is returned once and never stored in clear."""
    store = get_store_scoped(db, ctx, body.store_id) if body.store_id else None
    key, raw = channel_service.create_api_key(db, merchant_id=ctx.merchant_id, store=store, name=body.name,
                                              channel=body.channel, provider=body.provider, actor=ctx.user)
    return {**channel_service.key_view(key, store.code if store else None), "secret": raw}


@router.delete("/merchant/channels/keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_key(key_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("integrations.manage")),
               db: Session = Depends(get_db)) -> None:
    key = db.get(ApiKey, key_id)
    if key is None or key.merchant_id != ctx.merchant_id:
        raise NotFoundError("API key not found")
    from datetime import UTC

    key.revoked_at = key.revoked_at or datetime.now(UTC)
    db.commit()


@router.get("/merchant/channels/orders")
def orders(store_id: uuid.UUID | None = None, limit: int = Query(25, ge=1, le=100),
           ctx: MerchantContext = Depends(require_permission("insights.read")), db: Session = Depends(get_db)) -> list[dict]:
    """Most recent orders across channels (the live feed's history; new ones also arrive via Firestore)."""
    if store_id:
        get_store_scoped(db, ctx, store_id)
        ids = [store_id]
    else:
        ids = None if ctx.all_stores else list(ctx.store_ids)
    return channel_service.recent_orders(db, ctx.merchant_id, ids, limit)


@router.post("/merchant/channels/simulate", status_code=status.HTTP_201_CREATED)
def simulate(body: SimulateOrder, ctx: MerchantContext = Depends(require_permission("inventory.write")),
             db: Session = Depends(get_db)) -> dict:
    """POS / online simulator: rings up a bill through exactly the same path as a real connector."""
    store = get_store_scoped(db, ctx, body.store_id)
    lines = ([OrderLine(quantity=ln.quantity, product_id=ln.product_id) for ln in body.lines]
             or channel_service.random_basket(db, store, random.Random()))
    return channel_service.ingest_order(
        db, merchant_id=ctx.merchant_id, store=store, channel=body.channel, external_id=None, lines=lines,
        payment_method=body.payment_method, source="simulator", is_simulated=True, actor=ctx.user,
        terminal_id="SIM-POS-1" if body.channel == "pos" else ("SCO-SIM" if body.channel == "self_checkout" else "WEB"))


@router.post("/merchant/channels/sales-history")
async def import_history(file: UploadFile = File(...),
                         ctx: MerchantContext = Depends(require_permission("inventory.import")),
                         db: Session = Depends(get_db)) -> dict:
    """Backfill past bills from any POS export (CSV). History only - stock is not changed."""
    content = await file.read(get_settings().max_upload_bytes + 1)
    if len(content) > get_settings().max_upload_bytes:
        raise ValidationFailedError(f"File is larger than {get_settings().max_upload_mb} MB")
    allowed = None if ctx.all_stores else set(ctx.store_ids)
    return channel_service.import_sales_history(db, merchant_id=ctx.merchant_id, allowed_store_ids=allowed,
                                                content=content, actor=ctx.user)


# ------------------------------------------------------------------- public (API-key) ingestion


def _key(request: Request, db: Session, x_api_key: str | None) -> ApiKey:
    rate_limiter.hit(f"ingest:{(x_api_key or '')[:12]}", 600)
    return channel_service.authenticate_key(db, x_api_key)


def _ingest(db: Session, key: ApiKey, body: OrderIn, source: str) -> dict:
    store = channel_service.resolve_store(db, key.merchant_id, body.store_code, key.store_id)
    actor = db.get(User, key.created_by_id) if key.created_by_id else None
    return channel_service.ingest_order(
        db, merchant_id=key.merchant_id, store=store, channel=body.channel, external_id=body.external_id,
        lines=[OrderLine(quantity=i.quantity, sku=i.sku, product_id=i.product_id, unit_price=i.unit_price) for i in body.items],
        occurred_at=body.occurred_at, payment_method=body.payment_method, terminal_id=body.terminal_id,
        source=source, actor=actor)


@router.post("/ingest/orders", status_code=status.HTTP_201_CREATED)
def ingest_orders(body: OrderIn, request: Request, x_api_key: str | None = Header(default=None),
                  db: Session = Depends(get_db)) -> dict:
    """Push a bill / order from any POS or storefront. Idempotent on ``external_id``.

    ``curl -X POST $BASE/api/v1/ingest/orders -H "X-Api-Key: op_live_..." -H "Content-Type: application/json"
    -d '{"external_id":"BILL-1001","store_code":"AND01","channel":"pos","items":[{"sku":"MLK-001","quantity":2}]}'``
    """
    key = _key(request, db, x_api_key)
    return _ingest(db, key, body, source=f"{key.provider} ({key.name})")


@router.post("/ingest/shopify/orders", status_code=status.HTTP_201_CREATED)
async def ingest_shopify(request: Request, store_code: str | None = Query(None, max_length=32),
                         x_api_key: str | None = Header(default=None), db: Session = Depends(get_db)) -> dict:
    """Shopify ``orders/create`` webhook. Configure the webhook URL with ``?store_code=`` (or bind the key
    to a store) and send the API key as ``X-Api-Key`` (or ``?api_key=`` where headers cannot be set)."""
    key = _key(request, db, x_api_key or request.query_params.get("api_key"))
    payload = await request.json()
    ref, lines, created, gateway = channel_service.lines_from_shopify(payload)
    store = channel_service.resolve_store(db, key.merchant_id, store_code, key.store_id)
    actor = db.get(User, key.created_by_id) if key.created_by_id else None
    return channel_service.ingest_order(db, merchant_id=key.merchant_id, store=store, channel="online",
                                        external_id=ref, lines=lines, occurred_at=created, payment_method=gateway,
                                        source="shopify", actor=actor)


@router.get("/ingest/catalog")
def catalog(request: Request, store_code: str | None = Query(None, max_length=32),
            updated_since: datetime | None = None, x_api_key: str | None = Header(default=None),
            db: Session = Depends(get_db)) -> dict:
    """Catalog feed for an online store: selling price (promotions / markdowns applied), stock, shelf."""
    key = _key(request, db, x_api_key)
    store = channel_service.resolve_store(db, key.merchant_id, store_code, key.store_id)
    db.commit()  # persist key usage
    return channel_service.catalog_feed(db, store, updated_since)
