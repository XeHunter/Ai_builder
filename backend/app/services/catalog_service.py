"""Catalog search and shopper-facing product views.

Search is hybrid: a weighted lexical score over name/brand/category/tags/description plus cosine
similarity of text embeddings (when an index exists for the active embedding model). Product cards
are always built from database facts: effective price, active promotion, short-dated markdowns,
stock level and shelf location from the store's *active* layout.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai import lexicon
from app.ai.embeddings.service import embed_query, load_matrix
from app.ai.providers import get_ai_provider
from app.db.models import (
    InventoryBatch,
    InventoryItem,
    Product,
    ProductPlacement,
    Promotion,
    PromotionProduct,
    SalesTransaction,
    ShelfLocation,
    Store,
    StoreLayout,
    TransactionItem,
)

SELLABLE_BATCH_STATUSES = ("active", "markdown", "clearance")


@dataclass
class _IndexedProduct:
    id: uuid.UUID
    fields: dict[str, set[str]]
    name_norm: str
    sku: str
    tag_phrases: set[str] = field(default_factory=set)


@dataclass
class _MerchantIndex:
    stamp: tuple
    products: dict[uuid.UUID, _IndexedProduct] = field(default_factory=dict)
    emb_ids: list[uuid.UUID] = field(default_factory=list)
    emb_matrix: np.ndarray | None = None
    emb_model: str = ""


_index_cache: dict[uuid.UUID, _MerchantIndex] = {}
_index_lock = threading.Lock()

FIELD_WEIGHTS = {"name": 3.0, "brand": 2.0, "category": 2.0, "tags": 2.0, "description": 0.8}


def _build_index(db: Session, merchant_id: uuid.UUID) -> _MerchantIndex:
    provider = get_ai_provider()
    stamp = tuple(
        db.execute(
            select(func.count(Product.id), func.max(Product.updated_at)).where(
                Product.merchant_id == merchant_id, Product.status == "active"
            )
        ).one()
    ) + (provider.embedding_model,)
    with _index_lock:
        cached = _index_cache.get(merchant_id)
        if cached and cached.stamp == stamp:
            return cached
    products = db.scalars(select(Product).where(Product.merchant_id == merchant_id, Product.status == "active")).all()
    idx = _MerchantIndex(stamp=stamp)
    for p in products:
        idx.products[p.id] = _IndexedProduct(
            id=p.id,
            fields={
                "name": set(lexicon.tokens(p.name)),
                "brand": set(lexicon.tokens(p.brand or "")),
                "category": set(lexicon.tokens(p.category.name if p.category else "")),
                "tags": set(lexicon.tokens(" ".join(p.tags or []))),
                "description": set(lexicon.tokens(p.description or "")),
            },
            name_norm=lexicon.normalize(p.name),
            sku=p.sku.lower(),
            tag_phrases={lexicon.normalize(t) for t in (p.tags or [])} | (
                {lexicon.normalize(p.category.name)} if p.category else set()),
        )
    idx.emb_ids, idx.emb_matrix = load_matrix(db, list(idx.products), provider.embedding_model)
    idx.emb_model = provider.embedding_model
    with _index_lock:
        _index_cache[merchant_id] = idx
    return idx


def invalidate_index(merchant_id: uuid.UUID) -> None:
    with _index_lock:
        _index_cache.pop(merchant_id, None)


def _lexical(q_tokens: list[str], q_norm: str, p: _IndexedProduct) -> float:
    if not q_tokens:
        return 0.0
    if q_norm == p.sku:
        return 1.0
    total = 0.0
    for t in q_tokens:
        best = 0.0
        for fname, ftoks in p.fields.items():
            w = FIELD_WEIGHTS[fname]
            if t in ftoks:
                best = max(best, w)
            elif len(t) >= 4 and any(ft.startswith(t) or (len(ft) >= 4 and t.startswith(ft)) for ft in ftoks):
                best = max(best, 0.6 * w)
        total += best
    score = total / (FIELD_WEIGHTS["name"] * len(q_tokens))
    if q_norm and q_norm in p.name_norm:
        score += 0.25
    score = min(score, 1.25)
    # Exact tag/category phrase: "milk" prefers products tagged milk over "Dairy Milk" chocolate.
    if q_norm and (q_norm in p.tag_phrases or lexicon.stem(q_norm) in p.tag_phrases):
        score += 0.3
    return score


@dataclass
class SearchHit:
    product_id: uuid.UUID
    score: float
    lexical: float
    semantic: float | None


def search(
    db: Session,
    merchant_id: uuid.UUID,
    query: str,
    *,
    limit: int = 20,
    min_score: float = 0.18,
    candidate_ids: set[uuid.UUID] | None = None,
) -> list[SearchHit]:
    idx = _build_index(db, merchant_id)
    expanded = lexicon.expand_query(query)
    q_tokens = lexicon.tokens(expanded)
    q_norm = lexicon.normalize(query)
    sem: dict[uuid.UUID, float] = {}
    if idx.emb_matrix is not None and q_tokens:
        qv = embed_query(expanded)
        if qv is not None and qv.shape[0] == idx.emb_matrix.shape[1]:
            sims = idx.emb_matrix @ qv
            sem = {pid: float(s) for pid, s in zip(idx.emb_ids, sims, strict=True)}
    hits: list[SearchHit] = []
    for pid, p in idx.products.items():
        if candidate_ids is not None and pid not in candidate_ids:
            continue
        lex = _lexical(q_tokens, q_norm, p)
        s = sem.get(pid)
        score = lex if s is None else 0.7 * lex + 0.3 * max(0.0, s)
        if lex == 0 and (s is None or s < 0.45):
            continue
        if score >= min_score:
            hits.append(SearchHit(pid, round(score, 4), round(lex, 4), None if s is None else round(s, 4)))
    hits.sort(key=lambda h: (-h.score, str(h.product_id)))
    return hits[:limit]


# ---------------------------------------------------------------------------
# Store facts
# ---------------------------------------------------------------------------

def active_layout(db: Session, store_id: uuid.UUID) -> StoreLayout | None:
    return db.scalars(
        select(StoreLayout).where(StoreLayout.store_id == store_id, StoreLayout.status == "active")
        .order_by(StoreLayout.version.desc())
    ).first()


def product_locations(db: Session, layout_id: uuid.UUID | None, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, ShelfLocation]:
    if layout_id is None or not product_ids:
        return {}
    rows = db.execute(
        select(ProductPlacement.product_id, ShelfLocation)
        .join(ShelfLocation, ShelfLocation.id == ProductPlacement.shelf_location_id)
        .where(ProductPlacement.layout_id == layout_id, ProductPlacement.product_id.in_(product_ids))
        .order_by(ProductPlacement.is_primary.desc())
    ).all()
    out: dict[uuid.UUID, ShelfLocation] = {}
    for pid, loc in rows:
        out.setdefault(pid, loc)
    return out


def location_view(loc: ShelfLocation | None) -> dict | None:
    if loc is None:
        return None
    fx = loc.fixture
    aisle_label = f"Aisle {loc.aisle_code[1:]}" if loc.aisle_code and loc.aisle_code.startswith("A") else fx.label
    return {
        "shelf_location_id": str(loc.id),
        "shelf_code": loc.code,
        "aisle_code": loc.aisle_code,
        "aisle_label": aisle_label,
        "fixture_label": fx.label,
        "level": loc.level,
        "x": loc.x,
        "y": loc.y,
    }


def sell_by_cutoff(today: date | None = None) -> date:
    return today or datetime.now(UTC).date()


def stock_snapshot(db: Session, store_id: uuid.UUID, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """Sellable quantity (non-expired batches) and the best active markdown per product."""
    if not product_ids:
        return {}
    today = sell_by_cutoff()
    out: dict[uuid.UUID, dict] = {
        pid: {"qty": 0, "markdown": None, "reorder_point": 0, "price_override": None} for pid in product_ids
    }
    for item in db.scalars(
        select(InventoryItem).where(InventoryItem.store_id == store_id, InventoryItem.product_id.in_(product_ids))
    ):
        out[item.product_id]["reorder_point"] = item.reorder_point
        out[item.product_id]["price_override"] = item.price_override
    batches = db.scalars(
        select(InventoryBatch).where(
            InventoryBatch.store_id == store_id,
            InventoryBatch.product_id.in_(product_ids),
            InventoryBatch.quantity_remaining > 0,
            InventoryBatch.status.in_(SELLABLE_BATCH_STATUSES),
        )
    ).all()
    for b in batches:
        if b.expiry_date is not None and b.expiry_date < today:
            continue
        o = out[b.product_id]
        o["qty"] += b.quantity_remaining
        if b.markdown_price is not None and (o["markdown"] is None or b.markdown_price < Decimal(str(o["markdown"]["price"]))):
            o["markdown"] = {
                "price": float(b.markdown_price),
                "pct": b.markdown_pct,
                "quantity": b.quantity_remaining,
                "expiry_date": b.expiry_date.isoformat() if b.expiry_date else None,
                "batch_code": b.batch_code,
            }
    return out


def active_promotions(db: Session, store: Store, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, Promotion]:
    if not product_ids:
        return {}
    now = datetime.now(UTC)
    rows = db.execute(
        select(PromotionProduct.product_id, Promotion)
        .join(Promotion, Promotion.id == PromotionProduct.promotion_id)
        .where(
            Promotion.merchant_id == store.merchant_id,
            Promotion.status == "active",
            Promotion.is_simulation.is_(False),
            Promotion.starts_at <= now,
            Promotion.ends_at > now,
            (Promotion.store_id.is_(None)) | (Promotion.store_id == store.id),
            PromotionProduct.product_id.in_(product_ids),
        )
    ).all()
    out: dict[uuid.UUID, Promotion] = {}
    for pid, promo in rows:
        if promo.usage_limit is not None and promo.usage_count >= promo.usage_limit:
            continue
        out.setdefault(pid, promo)
    return out


def promo_price(price: Decimal, promo: Promotion, floor: Decimal | None) -> Decimal:
    if promo.promo_type == "percent_off":
        new = price * (Decimal(100) - promo.discount_value) / Decimal(100)
    else:
        new = price - promo.discount_value
    new = new.quantize(Decimal("0.01"))
    if floor is not None and new < floor:
        new = floor
    return max(new, Decimal("0.01"))


def popularity(db: Session, store_id: uuid.UUID, days: int = 30) -> dict[uuid.UUID, int]:
    since = datetime.now(UTC) - timedelta(days=days)
    rows = db.execute(
        select(TransactionItem.product_id, func.sum(TransactionItem.quantity))
        .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
        .where(SalesTransaction.store_id == store_id, SalesTransaction.occurred_at >= since,
               SalesTransaction.transaction_type == "sale")
        .group_by(TransactionItem.product_id)
    ).all()
    return {pid: int(q or 0) for pid, q in rows}


def product_cards(db: Session, store: Store, products: list[Product], scores: dict[uuid.UUID, float] | None = None) -> list[dict]:
    ids = [p.id for p in products]
    layout = active_layout(db, store.id)
    locs = product_locations(db, layout.id if layout else None, ids)
    stock = stock_snapshot(db, store.id, ids)
    promos = active_promotions(db, store, ids)
    cards = []
    for p in products:
        s = stock.get(p.id, {"qty": 0, "markdown": None, "reorder_point": 0, "price_override": None})
        price = s["price_override"] if s["price_override"] is not None else p.price
        qty = s["qty"]
        level = "out_of_stock" if qty <= 0 else ("low_stock" if qty <= max(s["reorder_point"], 3) else "in_stock")
        promo = promos.get(p.id) if p.promotion_eligible else None
        primary = next((i for i in p.images if i.is_primary), p.images[0] if p.images else None)
        cards.append({
            "id": str(p.id),
            "sku": p.sku,
            "name": p.name,
            "brand": p.brand,
            "description": p.description,
            "unit": p.unit,
            "category": {"id": str(p.category.id), "name": p.category.name} if p.category else None,
            "price": float(price),
            "promotion": (
                {"id": str(promo.id), "name": promo.name,
                 "price": float(promo_price(price, promo, p.min_allowed_price)),
                 "ends_at": promo.ends_at.isoformat()}
                if promo else None
            ),
            "markdown": s["markdown"],
            "in_stock": qty > 0,
            "stock_level": level,
            "location": location_view(locs.get(p.id)),
            "image_url": f"/media/{primary.file_path}" if primary else None,
            "tags": p.tags or [],
            "is_perishable": p.is_perishable,
            "score": scores.get(p.id) if scores else None,
        })
    return cards


def load_products(db: Session, ids: list[uuid.UUID]) -> list[Product]:
    if not ids:
        return []
    by_id = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(ids)))}
    return [by_id[i] for i in ids if i in by_id]
