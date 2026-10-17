"""Stores, shopper catalog browsing/search and merchant product management."""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.ai.providers import get_ai_provider
from app.api.dependencies import MerchantContext, get_current_user, page_params, require_permission
from app.core.exceptions import ConflictError, NotFoundError
from app.db.models import InventoryItem, Product, ProductCategory, Promotion, PromotionProduct, Store, User
from app.db.session import get_db
from app.schemas.catalog import (
    CategoryOut,
    CategoryWithCount,
    ProductAdminOut,
    ProductCreate,
    ProductDetailResponse,
    ProductSearchResponse,
    ProductUpdate,
    StoreOut,
)
from app.schemas.common import Page, PageParams
from app.services import catalog_service, cross_selling_service, layout_service, weather_service
from app.services.audit_service import record_audit
from app.services.pricing_policy import margin_pct
from app.tasks.queue import enqueue

router = APIRouter(tags=["catalog"])


def _store(db: Session, store_id: uuid.UUID) -> Store:
    store = db.get(Store, store_id)
    if store is None or not store.is_active:
        raise NotFoundError("Store not found")
    return store


@router.get("/stores", response_model=list[StoreOut])
def list_stores(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[Store]:
    """Active stores customers can shop at."""
    return list(db.scalars(select(Store).where(Store.is_active.is_(True)).order_by(Store.name)))


@router.get("/stores/{store_id}", response_model=StoreOut)
def get_store(store_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> Store:
    return _store(db, store_id)


@router.get("/stores/{store_id}/floorplan")
def floorplan(store_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    """Active layout: fixtures, shelves (with placed products), walkable nodes and edges."""
    store = _store(db, store_id)
    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        raise NotFoundError("This store has no floor plan")
    return layout_service.layout_detail(db, layout)


@router.get("/stores/{store_id}/weather")
def store_weather(store_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    store = _store(db, store_id)
    weather_service.refresh_forecast(db, store, 7)
    db.commit()
    return {"store_id": str(store.id), "forecast": weather_service.forecast_view(db, store, 7)}


@router.get("/stores/{store_id}/categories", response_model=list[CategoryWithCount])
def store_categories(store_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    store = _store(db, store_id)
    rows = db.execute(select(ProductCategory, func.count(Product.id))
                      .join(Product, Product.category_id == ProductCategory.id)
                      .join(InventoryItem, InventoryItem.product_id == Product.id)
                      .where(InventoryItem.store_id == store.id, Product.status == "active")
                      .group_by(ProductCategory.id).order_by(ProductCategory.name)).all()
    return [{"id": str(c.id), "name": c.name, "slug": c.slug, "product_count": n} for c, n in rows]


@router.get("/stores/{store_id}/products", response_model=ProductSearchResponse)
def search_products(
    store_id: uuid.UUID,
    q: str | None = Query(None, max_length=200),
    category_id: uuid.UUID | None = None,
    in_stock: bool = False,
    max_price: float | None = Query(None, ge=0),
    pp: PageParams = Depends(page_params),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict:
    """Hybrid lexical + embedding search over the store's catalog (or browse when ``q`` is empty)."""
    store = _store(db, store_id)
    carried = set(db.scalars(select(InventoryItem.product_id).where(InventoryItem.store_id == store.id)))
    scores: dict[uuid.UUID, float] = {}
    if q and q.strip():
        hits = catalog_service.search(db, store.merchant_id, q, limit=200, candidate_ids=carried)
        ids = [h.product_id for h in hits]
        scores = {h.product_id: h.score for h in hits}
        products = catalog_service.load_products(db, ids)
    else:
        products = list(db.scalars(select(Product).where(Product.id.in_(carried), Product.status == "active")
                                   .order_by(Product.name)))
    if category_id:
        products = [p for p in products if p.category_id == category_id]
    cards = catalog_service.product_cards(db, store, products, scores)
    if in_stock:
        cards = [c for c in cards if c["in_stock"]]
    if max_price is not None:
        cards = [c for c in cards if c["price"] <= max_price]
    total = len(cards)
    provider = get_ai_provider()
    return {"items": cards[pp.offset : pp.offset + pp.page_size], "total": total, "page": pp.page,
            "page_size": pp.page_size,
            "search": {"query": q, "method": "hybrid_lexical_embedding" if q else "browse",
                       "embedding_model": provider.embedding_model, "embedding_kind": provider.kind}}


@router.get("/stores/{store_id}/featured")
def featured(store_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict:
    """Active promotions, short-dated markdowns and best sellers for the shopping home page."""
    store = _store(db, store_id)
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    promos = db.scalars(select(Promotion).where(Promotion.merchant_id == store.merchant_id, Promotion.status == "active",
                                                Promotion.is_simulation.is_(False), Promotion.starts_at <= now,
                                                Promotion.ends_at > now,
                                                or_(Promotion.store_id.is_(None), Promotion.store_id == store.id))).all()
    promo_pids = list(db.scalars(select(PromotionProduct.product_id).where(
        PromotionProduct.promotion_id.in_([p.id for p in promos])))) if promos else []
    pop = catalog_service.popularity(db, store.id, 14)
    top = [pid for pid, _ in sorted(pop.items(), key=lambda kv: -kv[1])[:8]]
    cards_promo = catalog_service.product_cards(db, store, catalog_service.load_products(db, promo_pids[:12]))
    cards_top = catalog_service.product_cards(db, store, catalog_service.load_products(db, top))
    carried = list(db.scalars(select(InventoryItem.product_id).where(InventoryItem.store_id == store.id)))
    markdown_cards = [c for c in catalog_service.product_cards(db, store, catalog_service.load_products(db, carried))
                      if c["markdown"]]
    return {
        "promotions": [{"id": str(p.id), "name": p.name, "description": p.description, "ends_at": p.ends_at.isoformat(),
                        "promo_type": p.promo_type, "discount_value": float(p.discount_value)} for p in promos],
        "promoted_products": cards_promo,
        "markdowns": markdown_cards[:8],
        "best_sellers": cards_top,
    }


@router.get("/stores/{store_id}/products/{product_id}", response_model=ProductDetailResponse)
def product_detail(store_id: uuid.UUID, product_id: uuid.UUID, db: Session = Depends(get_db),
                   _: User = Depends(get_current_user)) -> dict:
    store = _store(db, store_id)
    p = db.get(Product, product_id)
    if p is None or p.merchant_id != store.merchant_id:
        raise NotFoundError("Product not found")
    card = catalog_service.product_cards(db, store, [p])[0]
    comps = cross_selling_service.complements_for(db, store.merchant_id, p.id, store.id)
    comp_cards = catalog_service.product_cards(db, store, catalog_service.load_products(db, [c["product_id"] for c in comps]))
    return {"product": card, "complementary": comp_cards,
            "complement_reasons": {str(c["product_id"]): c["reason"] for c in comps}}


# --------------------------------------------------------------------------- merchant catalog


def _admin_out(p: Product, stock: int | None = None) -> ProductAdminOut:
    out = ProductAdminOut.model_validate(p)
    out.category_name = p.category.name if p.category else None
    out.total_stock = stock
    out.margin_pct = margin_pct(p.price, p.cost_price)
    return out


@router.get("/merchant/categories", response_model=list[CategoryOut])
def merchant_categories(ctx: MerchantContext = Depends(require_permission("catalog.read")),
                        db: Session = Depends(get_db)) -> list[ProductCategory]:
    return list(db.scalars(select(ProductCategory).where(ProductCategory.merchant_id == ctx.merchant_id)
                           .order_by(ProductCategory.name)))


@router.get("/merchant/products", response_model=Page[ProductAdminOut])
def merchant_products(
    q: str | None = Query(None, max_length=100),
    category_id: uuid.UUID | None = None,
    status_filter: str | None = Query(None, alias="status", pattern="^(active|archived)$"),
    pp: PageParams = Depends(page_params),
    ctx: MerchantContext = Depends(require_permission("catalog.read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Product).where(Product.merchant_id == ctx.merchant_id)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Product.name).like(like), func.lower(Product.sku).like(like),
                              func.lower(Product.brand).like(like)))
    if category_id:
        stmt = stmt.where(Product.category_id == category_id)
    if status_filter:
        stmt = stmt.where(Product.status == status_filter)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(stmt.order_by(Product.name).offset(pp.offset).limit(pp.page_size)).all()
    stock = dict(db.execute(select(InventoryItem.product_id, func.sum(InventoryItem.quantity_on_hand))
                            .where(InventoryItem.product_id.in_([p.id for p in rows]))
                            .group_by(InventoryItem.product_id)).all())
    return {"items": [_admin_out(p, int(stock.get(p.id, 0) or 0)) for p in rows], "total": total,
            "page": pp.page, "page_size": pp.page_size}


def _owned_product(db: Session, ctx: MerchantContext, product_id: uuid.UUID) -> Product:
    p = db.get(Product, product_id)
    if p is None or p.merchant_id != ctx.merchant_id:
        raise NotFoundError("Product not found")
    return p


@router.get("/merchant/products/{product_id}", response_model=ProductAdminOut)
def merchant_product(product_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("catalog.read")),
                     db: Session = Depends(get_db)) -> ProductAdminOut:
    p = _owned_product(db, ctx, product_id)
    stock = db.scalar(select(func.sum(InventoryItem.quantity_on_hand)).where(InventoryItem.product_id == p.id)) or 0
    return _admin_out(p, int(stock))


def _check_category(db: Session, ctx: MerchantContext, category_id: uuid.UUID | None) -> None:
    if category_id:
        c = db.get(ProductCategory, category_id)
        if c is None or c.merchant_id != ctx.merchant_id:
            raise NotFoundError("Category not found")


@router.post("/merchant/products", response_model=ProductAdminOut, status_code=status.HTTP_201_CREATED)
def create_product(body: ProductCreate, ctx: MerchantContext = Depends(require_permission("catalog.write")),
                   db: Session = Depends(get_db)) -> ProductAdminOut:
    _check_category(db, ctx, body.category_id)
    sku = body.sku.upper()
    if db.scalars(select(Product.id).where(Product.merchant_id == ctx.merchant_id, Product.sku == sku)).first():
        raise ConflictError(f"A product with SKU {sku} already exists")
    if body.min_allowed_price is not None and body.min_allowed_price > body.price:
        from app.core.exceptions import ValidationFailedError

        raise ValidationFailedError("min_allowed_price cannot exceed price")
    p = Product(merchant_id=ctx.merchant_id, **{**body.model_dump(), "sku": sku})
    db.add(p)
    db.flush()
    record_audit(db, action="catalog.product.created", entity_type="product", entity_id=p.id,
                 summary=f"Created {p.sku} {p.name}", actor=ctx.user, merchant_id=ctx.merchant_id,
                 after={"price": str(p.price)})
    db.commit()
    catalog_service.invalidate_index(ctx.merchant_id)
    enqueue(db, "embedding_reindex", {}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id)
    db.refresh(p)
    return _admin_out(p, 0)


@router.patch("/merchant/products/{product_id}", response_model=ProductAdminOut)
def update_product(product_id: uuid.UUID, body: ProductUpdate,
                   ctx: MerchantContext = Depends(require_permission("catalog.write")),
                   db: Session = Depends(get_db)) -> ProductAdminOut:
    """Edit product attributes. The selling price is changed through the pricing workflow, not here."""
    p = _owned_product(db, ctx, product_id)
    changes = body.model_dump(exclude_unset=True)
    _check_category(db, ctx, changes.get("category_id"))
    floor = changes.get("min_allowed_price", p.min_allowed_price)
    if floor is not None and Decimal(floor) > p.price:
        from app.core.exceptions import ValidationFailedError

        raise ValidationFailedError("min_allowed_price cannot exceed the current price")
    before = {k: getattr(p, k) for k in changes}
    for k, v in changes.items():
        setattr(p, k, v)
    record_audit(db, action="catalog.product.updated", entity_type="product", entity_id=p.id,
                 summary=f"Updated {p.sku}: {', '.join(changes)}", actor=ctx.user, merchant_id=ctx.merchant_id,
                 before=before, after=changes)
    db.commit()
    catalog_service.invalidate_index(ctx.merchant_id)
    db.refresh(p)
    return merchant_product(p.id, ctx, db)


@router.post("/merchant/products/reindex", status_code=status.HTTP_202_ACCEPTED)
def reindex(force: bool = False, ctx: MerchantContext = Depends(require_permission("catalog.write")),
            db: Session = Depends(get_db)) -> dict:
    """Queue (re)computation of text embeddings and visual descriptors."""
    job = enqueue(db, "embedding_reindex", {"force": force}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id)
    return {"job_id": str(job.id), "status": job.status}


