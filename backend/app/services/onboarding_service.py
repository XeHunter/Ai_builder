"""Self-service onboarding for a new store owner: account -> store -> floor plan -> catalog -> channels.

Every step reuses the production paths (the CSV importer, the stock ledger, the analytics jobs), so a
store set up through the wizard behaves exactly like the seeded demo stores.
"""

from __future__ import annotations

import csv
import io
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.exceptions import BusinessRuleError, ConflictError, NotFoundError
from app.core.security import hash_password
from app.db.models import (
    ApiKey,
    IntegrationConfig,
    InventoryItem,
    Merchant,
    MerchantMembership,
    MerchantSettings,
    NotificationPreference,
    PricingRule,
    Product,
    ProductCategory,
    ProductImage,
    ProductPlacement,
    Role,
    SalesTransaction,
    ShelfLocation,
    Store,
    StoreLayout,
    User,
)
from app.seed.layout_builder import LayoutSpec, build_layout
from app.services import catalog_service
from app.services.audit_service import record_audit
from app.services.inventory_service import IMPORT_COLUMNS

DEFAULT_PRICING_RULES = [
    ("Expiry markdown ladder", "expiry_markdown", 10,
     {"elasticity": 2.0, "tiers": [{"max_hours": 24, "max_discount_pct": 50}, {"max_hours": 48, "max_discount_pct": 30},
                                   {"max_hours": 72, "max_discount_pct": 20}, {"max_hours": 168, "max_discount_pct": 10}]},
     {"applies_to": "perishable batches"}),
    ("Rainy-day essentials", "weather_promotion", 20,
     {"product_tag": "rain", "discount_pct": 10, "min_precip_mm": 5}, {"forecast_window_days": 3}),
]


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48] or "store"


def register_merchant(db: Session, *, business_name: str, full_name: str, email: str, password: str) -> User:
    """Create the owner account, the tenant, default policies and the standard grocery category tree."""
    from app.seed import catalog_data as C

    if db.scalars(select(User.id).where(func.lower(User.email) == email.lower())).first():
        raise ConflictError("An account with this email already exists")
    role = db.scalars(select(Role).where(Role.name == "merchant_admin")).first()
    if role is None:
        raise BusinessRuleError("Roles are not provisioned; run the seed or migrations first")
    slug = _slugify(business_name)
    if db.scalars(select(Merchant.id).where(Merchant.slug == slug)).first():
        slug = f"{slug[:40]}-{secrets.token_hex(3)}"
    merchant = Merchant(name=business_name.strip(), slug=slug, currency="INR", is_demo=get_settings().demo_mode)
    user = User(email=email.lower(), full_name=full_name.strip(), password_hash=hash_password(password),
                account_type="merchant")
    db.add_all([merchant, user])
    db.flush()
    db.add_all([
        MerchantSettings(merchant_id=merchant.id, clearance_location_code="CLR-1-1"),
        MerchantMembership(user_id=user.id, merchant_id=merchant.id, role_id=role.id, all_stores=True),
        NotificationPreference(user_id=user.id),
        IntegrationConfig(merchant_id=merchant.id, kind="weather", provider="simulated", mode="simulated", settings={}),
        IntegrationConfig(merchant_id=merchant.id, kind="pricing_publisher", provider="simulated_esl", mode="simulated",
                          settings={"fail_skus": []}),
        IntegrationConfig(merchant_id=merchant.id, kind="pos", provider="omnipulse_orders_api", mode="live", settings={}),
        IntegrationConfig(merchant_id=merchant.id, kind="ecommerce", provider="omnipulse_orders_api", mode="live",
                          settings={}),
    ])
    for name, rtype, prio, params, cond in DEFAULT_PRICING_RULES:
        db.add(PricingRule(merchant_id=merchant.id, name=name, rule_type=rtype, priority=prio, parameters=params,
                           conditions=cond))
    for cslug, (cname, perishable, chill) in C.CATEGORIES.items():
        db.add(ProductCategory(merchant_id=merchant.id, name=cname, slug=cslug, is_perishable=perishable,
                               requires_chilling=chill))
    db.flush()
    record_audit(db, action="onboarding.merchant.registered", entity_type="merchant", entity_id=merchant.id,
                 summary=f"{business_name} registered by {full_name}", actor=user, merchant_id=merchant.id)
    db.commit()
    return user


def _next_store_code(db: Session, merchant_id: uuid.UUID, name: str) -> str:
    base = re.sub(r"[^A-Z]", "", name.upper())[:3] or "STR"
    for i in range(1, 100):
        code = f"{base}{i:02d}"
        if not db.scalars(select(Store.id).where(Store.merchant_id == merchant_id, Store.code == code)).first():
            return code
    return f"{base}{secrets.token_hex(2).upper()}"


def create_store(db: Session, *, merchant_id: uuid.UUID, actor: User, name: str, address: str, city: str,
                 latitude: float, longitude: float, code: str | None = None, layout: LayoutSpec | None = None) -> Store:
    code = (code or _next_store_code(db, merchant_id, name)).upper()
    if db.scalars(select(Store.id).where(Store.merchant_id == merchant_id, Store.code == code)).first():
        raise ConflictError(f"Store code {code} is already used")
    radius = db.get(MerchantSettings, merchant_id)
    store = Store(merchant_id=merchant_id, code=code, name=name.strip(), address=address.strip(), city=city.strip(),
                  latitude=latitude, longitude=longitude,
                  geofence_radius_m=radius.default_geofence_radius_m if radius else 1000, timezone="Asia/Kolkata")
    db.add(store)
    db.flush()
    if layout is not None:
        build_layout(db, store.id, layout, name="Main floor v1", created_by_id=actor.id,
                     notes="Generated with the onboarding layout builder.")
    record_audit(db, action="onboarding.store.created", entity_type="store", entity_id=store.id,
                 summary=f"Store {code} - {name}", actor=actor, merchant_id=merchant_id)
    db.commit()
    return store


def preview_layout(db: Session, store: Store, spec: LayoutSpec) -> dict:
    """Generate the floor plan inside a savepoint and roll it back - nothing is persisted."""
    from app.services.layout_service import layout_detail

    nested = db.begin_nested()
    try:
        layout, shelves = build_layout(db, store.id, spec, name="Preview", status="draft")
        detail = layout_detail(db, layout, include_products=False)
    finally:
        nested.rollback()
    detail["stats"] = layout_stats(spec, detail)
    return detail


def layout_stats(spec: LayoutSpec, detail: dict) -> dict:
    return {"width_m": spec.width, "height_m": spec.height, "area_m2": round(spec.width * spec.height),
            "shelf_locations": len(detail["shelves"]), "walk_nodes": len(detail["nodes"]),
            "aisles": spec.aisles, "checkouts": spec.checkouts}


def apply_layout(db: Session, store: Store, spec: LayoutSpec, actor: User) -> tuple[StoreLayout, str]:
    """Use the generated plan. A store without placements gets it as its active layout; otherwise it is
    saved as a draft so the planogram can be moved over and published from the layout editor."""
    active = catalog_service.active_layout(db, store.id)
    has_placements = bool(active and db.scalars(select(ProductPlacement.id).where(ProductPlacement.layout_id == active.id)).first())
    latest = db.scalar(select(func.max(StoreLayout.version)).where(StoreLayout.store_id == store.id)) or 0
    if active is not None and has_placements:
        layout, _ = build_layout(db, store.id, spec, name=f"Generated plan v{latest + 1}", version=latest + 1, status="draft",
                                 created_by_id=actor.id, notes="Generated with the layout builder.")
        layout.based_on_layout_id = active.id
        outcome = "draft"
    else:
        if active is not None:
            active.status = "archived"
            db.flush()
        layout, _ = build_layout(db, store.id, spec, name=f"Main floor v{latest + 1}", version=latest + 1,
                                 created_by_id=actor.id, notes="Generated with the layout builder.")
        layout.published_at = datetime.now(UTC)
        outcome = "active"
    record_audit(db, action="layout.generated", entity_type="store_layout", entity_id=layout.id,
                 summary=f"{store.code}: {spec.aisles} aisles x {spec.sections} sections ({outcome})", actor=actor,
                 merchant_id=store.merchant_id)
    db.commit()
    return layout, outcome


def starter_catalog_csv(db: Session, store: Store, limit: int = 60) -> str:
    """A ready-to-import catalog for a new store in the standard import format, with shelf locations that
    exist in the store's active layout (zone-aware: chilled goods on chillers, frozen on freezers)."""
    from app.seed import catalog_data as C

    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        raise BusinessRuleError("Create the store layout first so products can be given shelf locations")
    shelves = {s.code: s for s in db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id))}
    free_aisle = sorted((c for c in shelves if c.startswith("A") and c.split("-")[-1] in ("2", "3", "4")),
                        key=lambda c: (int(c.split("-")[0][1:]), c.split("-")[2], c.split("-")[1], c.split("-")[3]))
    zone_free = {z: sorted(c for c in shelves if c.startswith(f"{z}-")) for z in ("D", "Z", "P")}
    used: set[str] = set()

    def take(pool: list[str]) -> str:
        for c in pool:
            if c not in used:
                used.add(c)
                return c
        return ""

    today = datetime.now(UTC).date()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(IMPORT_COLUMNS)
    for spec in C.PRODUCTS[:limit]:
        sku, name, cat, brand, unit, price, cost, minp, life, weight, tags, desc, shelf = spec
        cname, perishable, chill = C.CATEGORIES[cat]
        if shelf in shelves and shelf not in used:
            used.add(shelf)
            code = shelf
        else:
            zone = "D" if chill else ("Z" if cat == "frozen" else ("P" if cat in ("produce", "bakery") else None))
            code = take(zone_free[zone]) if zone and zone_free.get(zone) else ""
            code = code or take(free_aisle)
        is_perishable = (life is not None and life <= 30) or cat == "frozen" or perishable
        expiry = (today + timedelta(days=min(life or 365, 365))).isoformat() if (life or is_perishable) else ""
        batch = f"{sku}-{store.code}-OPEN" if expiry else ""
        stock = 12 if price > 1000 else 24 if is_perishable else 36
        w.writerow([sku, name, desc, cname, price, cost, stock, store.code, shelves[code].aisle_code if code else "",
                    code, "", batch, expiry, "all", minp, "true" if cat != "gift-cards" else "false"])
    return buf.getvalue()


def ensure_product_images(db: Session, merchant_id: uuid.UUID) -> int:
    """Give imported products without a photo a generated packshot (clearly flagged synthetic)."""
    from app.ai.visual_search.features import FEATURE_VERSION, describe
    from app.seed.images import render_packshot, save_png

    media = get_settings().media_dir
    merchant = db.get(Merchant, merchant_id)
    made = 0
    for p in db.scalars(select(Product).where(Product.merchant_id == merchant_id)):
        if p.images:
            continue
        img = render_packshot(p.sku, p.name, p.brand, p.category.slug if p.category else "general")
        rel = f"products/{merchant.slug}/{p.sku}.png"
        save_png(img, media / rel)
        db.add(ProductImage(product_id=p.id, file_path=rel, content_type="image/png", is_primary=True, is_synthetic=True,
                            width=img.width, height=img.height, features=describe(img), feature_version=FEATURE_VERSION))
        made += 1
    db.commit()
    return made


def run_setup_analytics(db: Session, merchant_id: uuid.UUID, actor: User) -> dict:
    """After catalog/history import: images, search index, expiry evaluation, forecasts, affinity, merchandising."""
    from app.tasks.queue import enqueue

    images = ensure_product_images(db, merchant_id)
    catalog_service.invalidate_index(merchant_id)
    jobs = {}
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M")
    for jt in ("embedding_reindex", "expiry_reevaluation", "forecast_refresh", "analytics_refresh", "fraud_scan"):
        job = enqueue(db, jt, {}, merchant_id=merchant_id, created_by_id=actor.id, dedupe_key=f"setup:{jt}:{merchant_id}:{stamp}")
        jobs[jt] = {"id": str(job.id), "status": job.status}
    return {"images_generated": images, "jobs": jobs}


def status(db: Session, merchant_id: uuid.UUID) -> dict:
    stores = db.scalars(select(Store).where(Store.merchant_id == merchant_id).order_by(Store.created_at)).all()
    store_ids = [s.id for s in stores]
    layouts = db.scalar(select(func.count(StoreLayout.id)).where(StoreLayout.store_id.in_(store_ids),
                                                                 StoreLayout.status == "active")) if store_ids else 0
    products = db.scalar(select(func.count(Product.id)).where(Product.merchant_id == merchant_id)) or 0
    stocked = db.scalar(select(func.count(InventoryItem.id)).where(InventoryItem.merchant_id == merchant_id,
                                                                   InventoryItem.quantity_on_hand > 0)) or 0
    sales = db.scalar(select(func.count(SalesTransaction.id)).where(SalesTransaction.merchant_id == merchant_id)) or 0
    keys = db.scalar(select(func.count(ApiKey.id)).where(ApiKey.merchant_id == merchant_id, ApiKey.revoked_at.is_(None))) or 0
    steps = {"store": bool(stores), "layout": bool(layouts), "catalog": products > 0 and stocked > 0,
             "history": sales >= 200, "channels": keys > 0}
    return {"steps": steps, "complete": all(steps.values()), "stores": [
        {"id": str(s.id), "code": s.code, "name": s.name, "city": s.city} for s in stores],
        "counts": {"products": products, "stocked_items": stocked, "sales": sales, "api_keys": keys}}


def get_owned_store(db: Session, merchant_id: uuid.UUID, store_id: uuid.UUID) -> Store:
    store = db.get(Store, store_id)
    if store is None or store.merchant_id != merchant_id:
        raise NotFoundError("Store not found")
    return store
