"""Deterministic demo dataset (all data is synthetic and flagged as demo).

Usage: ``python -m scripts.seed`` (see repository scripts) or ``seed_demo(db)`` from tests.

What is generated (relative to *today*, so the demo always looks current):
* 2 merchants (tenants): FreshMart (2 stores) and UrbanBasket (1 store); roles, users and settings.
* Store layouts with walkable graphs and shelf locations; product placements.
* ~75 products, batches with expiry dates (incl. 40 milk cartons expiring within ~48 h).
* Simulated weather history and N days of basket-level sales generated from "shopping missions"
  (so co-purchase patterns exist), with rain-associated demand for umbrellas and hot drinks.
* Legitimate returns plus labelled synthetic fraud scenarios.
* Promotions, pricing rules, curated product relations, shopping lists and a shared list.
* Initial analytics runs (affinity, forecasts, expiry evaluation, merchandising, fraud scan).
"""

from __future__ import annotations

import math
import random
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from app.ai.embeddings.service import reindex_products
from app.ai.visual_search.features import FEATURE_VERSION, describe
from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.permissions import PERMISSIONS, ROLES
from app.core.security import hash_password
from app.db.models import (
    AccountSecurityEvent,
    AffinityRun,
    FraudLabel,
    IntegrationConfig,
    InventoryBatch,
    InventoryItem,
    ListMembership,
    Merchant,
    MerchantMembership,
    MerchantSettings,
    NotificationPreference,
    Permission,
    PricingRule,
    Product,
    ProductCategory,
    ProductImage,
    ProductPlacement,
    ProductRelation,
    Promotion,
    PromotionProduct,
    Role,
    SalesTransaction,
    StockAdjustment,
    Store,
    StoreMembership,
    TransactionItem,
    User,
    WeatherRecord,
)
from app.integrations.weather.providers import SimulatedWeatherProvider
from app.seed import catalog_data as C
from app.seed.images import make_query_variants, render_packshot, save_png
from app.seed.layout_builder import build_standard_layout

log = get_logger("seed")

DEMO_PASSWORD = "Demo@12345"
IST = ZoneInfo("Asia/Kolkata")

STORES = {
    "freshmart": [
        ("AND01", "FreshMart Andheri West", "Lokhandwala Complex, Andheri West", "Mumbai", 19.1364, 72.8296, 150),
        ("BAN01", "FreshMart Bandra", "Hill Road, Bandra West", "Mumbai", 19.0596, 72.8295, 110),
    ],
    "urbanbasket": [
        ("KOR01", "UrbanBasket Koramangala", "80 Feet Road, Koramangala", "Bengaluru", 12.9352, 77.6245, 60),
    ],
}


def _d(v: float) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


class _Ids:
    """Pre-generated UUIDs so bulk inserts can reference each other."""

    @staticmethod
    def new() -> uuid.UUID:
        return uuid.uuid4()


def seed_demo(db: Session, *, days: int = 120, scale: float = 1.0, today: date | None = None,
              with_images: bool = True, run_analytics: bool = True, seed: int = 42) -> dict:
    rng = random.Random(seed)
    today = today or datetime.now(IST).date()
    settings = get_settings()

    # ---------------------------------------------------------------- roles & permissions
    perms = {code: Permission(code=code, description=desc) for code, desc in PERMISSIONS.items()}
    db.add_all(perms.values())
    roles = {}
    for name, (desc, codes) in ROLES.items():
        r = Role(name=name, description=desc, permissions=[perms[c] for c in sorted(codes)])
        db.add(r)
        roles[name] = r
    db.flush()

    # ---------------------------------------------------------------- merchants & stores
    fm = Merchant(name="FreshMart", slug="freshmart", is_demo=True)
    ub = Merchant(name="UrbanBasket", slug="urbanbasket", is_demo=True)
    db.add_all([fm, ub])
    db.flush()
    for m in (fm, ub):
        db.add(MerchantSettings(merchant_id=m.id, clearance_location_code="CLR-1-1"))
    stores: dict[str, Store] = {}
    store_txn_rate: dict[str, int] = {}
    for slug, merchant in (("freshmart", fm), ("urbanbasket", ub)):
        for code, name, addr, city, lat, lon, rate in STORES[slug]:
            s = Store(merchant_id=merchant.id, code=code, name=name, address=addr, city=city, latitude=lat,
                      longitude=lon, geofence_radius_m=1000, timezone="Asia/Kolkata")
            db.add(s)
            stores[code] = s
            store_txn_rate[code] = max(1, int(rate * scale))
    db.flush()

    # ---------------------------------------------------------------- users
    pw_hash = hash_password(DEMO_PASSWORD)

    def user(email: str, name: str, kind: str) -> User:
        u = User(email=email, full_name=name, password_hash=pw_hash, account_type=kind)
        db.add(u)
        return u

    priya = user("priya@demo.omnipulse.ai", "Priya Sharma", "customer")
    rohan = user("rohan@demo.omnipulse.ai", "Rohan Mehta", "customer")
    admin = user("admin@freshmart.demo", "Anita Desai (Admin)", "merchant")
    manager = user("manager.andheri@freshmart.demo", "Suresh Iyer (Store Manager)", "merchant")
    analyst = user("analyst@freshmart.demo", "Kavya Rao (Analyst)", "merchant")
    associate = user("ravi.associate@freshmart.demo", "Ravi Kumar (Associate)", "merchant")
    ub_admin = user("admin@urbanbasket.demo", "Farhan Ali (UrbanBasket Admin)", "merchant")
    fraud_cast = {k: user(f"{k}@demo.omnipulse.ai", n, "customer") for k, n in [
        ("vikram", "Vikram Rao"), ("arjun", "Arjun Nair"), ("neha", "Neha Kapoor"), ("karan", "Karan Malhotra"),
        ("sameer", "Sameer Joshi")]}
    shoppers = [user(f"shopper{i:02d}@demo.omnipulse.ai", f"Demo Shopper {i:02d}", "customer") for i in range(1, 41)]
    db.flush()
    priya.preferred_store_id = stores["AND01"].id
    rohan.preferred_store_id = stores["AND01"].id
    db.add_all([
        MerchantMembership(user_id=admin.id, merchant_id=fm.id, role_id=roles["merchant_admin"].id),
        MerchantMembership(user_id=manager.id, merchant_id=fm.id, role_id=roles["store_manager"].id, all_stores=False),
        MerchantMembership(user_id=analyst.id, merchant_id=fm.id, role_id=roles["analyst"].id),
        MerchantMembership(user_id=associate.id, merchant_id=fm.id, role_id=roles["store_manager"].id, all_stores=False),
        MerchantMembership(user_id=ub_admin.id, merchant_id=ub.id, role_id=roles["merchant_admin"].id),
        StoreMembership(user_id=manager.id, store_id=stores["AND01"].id),
        StoreMembership(user_id=associate.id, store_id=stores["AND01"].id),
    ])
    for u in [priya, rohan, *fraud_cast.values(), *shoppers]:
        db.add(NotificationPreference(user_id=u.id, marketing_opt_in=u in (priya, rohan),
                                      abandoned_list_reminders=True))
    for u in (admin, manager, analyst, associate, ub_admin):
        db.add(NotificationPreference(user_id=u.id))

    # ---------------------------------------------------------------- integrations & rules
    weekend = [today + timedelta(days=i) for i in range(1, 8) if (today + timedelta(days=i)).weekday() >= 5][:2]
    db.add_all([
        IntegrationConfig(merchant_id=fm.id, kind="weather", provider="simulated", mode="simulated",
                          settings={"forecast_overrides": {"AND01": {
                              weekend[0].isoformat(): {"precipitation_mm": 18.0, "condition": "rain", "temp_max_c": 28.5, "temp_min_c": 24.0},
                              weekend[1].isoformat(): {"precipitation_mm": 26.0, "condition": "rain", "temp_max_c": 27.5, "temp_min_c": 23.5},
                          }}, "scenario": "Demo scenario: rain forecast this weekend at Andheri (simulated)."}),
        IntegrationConfig(merchant_id=fm.id, kind="pricing_publisher", provider="simulated_esl", mode="simulated",
                          settings={"fail_skus": []}),
        IntegrationConfig(merchant_id=fm.id, kind="pos", provider="simulated_pos", mode="simulated", settings={}),
        IntegrationConfig(merchant_id=ub.id, kind="pricing_publisher", provider="simulated_esl", mode="simulated",
                          settings={"fail_skus": []}),
    ])
    for m in (fm, ub):
        db.add(PricingRule(merchant_id=m.id, name="Expiry markdown ladder", rule_type="expiry_markdown", priority=10,
                           parameters={"elasticity": 2.0, "tiers": [
                               {"max_hours": 24, "max_discount_pct": 50}, {"max_hours": 48, "max_discount_pct": 30},
                               {"max_hours": 72, "max_discount_pct": 20}, {"max_hours": 168, "max_discount_pct": 10}]},
                           conditions={"applies_to": "perishable batches"}))
        db.add(PricingRule(merchant_id=m.id, name="Rainy-day essentials", rule_type="weather_promotion", priority=20,
                           parameters={"product_tag": "rain", "discount_pct": 10, "min_precip_mm": 5},
                           conditions={"forecast_window_days": 3}))

    # ---------------------------------------------------------------- catalog
    cats: dict[tuple[uuid.UUID, str], ProductCategory] = {}
    products: dict[tuple[uuid.UUID, str], Product] = {}
    spec_by_sku = {p[0]: p for p in C.PRODUCTS}
    for merchant, skus, mult in ((fm, [p[0] for p in C.PRODUCTS], 1.0), (ub, C.URBANBASKET_SKUS, 1.04)):
        for slug, (name, perishable, chill) in C.CATEGORIES.items():
            c = ProductCategory(merchant_id=merchant.id, name=name, slug=slug, is_perishable=perishable,
                                requires_chilling=chill)
            db.add(c)
            cats[(merchant.id, slug)] = c
        db.flush()
        for sku in skus:
            (_, name, cat, brand, unit, price, cost, minp, life, weight, tags, desc, _shelf) = spec_by_sku[sku]
            pr = _d(round(price * mult)) if price < 1000 else _d(price)
            p = Product(merchant_id=merchant.id, sku=sku, name=name, description=desc, category_id=cats[(merchant.id, cat)].id,
                        brand=brand, unit=unit, price=pr, cost_price=_d(cost), min_allowed_price=_d(minp),
                        target_segment="families" if cat in ("dairy", "breakfast", "baby") else "all",
                        promotion_eligible=cat != "gift-cards", is_perishable=life is not None and life <= 30 or cat in ("frozen",),
                        weight_kg=weight, tags=tags, search_text=f"{name} {brand or ''} {' '.join(tags)}")
            db.add(p)
            products[(merchant.id, sku)] = p
    db.flush()
    for a, b, rel, note in C.CURATED_RELATIONS:
        db.add(ProductRelation(merchant_id=fm.id, product_id=products[(fm.id, a)].id,
                               related_product_id=products[(fm.id, b)].id, relation_type=rel, note=note))

    # images (synthetic packshots) + query variants for the demo
    if with_images:
        media = settings.media_dir
        qdir = settings.sample_data_dir / "query_images"
        for (mid, sku), p in products.items():
            spec = spec_by_sku[sku]
            img = render_packshot(sku, spec[1], spec[3], spec[2])
            slug = "freshmart" if mid == fm.id else "urbanbasket"
            rel = f"products/{slug}/{sku}.png"
            save_png(img, media / rel)
            db.add(ProductImage(product_id=p.id, file_path=rel, content_type="image/png", is_primary=True, is_synthetic=True,
                                width=img.width, height=img.height, features=describe(img), feature_version=FEATURE_VERSION))
            if mid == fm.id and sku in ("MLK-001", "COF-001", "HHD-001", "BAB-001", "SEA-001", "ELE-001", "CHO-001", "TEA-001"):
                q = make_query_variants(img, seed=len(sku) + ord(sku[-1]))
                qdir.mkdir(parents=True, exist_ok=True)
                q.save(qdir / f"photo_{sku.lower()}.jpg", format="JPEG", quality=72)
    db.flush()

    # ---------------------------------------------------------------- layouts & placements
    layouts = {}
    for code, store in stores.items():
        layout, shelves = build_standard_layout(db, store.id, created_by_id=admin.id if store.merchant_id == fm.id else ub_admin.id)
        layouts[code] = (layout, shelves)
        for (mid, sku), p in products.items():
            if mid != store.merchant_id:
                continue
            shelf_code = spec_by_sku[sku][12]
            if shelf_code and shelf_code in shelves:
                db.add(ProductPlacement(layout_id=layout.id, shelf_location_id=shelves[shelf_code].id, product_id=p.id,
                                        facings=2, is_primary=True))
    db.flush()

    # ---------------------------------------------------------------- weather history
    start = today - timedelta(days=days)
    weather: dict[str, dict[date, float]] = {}
    for code, store in stores.items():
        sim = SimulatedWeatherProvider()
        weather[code] = {}
        rows = []
        for d in (start + timedelta(days=i) for i in range(days)):
            w = sim.day(store.latitude, store.longitude, d)
            weather[code][d] = w.precipitation_mm
            rows.append({"id": uuid.uuid4(), "store_id": store.id, "date": d, "temp_max_c": w.temp_max_c,
                         "temp_min_c": w.temp_min_c, "precipitation_mm": w.precipitation_mm, "condition": w.condition,
                         "is_forecast": False, "source": "simulated", "fetched_at": datetime.now(UTC)})
        db.execute(insert(WeatherRecord), rows)

    # ---------------------------------------------------------------- sales history
    from app.analytics.forecasting.calendar import is_holiday

    price_of = {(mid, sku): p.price for (mid, sku), p in products.items()}
    pid_of = {(mid, sku): p.id for (mid, sku), p in products.items()}
    sku_list_fm = [p[0] for p in C.PRODUCTS if p[0] != "GFT-001"]
    customers_pool = shoppers + [priya, rohan]
    txn_rows: list[dict] = []
    item_rows: list[dict] = []
    sale_index: dict[str, list[dict]] = defaultdict(list)  # customer -> their sales (for returns)

    def pick(options: list[tuple[str, float]]) -> str:
        r = rng.random() * sum(w for _, w in options)
        for sku, w in options:
            r -= w
            if r <= 0:
                return sku
        return options[-1][0]

    def add_txn(store: Store, when: datetime, skus: dict[str, int], *, customer: User | None = None,
                channel: str = "pos", ttype: str = "sale", original: dict | None = None, receipt: str | None = None,
                detected: dict[str, int] | None = None, terminal: str | None = None, prices: dict[str, Decimal] | None = None) -> dict:
        tid = uuid.uuid4()
        total = Decimal(0)
        lines = []
        for sku, qty in skus.items():
            unit = (prices or {}).get(sku) or price_of[(store.merchant_id, sku)]
            line = unit * qty
            total += line
            lines.append({"id": uuid.uuid4(), "transaction_id": tid, "product_id": pid_of[(store.merchant_id, sku)],
                          "quantity": qty, "detected_quantity": (detected or {}).get(sku) if channel == "self_checkout" else None,
                          "unit_price": unit, "discount": Decimal(0), "line_total": line})
        row = {"id": tid, "merchant_id": store.merchant_id, "store_id": store.id,
               "customer_id": customer.id if customer else None, "channel": channel, "transaction_type": ttype,
               "receipt_number": receipt or f"{store.code}-{when.astimezone(IST):%y%m%d}-{uuid.uuid4().hex[:6].upper()}",
               "original_transaction_id": original["id"] if original else None, "occurred_at": when,
               "subtotal": total, "discount_total": Decimal(0), "total": total, "payment_method": "card" if rng.random() < .6 else "upi",
               "terminal_id": terminal or ("SCO-1" if channel == "self_checkout" else f"POS-{rng.randint(1, 3)}"),
               "item_count": sum(skus.values()), "is_simulated": True, "_skus": dict(skus)}
        txn_rows.append(row)
        item_rows.extend(lines)
        return row

    for code, store in stores.items():
        is_fm = store.merchant_id == fm.id
        allowed = set(sku_list_fm if is_fm else C.URBANBASKET_SKUS)
        weights = {sku: 1.0 for sku in allowed}
        base_rate = store_txn_rate[code]
        for di in range(days):
            d = start + timedelta(days=di)
            precip = weather[code][d]
            factor = 1.0 + (0.25 if d.weekday() >= 5 else 0.1 if d.weekday() == 4 else 0) + (0.3 if is_holiday(d) else 0)
            factor *= 0.92 if precip >= 5 else 1.0
            factor *= 1 + 0.0015 * di  # mild growth trend
            n = int(base_rate * factor * (0.9 + 0.2 * rng.random()))
            rain_w = 0.01 + (0.10 * min(precip / 20, 1.5) if precip >= 2 else 0)
            for _ in range(n):
                hour = rng.choices(range(8, 23), weights=[3, 5, 6, 5, 4, 4, 5, 6, 8, 10, 11, 9, 7, 4, 2])[0]
                when = datetime.combine(d, time(hour, rng.randint(0, 59), rng.randint(0, 59)), tzinfo=IST).astimezone(UTC)
                basket: dict[str, int] = {}
                missions = [rng.choices([m for m in C.MISSIONS], weights=[m[1] for m in C.MISSIONS])[0]]
                if rng.random() < 0.35:
                    missions.append(rng.choices([m for m in C.MISSIONS], weights=[m[1] for m in C.MISSIONS])[0])
                groups_list = [m[2] for m in missions]
                if rng.random() < rain_w:
                    groups_list.append(C.RAIN_MISSION[1])
                for groups in groups_list:
                    for prob, options in groups:
                        if rng.random() < prob:
                            sku = pick(options)
                            if sku in allowed:
                                basket[sku] = basket.get(sku, 0) + (1 if rng.random() < 0.85 else 2)
                for a, b, p in C.ACCESSORY_RULES:
                    if a in basket and b in allowed and rng.random() < p:
                        basket[b] = 1
                if rng.random() < 0.08 and "CHO-002" in allowed:
                    basket["CHO-002"] = basket.get("CHO-002", 0) + 1
                if not basket:
                    sku = rng.choices(list(weights), weights=list(weights.values()))[0]
                    basket[sku] = 1
                for sku in list(basket):
                    if sku.startswith("ELE-0") and sku in ("ELE-001", "ELE-002", "ELE-006"):
                        basket[sku] = 1
                cust = rng.choice(customers_pool) if rng.random() < 0.15 else None
                channel = "self_checkout" if rng.random() < 0.18 else ("online" if rng.random() < 0.05 else "pos")
                row = add_txn(store, when, basket, customer=cust, channel=channel,
                              detected=dict(basket) if channel == "self_checkout" else None)
                if cust:
                    sale_index[str(cust.id)].append(row)

    # legitimate returns (~0.6% of identified-customer sales)
    for cust_sales in sale_index.values():
        for s in cust_sales:
            if rng.random() < 0.04 and s["occurred_at"] < datetime.now(UTC) - timedelta(days=12):
                sku = rng.choice(list(s["_skus"]))
                store = next(st for st in stores.values() if st.id == s["store_id"])
                r = add_txn(store, s["occurred_at"] + timedelta(days=rng.randint(1, 8), hours=rng.randint(0, 5)),
                            {sku: 1}, customer=next(u for u in customers_pool if u.id == s["customer_id"]),
                            ttype="return", original=s, receipt=s["receipt_number"])
                r["_label"] = (False, "legitimate_return")

    # ---- labelled synthetic fraud scenarios (FreshMart only) ----
    now = datetime.now(UTC)
    and01, ban01 = stores["AND01"], stores["BAN01"]

    def ago(days_: float, hours: float = 0) -> datetime:
        return now - timedelta(days=days_, hours=hours)

    v = fraud_cast["vikram"]
    for i, sku in enumerate(["ELE-009", "ELE-007", "ELE-005", "ELE-008", "ELE-009", "ELE-003", "ELE-005", "ELE-007"]):
        sale = add_txn(and01 if i % 2 == 0 else ban01, ago(27 - i * 3, 5), {sku: 1, "SNK-001": 1}, customer=v)
        ret = add_txn(and01 if i % 2 == 0 else ban01, ago(26 - i * 3, 2), {sku: 1}, customer=v, ttype="return",
                      original=sale, receipt=sale["receipt_number"])
        ret["_label"] = (i >= 4, "serial_returner")  # first returns individually look normal
    a = fraud_cast["arjun"]
    cam_sale = add_txn(and01, ago(14, 3), {"ELE-001": 1, "ELE-003": 1}, customer=a)
    r1 = add_txn(and01, ago(10, 2), {"ELE-001": 1}, customer=a, ttype="return", original=cam_sale, receipt=cam_sale["receipt_number"])
    r1["_label"] = (False, "first_refund_of_receipt")
    r2 = add_txn(ban01, ago(6, 4), {"ELE-001": 1}, customer=a, ttype="return", original=cam_sale, receipt=cam_sale["receipt_number"])
    r2["_label"] = (True, "duplicate_receipt")
    snack_sale = add_txn(and01, ago(9, 1), {"SNK-001": 2, "BEV-001": 1}, customer=fraud_cast["sameer"])
    mm = add_txn(and01, ago(8, 3), {"ELE-006": 1}, customer=fraud_cast["sameer"], ttype="return", original=snack_sale,
                 receipt=snack_sale["receipt_number"])
    mm["_label"] = (True, "receipt_product_mismatch")
    for i in range(5):
        sc = add_txn(and01, ago(3 + i * 4, 6), {"CHO-001": 1, "ELE-003": 1}, channel="self_checkout",
                     detected={"CHO-001": 3, "ELE-003": 2}, terminal="SCO-2")
        sc["_label"] = (True, "self_checkout_discrepancy")
    n = fraud_cast["neha"]
    base_t = ago(2, 7)
    for i in range(6):
        vt = add_txn(and01, base_t + timedelta(minutes=8 * i), {"ELE-009": 1}, customer=n, channel="self_checkout",
                     detected={"ELE-009": 1}, terminal="SCO-1")
        if i >= 4:
            vt["_label"] = (True, "transaction_velocity")
    k = fraud_cast["karan"]
    watch_sale = add_txn(ban01, ago(12, 2), {"ELE-006": 1}, customer=k)
    sec_t = ago(1, 9)
    db.add_all([AccountSecurityEvent(user_id=k.id, event_type="password_reset", occurred_at=sec_t, ip_address="203.0.113.7", is_simulated=True),
                AccountSecurityEvent(user_id=k.id, event_type="new_device", occurred_at=sec_t + timedelta(minutes=5), ip_address="203.0.113.7", is_simulated=True)])
    at = add_txn(ban01, sec_t + timedelta(hours=3), {"ELE-006": 1}, customer=k, ttype="return", original=watch_sale,
                 receipt=watch_sale["receipt_number"])
    at["_label"] = (True, "account_takeover_return")

    # bulk insert sales
    for chunk in range(0, len(txn_rows), 2000):
        db.execute(insert(SalesTransaction), [{k_: v_ for k_, v_ in r.items() if not k_.startswith("_")}
                                              for r in txn_rows[chunk:chunk + 2000]])
    for chunk in range(0, len(item_rows), 5000):
        db.execute(insert(TransactionItem), item_rows[chunk:chunk + 5000])
    labels = [{"id": uuid.uuid4(), "transaction_id": r["id"], "is_fraud": r["_label"][0], "scenario": r["_label"][1],
               "source": "synthetic"} for r in txn_rows if "_label" in r]
    if labels:
        db.execute(insert(FraudLabel), labels)

    # ---------------------------------------------------------------- inventory & batches
    recent_units: dict[tuple[str, str], float] = defaultdict(float)
    cutoff = now - timedelta(days=28)
    by_tid = {r["id"]: r for r in txn_rows}
    sku_of_pid = {p.id: sku for (mid, sku), p in products.items()}
    code_of_store = {s.id: c for c, s in stores.items()}
    for it in item_rows:
        t = by_tid[it["transaction_id"]]
        if t["transaction_type"] == "sale" and t["occurred_at"] >= cutoff:
            recent_units[(code_of_store[t["store_id"]], sku_of_pid[it["product_id"]])] += it["quantity"]
    special_cover = {"EGG-001": 1.2, "BAB-001": 1.5, "STP-003": 2.0, "SEA-002": 95, "HHD-003": 75, "PRC-002": 2.5,
                     "BEV-003": 25, "SEA-001": 6}
    adj_rows = []
    batch_rows = []
    for code, store in stores.items():
        for (mid, sku), p in products.items():
            if mid != store.merchant_id:
                continue
            spec = spec_by_sku[sku]
            life = spec[8]
            avg = recent_units[(code, sku)] / 28
            item = InventoryItem(merchant_id=mid, store_id=store.id, product_id=p.id,
                                 reorder_point=max(2, math.ceil(avg * 3)), reorder_quantity=max(6, math.ceil(avg * 7)))
            db.add(item)
            db.flush()
            batches: list[tuple[str, int, date | None, datetime]] = []
            if sku == "GFT-001":
                batches.append((f"{sku}-STD", 200, None, now - timedelta(days=30)))
            elif life is not None and life <= 30:
                if code == "AND01" and sku == "MLK-002":
                    # Demo scenario: 40 cartons expiring within ~48 hours of a slower-moving milk.
                    batches += [("MLK-002-B1", 40, today + timedelta(days=1), now - timedelta(days=2)),
                                ("MLK-002-B2", 30, today + timedelta(days=3), now - timedelta(hours=6))]
                elif code == "AND01" and sku == "DRY-004":
                    batches += [("DRY-004-B1", 30, today + timedelta(days=1), now - timedelta(days=4))]
                elif code == "AND01" and sku == "BRD-001":
                    batches += [("BRD-001-B1", 25, today + timedelta(days=1), now - timedelta(days=3)),
                                ("BRD-001-B2", 30, today + timedelta(days=4), now - timedelta(hours=8))]
                elif code == "AND01" and sku == "DRY-002":
                    batches += [("DRY-002-B0", 6, today - timedelta(days=1), now - timedelta(days=8)),
                                ("DRY-002-B1", 24, today + timedelta(days=5), now - timedelta(days=1))]
                elif code == "BAN01" and sku == "BKY-002":
                    batches += [("BKY-002-B1", 18, today + timedelta(days=1), now - timedelta(days=1))]
                else:
                    total = max(4, round(avg * special_cover.get(sku, rng.uniform(2.5, 4.0))))
                    first = total // 2
                    exp1 = today + timedelta(days=max(2, min(life, rng.randint(2, max(2, life)))))
                    exp2 = today + timedelta(days=life)
                    batches += [(f"{sku}-{code}-A", first, exp1, now - timedelta(days=max(0, life - (exp1 - today).days))),
                                (f"{sku}-{code}-B", total - first, exp2, now - timedelta(hours=10))]
            else:
                cover = special_cover.get(sku, rng.uniform(6, 30))
                if sku.startswith("ELE"):
                    qty = max(2, round(max(avg, 0.15) * cover)) if sku not in ("ELE-001", "ELE-002", "ELE-006") else rng.randint(3, 6)
                else:
                    qty = max(3, round(avg * cover))
                exp = (today + timedelta(days=spec[8])) if spec[8] else None
                batches.append((f"{sku}-{code}-STD", qty, exp, now - timedelta(days=rng.randint(3, 25))))
            for bcode, qty, exp, received in batches:
                bid = uuid.uuid4()
                batch_rows.append({"id": bid, "merchant_id": mid, "store_id": store.id, "product_id": p.id,
                                   "inventory_item_id": item.id, "batch_code": bcode, "quantity_received": qty,
                                   "quantity_remaining": qty, "received_at": received, "expiry_date": exp,
                                   "status": "active" if qty > 0 else "depleted", "markdown_price": None,
                                   "markdown_pct": None, "in_clearance": False,
                                   "created_at": received, "updated_at": received})
                adj_rows.append({"id": uuid.uuid4(), "merchant_id": mid, "store_id": store.id, "product_id": p.id,
                                 "batch_id": bid, "delta": qty, "quantity_after": None, "reason": "receive",
                                 "note": "demo seed opening stock", "reference": "seed", "actor_id": None,
                                 "created_at": received, "_item": item})
            item.quantity_on_hand = sum(b[1] for b in batches)
    db.execute(insert(InventoryBatch), batch_rows)
    running: dict[uuid.UUID, int] = defaultdict(int)
    for a_ in sorted(adj_rows, key=lambda r: r["created_at"]):
        running[a_["_item"].id] += a_["delta"]
        a_["quantity_after"] = running[a_["_item"].id]
    db.execute(insert(StockAdjustment), [{k_: v_ for k_, v_ in r.items() if k_ != "_item"} for r in adj_rows])

    # inventory-adjustment anomaly: repeated manual write-offs by one associate (synthetic)
    for i, sku in enumerate(["CHO-001", "ELE-003", "CHO-004", "ELE-009", "PRC-002"]):
        item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == and01.id,
                                                      InventoryItem.product_id == products[(fm.id, sku)].id)).first()
        batch = db.scalars(select(InventoryBatch).where(InventoryBatch.inventory_item_id == item.id)).first()
        qty = 10 + i * 2
        if batch.quantity_remaining < qty + 2:
            batch.quantity_remaining += 20
            batch.quantity_received += 20
            item.quantity_on_hand += 20
            db.add(StockAdjustment(merchant_id=fm.id, store_id=and01.id, product_id=item.product_id, batch_id=batch.id,
                                   delta=20, quantity_after=item.quantity_on_hand, reason="receive",
                                   note="replenishment", actor_id=associate.id, created_at=now - timedelta(days=7 - i)))
        batch.quantity_remaining -= qty
        item.quantity_on_hand -= qty
        db.add(StockAdjustment(merchant_id=fm.id, store_id=and01.id, product_id=item.product_id, batch_id=batch.id,
                               delta=-qty, quantity_after=item.quantity_on_hand, reason="damage",
                               note="damaged in storage", actor_id=associate.id, created_at=now - timedelta(days=6 - i, hours=3)))
    db.flush()

    # ---------------------------------------------------------------- promotions
    def promo(merchant: Merchant, name: str, desc: str, skus: list[str], pct: float, start_: datetime, end_: datetime,
              status: str, store: Store | None = None, geofence: int | None = None, trigger: str = "manual") -> Promotion:
        p = Promotion(merchant_id=merchant.id, store_id=store.id if store else None, name=name, description=desc,
                      promo_type="percent_off", discount_value=_d(pct), status=status, trigger=trigger, starts_at=start_,
                      ends_at=end_, usage_limit=500, per_customer_limit=1, geofence_radius_m=geofence,
                      created_by_id=admin.id, approved_by_id=admin.id, approved_at=start_)
        p.products = [PromotionProduct(product_id=products[(merchant.id, s)].id) for s in skus]
        db.add(p)
        return p

    promo(fm, "Monsoon Tea Time", "10% off selected tea and biscuits", ["TEA-001", "TEA-002", "BIS-001"], 10,
          now - timedelta(days=5), now + timedelta(days=9), "active")
    promo(fm, "Nearby: Hot drinks 15% off", "Exclusive for shoppers near FreshMart Andheri: hot chocolate & coffee",
          ["BEV-003", "COF-001"], 15, now - timedelta(days=1), now + timedelta(days=7), "active", store=and01,
          geofence=1000, trigger="weather")
    promo(fm, "Snack Attack Weekend", "10% off chips and KitKat", ["SNK-001", "CHO-003"], 10,
          now - timedelta(days=24), now - timedelta(days=17), "ended")
    promo(ub, "UrbanBasket Fresh Start", "5% off milk", ["MLK-001"], 5, now - timedelta(days=2),
          now + timedelta(days=5), "active")

    # ---------------------------------------------------------------- shopping lists
    from app.services import shopping_service

    db.commit()
    sl = shopping_service.create_list(db, priya, name="Weekend breakfast", store_id=and01.id,
                                      raw_input="milk, brown bread, eggs, butter, bananas, quinoa",
                                      items=[{"raw_text": t} for t in ["milk", "brown bread", "eggs", "butter", "bananas", "quinoa"]])
    sl.is_shared = True
    db.add(ListMembership(list_id=sl.id, user_id=rohan.id, role="editor"))
    shopping_service.create_list(db, rohan, name="Monthly household", store_id=and01.id, raw_input=None,
                                 items=[{"raw_text": t} for t in ["detergent", "dishwash", "toothpaste", "toilet cleaner"]])
    db.commit()

    from app.services.inventory_service import sample_import_csv

    sample = get_settings().sample_data_dir / "inventory_import_sample.csv"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text(sample_import_csv(today), encoding="utf-8")

    summary = {"merchants": 2, "stores": len(stores), "products": len(products), "transactions": len(txn_rows),
               "transaction_items": len(item_rows), "fraud_labels": len(labels), "batches": len(batch_rows)}
    if run_analytics:
        summary["analytics"] = run_initial_analytics(db, [fm, ub])
    return summary


def run_initial_analytics(db: Session, merchants: list[Merchant]) -> dict:
    from app.services import (
        cross_selling_service,
        expiry_service,
        forecasting_service,
        fraud_service,
        merchandising_service,
    )

    out = {}
    for m in merchants:
        res: dict = {"embeddings": reindex_products(db, m.id)}
        run = AffinityRun(merchant_id=m.id, window_days=90, min_support=0.005, min_confidence=0.1, min_pair_count=20)
        db.add(run)
        db.commit()
        cross_selling_service.run_affinity(db, run)
        res["affinity_rules"] = run.rules_found
        for store in db.scalars(select(Store).where(Store.merchant_id == m.id)):
            fr = forecasting_service.create_run(db, merchant_id=m.id, store_id=store.id, horizon_days=14, history_days=120,
                                                actor_id=None, params={"seed": True})
            forecasting_service.run_forecast(db, fr)
            res[f"forecast_{store.code}"] = fr.metrics.get("model_wins")
        res["expiry"] = expiry_service.evaluate_merchant(db, m.id)["batches_evaluated"]
        for store in db.scalars(select(Store).where(Store.merchant_id == m.id)):
            res[f"merch_{store.code}"] = len(merchandising_service.generate(db, store))
        res["fraud"] = fraud_service.scan(db, m.id, days=30)
        out[m.slug] = res
    return out
