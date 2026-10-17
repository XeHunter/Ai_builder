"""Omnichannel connectors: how a store's POS, online storefront and other systems plug into OmniPulse.

Inbound (systems -> OmniPulse), authenticated with per-merchant API keys (``X-Api-Key``):
* Orders / sales from any POS or e-commerce platform (generic JSON, or a Shopify ``orders/create``
  webhook payload). Each sale consumes stock first-expiry-first-out, writes the stock ledger, flags
  low stock, and appears on the merchant's live feed (Firestore) within a second.
* Historical sales CSV (one-off backfill so forecasting / affinity have history from day one).

Outbound (OmniPulse -> systems):
* Catalog feed: price (incl. approved markdowns and live promotions), stock and shelf location per
  store, for an online storefront to sync from.
* Price publication to shelf labels / POS (``integrations/pos/pricing_publisher.py``).

All business rules stay in this backend; connectors only translate payloads.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import random
import secrets
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from app.core.exceptions import AuthenticationError, BusinessRuleError, NotFoundError, ValidationFailedError
from app.db.models import (
    ApiKey,
    InventoryItem,
    Product,
    SalesTransaction,
    Store,
    TransactionItem,
    User,
)
from app.integrations.firebase import firebase
from app.services import catalog_service, inventory_service, notification_service
from app.services.audit_service import record_audit

IST = ZoneInfo("Asia/Kolkata")
CHANNELS = ("pos", "self_checkout", "online")
SALES_CSV_COLUMNS = ["receipt_number", "occurred_at", "store_id", "channel", "product_id", "quantity", "unit_price"]
MAX_SALES_ROWS = 60_000

# What a store owner can connect. ``mode`` is what this deployment actually does with it.
CONNECTORS: list[dict] = [
    {"key": "pos_api", "channel": "pos", "name": "Any POS / billing software",
     "description": "Push each bill to the Orders API (webhook or batch). Works with any billing system that can call "
                    "an HTTPS endpoint, or through a small sync agent for desktop software.",
     "auth": "api_key", "mode": "live"},
    {"key": "pos_simulator", "channel": "pos", "name": "Built-in POS simulator",
     "description": "Ring up a bill from the browser to watch stock, expiry exposure and the live feed react.",
     "auth": "session", "mode": "simulated"},
    {"key": "shopify", "channel": "online", "name": "Shopify",
     "description": "Point a Shopify 'Order creation' webhook at the Shopify endpoint; line-item SKUs are matched to "
                    "your catalog.",
     "auth": "api_key", "mode": "live"},
    {"key": "storefront_api", "channel": "online", "name": "Custom website / app (Orders + Catalog API)",
     "description": "Pull prices, markdowns, promotions and stock from the catalog feed; push orders back.",
     "auth": "api_key", "mode": "live"},
    {"key": "omnipulse_app", "channel": "online", "name": "OmniPulse shopper app (click & collect)",
     "description": "Shoppers order their list for pickup inside the OmniPulse app. Enabled automatically.",
     "auth": "session", "mode": "live"},
    {"key": "sales_csv", "channel": "pos", "name": "Sales history CSV",
     "description": "One-time backfill of past bills (any POS export) so forecasts work from day one.",
     "auth": "session", "mode": "live"},
    {"key": "payments", "channel": "payments", "name": "Payments (UPI / cards)",
     "description": "Payment status is taken from the order payload; a payment-gateway adapter is simulated.",
     "auth": "api_key", "mode": "simulated"},
    {"key": "shelf_labels", "channel": "pricing", "name": "Electronic shelf labels / POS price sync",
     "description": "Approved price changes are published through the price publisher (simulated controller).",
     "auth": "none", "mode": "simulated"},
]


# ---------------------------------------------------------------------------------------- API keys


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_api_key(db: Session, *, merchant_id: uuid.UUID, store: Store | None, name: str, channel: str,
                   provider: str, actor: User) -> tuple[ApiKey, str]:
    raw = f"op_{'live' if channel != 'test' else 'test'}_{secrets.token_urlsafe(24)}"
    key = ApiKey(merchant_id=merchant_id, store_id=store.id if store else None, name=name, channel=channel,
                 provider=provider, prefix=raw[:12], key_hash=_hash(raw), created_by_id=actor.id)
    db.add(key)
    db.flush()
    record_audit(db, action="connector.key.created", entity_type="api_key", entity_id=key.id,
                 summary=f"API key '{name}' for {provider} ({channel})", actor=actor, merchant_id=merchant_id)
    db.commit()
    return key, raw


def authenticate_key(db: Session, raw: str | None) -> ApiKey:
    if not raw:
        raise AuthenticationError("Missing X-Api-Key header")
    key = db.scalars(select(ApiKey).where(ApiKey.key_hash == _hash(raw.strip()))).first()
    if key is None or key.revoked_at is not None:
        raise AuthenticationError("Invalid or revoked API key", code="invalid_api_key")
    key.last_used_at = datetime.now(UTC)
    key.usage_count = (key.usage_count or 0) + 1
    return key


def key_view(k: ApiKey, store_code: str | None = None) -> dict:
    return {"id": str(k.id), "name": k.name, "channel": k.channel, "provider": k.provider, "prefix": k.prefix,
            "store_id": str(k.store_id) if k.store_id else None, "store_code": store_code,
            "created_at": k.created_at.isoformat(), "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
            "usage_count": k.usage_count, "revoked": k.revoked_at is not None}


# ---------------------------------------------------------------------------------------- orders


@dataclass
class OrderLine:
    quantity: int
    sku: str | None = None
    product_id: uuid.UUID | None = None
    unit_price: Decimal | None = None


def resolve_store(db: Session, merchant_id: uuid.UUID, store_ref: str | None, default: uuid.UUID | None = None) -> Store:
    store = None
    if store_ref:
        try:
            store = db.get(Store, uuid.UUID(store_ref))
        except ValueError:
            store = db.scalars(select(Store).where(Store.merchant_id == merchant_id,
                                                   func.upper(Store.code) == store_ref.upper())).first()
    elif default:
        store = db.get(Store, default)
    if store is None or store.merchant_id != merchant_id:
        raise NotFoundError("Store not found; pass store_code (or bind the API key to a store)")
    return store


def ingest_order(db: Session, *, merchant_id: uuid.UUID, store: Store, channel: str, external_id: str | None,
                 lines: list[OrderLine], occurred_at: datetime | None = None, customer: User | None = None,
                 payment_method: str = "card", source: str = "api", is_simulated: bool = False,
                 terminal_id: str | None = None, actor: User | None = None, strict_stock: bool | None = None) -> dict:
    """Record a sale from any channel, consume stock FEFO and publish it to the live feed. Idempotent on
    ``external_id`` per merchant + channel (webhook retries are safe)."""
    if channel not in CHANNELS:
        raise ValidationFailedError(f"channel must be one of {', '.join(CHANNELS)}")
    if not lines:
        raise ValidationFailedError("An order needs at least one line")
    receipt = (external_id or f"{store.code}-{channel[:3].upper()}-{secrets.token_hex(4).upper()}")[:40]
    dup = db.scalars(select(SalesTransaction).where(SalesTransaction.merchant_id == merchant_id,
                                                    SalesTransaction.channel == channel,
                                                    SalesTransaction.receipt_number == receipt,
                                                    SalesTransaction.transaction_type == "sale")).first()
    if dup is not None:
        return {**order_view(db, dup), "duplicate": True}

    # Resolve products (by id or SKU), merging repeated lines.
    skus = {ln.sku.strip().upper() for ln in lines if ln.sku}
    by_sku = {p.sku.upper(): p for p in db.scalars(select(Product).where(Product.merchant_id == merchant_id,
                                                                         func.upper(Product.sku).in_(skus)))} if skus else {}
    merged: dict[uuid.UUID, tuple[Product, int, Decimal | None]] = {}
    unknown = []
    for ln in lines:
        if ln.quantity <= 0:
            raise ValidationFailedError("Line quantities must be positive")
        p = by_sku.get(ln.sku.strip().upper()) if ln.sku else (db.get(Product, ln.product_id) if ln.product_id else None)
        if p is None or p.merchant_id != merchant_id:
            unknown.append(ln.sku or str(ln.product_id))
            continue
        prev = merged.get(p.id)
        merged[p.id] = (p, (prev[1] if prev else 0) + ln.quantity, ln.unit_price or (prev[2] if prev else None))
    if unknown:
        raise NotFoundError(f"Unknown product(s) for this merchant: {', '.join(unknown[:10])}",
                            details={"unknown": unknown})

    # Online orders must be fulfillable; a POS bill already happened, so record it and flag the gap.
    strict = channel == "online" if strict_stock is None else strict_stock
    cards = {c["id"]: c for c in catalog_service.product_cards(db, store, [m[0] for m in merged.values()])}
    shortfalls = []
    for p, qty, _ in merged.values():
        item = inventory_service.get_or_create_item(db, store, p)
        if item.quantity_on_hand < qty:
            shortfalls.append({"sku": p.sku, "name": p.name, "requested": qty, "available": item.quantity_on_hand})
    if strict and shortfalls:
        raise BusinessRuleError("Not enough stock to fulfil this order", code="insufficient_stock",
                                details={"shortfalls": shortfalls})

    t = SalesTransaction(merchant_id=merchant_id, store_id=store.id, customer_id=customer.id if customer else None,
                         channel=channel, transaction_type="sale", receipt_number=receipt,
                         occurred_at=occurred_at or datetime.now(UTC), subtotal=Decimal(0), total=Decimal(0),
                         payment_method=payment_method[:16], terminal_id=terminal_id, is_simulated=is_simulated)
    db.add(t)
    db.flush()
    total = Decimal(0)
    low_stock = []
    for p, qty, given in merged.values():
        unit = given if given is not None else selling_price(cards.get(str(p.id)), p)
        line_total = (unit * qty).quantize(Decimal("0.01"))
        total += line_total
        db.add(TransactionItem(transaction_id=t.id, product_id=p.id, quantity=qty, unit_price=unit, line_total=line_total,
                               detected_quantity=qty if channel == "self_checkout" else None))
        item = inventory_service.get_or_create_item(db, store, p)
        take = min(qty, item.quantity_on_hand)
        if take > 0:
            inventory_service.consume_fefo(db, item, take, reason="sale", actor=actor, reference=receipt[:64],
                                           note=f"{channel} order via {source}")
        if item.quantity_on_hand <= item.reorder_point:
            low_stock.append({"sku": p.sku, "name": p.name, "on_hand": item.quantity_on_hand,
                              "reorder_point": item.reorder_point, "reorder_quantity": item.reorder_quantity})
    t.subtotal = t.total = total
    t.item_count = sum(m[1] for m in merged.values())
    for ls in low_stock:
        notification_service.notify_merchant_staff(
            db, merchant_id, "inventory.read", notification_type="stockout_alert",
            title=f"Low stock: {ls['name']}", body=f"{ls['on_hand']} left at {store.name} after a {channel} sale "
                                                   f"(reorder point {ls['reorder_point']}).",
            idempotency_key=f"lowstock:{store.id}:{ls['sku']}:{datetime.now(UTC):%Y%m%d}", link="/merchant/inventory")
    record_audit(db, action="channel.order.ingested", entity_type="sales_transaction", entity_id=t.id,
                 summary=f"{channel} order {receipt} via {source}: {t.item_count} items, ₹{total}",
                 actor=actor, merchant_id=merchant_id,
                 after={"source": source, "shortfalls": shortfalls, "low_stock": [s["sku"] for s in low_stock]})
    db.commit()
    view = order_view(db, t)
    firebase.merchant_feed(merchant_id, {
        "type": "order", "channel": channel, "source": source, "store_id": str(store.id), "store_code": store.code,
        "receipt": receipt, "total": float(total), "item_count": t.item_count, "is_simulated": is_simulated,
        "customer": customer.full_name if customer else None,
        "lines": [{"sku": ln["sku"], "name": ln["name"], "quantity": ln["quantity"]} for ln in view["lines"]][:20],
        "low_stock": low_stock, "shortfalls": shortfalls,
    })
    for ls in low_stock:
        firebase.merchant_feed(merchant_id, {"type": "low_stock", "store_id": str(store.id), "store_code": store.code, **ls})
    return {**view, "duplicate": False, "low_stock": low_stock, "shortfalls": shortfalls}


def selling_price(card: dict | None, p: Product) -> Decimal:
    """What the shopper pays right now: live promotion, else short-dated markdown, else shelf price."""
    if not card:
        return p.price
    candidates = [Decimal(str(card["price"]))]
    if card.get("promotion"):
        candidates.append(Decimal(str(card["promotion"]["price"])))
    if card.get("markdown"):
        candidates.append(Decimal(str(card["markdown"]["price"])))
    return min(candidates).quantize(Decimal("0.01"))


def order_view(db: Session, t: SalesTransaction) -> dict:
    store = db.get(Store, t.store_id)
    names = {p.id: p for p in catalog_service.load_products(db, [i.product_id for i in t.items])}
    customer = db.get(User, t.customer_id) if t.customer_id else None
    return {
        "id": str(t.id), "receipt_number": t.receipt_number, "channel": t.channel, "store_id": str(t.store_id),
        "store_code": store.code if store else None, "store_name": store.name if store else None,
        "occurred_at": t.occurred_at.isoformat(), "total": float(t.total), "item_count": t.item_count,
        "payment_method": t.payment_method, "is_simulated": t.is_simulated,
        "customer": customer.full_name if customer else None,
        "lines": [{"sku": names[i.product_id].sku if i.product_id in names else None,
                   "name": names[i.product_id].name if i.product_id in names else "Unknown product",
                   "quantity": i.quantity, "unit_price": float(i.unit_price), "line_total": float(i.line_total)}
                  for i in t.items],
    }


def recent_orders(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID] | None, limit: int = 25) -> list[dict]:
    stmt = (select(SalesTransaction).where(SalesTransaction.merchant_id == merchant_id,
                                           SalesTransaction.transaction_type == "sale")
            .order_by(SalesTransaction.occurred_at.desc()).limit(limit))
    if store_ids:
        stmt = stmt.where(SalesTransaction.store_id.in_(store_ids))
    return [order_view(db, t) for t in db.scalars(stmt)]


def channel_stats(db: Session, merchant_id: uuid.UUID, days: int = 1) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)
    rows = db.execute(
        select(SalesTransaction.channel, func.count(SalesTransaction.id), func.coalesce(func.sum(SalesTransaction.total), 0))
        .where(SalesTransaction.merchant_id == merchant_id, SalesTransaction.transaction_type == "sale",
               SalesTransaction.occurred_at >= since)
        .group_by(SalesTransaction.channel)).all()
    return {ch: {"orders": int(n), "revenue": float(rev)} for ch, n, rev in rows}


# ------------------------------------------------------------------------------- payload adapters


def lines_from_generic(items: list[dict]) -> list[OrderLine]:
    out = []
    for it in items:
        price = it.get("unit_price")
        out.append(OrderLine(quantity=int(it.get("quantity") or 0), sku=it.get("sku"),
                             product_id=uuid.UUID(str(it["product_id"])) if it.get("product_id") else None,
                             unit_price=Decimal(str(price)) if price not in (None, "") else None))
    return out


def lines_from_shopify(payload: dict) -> tuple[str, list[OrderLine], datetime | None, str]:
    """Map a Shopify ``orders/create`` webhook body. Only SKU, quantity and price are used."""
    items = payload.get("line_items") or []
    if not items:
        raise ValidationFailedError("Shopify order has no line_items")
    lines = []
    missing = []
    for li in items:
        sku = (li.get("sku") or "").strip()
        if not sku:
            missing.append(li.get("title") or li.get("name") or "line item")
            continue
        try:
            price = Decimal(str(li.get("price"))) if li.get("price") not in (None, "") else None
        except InvalidOperation:
            price = None
        lines.append(OrderLine(quantity=int(li.get("quantity") or 1), sku=sku, unit_price=price))
    if missing:
        raise ValidationFailedError(f"Line items without a SKU cannot be matched: {', '.join(missing[:5])}")
    ref = f"SHOPIFY-{payload.get('order_number') or payload.get('name') or payload.get('id')}".replace("#", "")
    created = None
    if payload.get("created_at"):
        try:
            created = datetime.fromisoformat(str(payload["created_at"]).replace("Z", "+00:00"))
        except ValueError:
            created = None
    gateway = (payload.get("payment_gateway_names") or ["card"])[0]
    return ref, lines, created, str(gateway)


# ---------------------------------------------------------------------------------- catalog feed


def catalog_feed(db: Session, store: Store, updated_since: datetime | None = None) -> dict:
    stmt = select(Product).where(Product.merchant_id == store.merchant_id, Product.status == "active").order_by(Product.sku)
    if updated_since:
        stmt = stmt.where(Product.updated_at >= updated_since)
    products = list(db.scalars(stmt))
    cards = catalog_service.product_cards(db, store, products)
    stock = {i.product_id: i.quantity_on_hand for i in db.scalars(select(InventoryItem).where(InventoryItem.store_id == store.id))}
    items = []
    for p, c in zip(products, cards, strict=True):
        items.append({"sku": p.sku, "name": p.name, "category": c["category"]["name"] if c.get("category") else None,
                      "list_price": float(p.price), "selling_price": float(selling_price(c, p)), "promotion": c.get("promotion"),
                      "markdown": c.get("markdown"), "stock": int(stock.get(p.id, 0)), "stock_level": c["stock_level"],
                      "shelf": (c.get("location") or {}).get("shelf_code"),
                      "image_url": c.get("image_url"), "updated_at": p.updated_at.isoformat()})
    return {"store_code": store.code, "store_name": store.name, "currency": "INR",
            "generated_at": datetime.now(UTC).isoformat(), "count": len(items), "items": items}


# ---------------------------------------------------------------------------- sales history CSV


def _parse_when(raw: str) -> datetime:
    raw = raw.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=IST).astimezone(UTC)
        except ValueError:
            continue
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.replace(tzinfo=IST)).astimezone(UTC)
    except ValueError as exc:
        raise ValueError(f"unrecognised date/time '{raw}'") from exc


def import_sales_history(db: Session, *, merchant_id: uuid.UUID, allowed_store_ids: set[uuid.UUID] | None,
                         content: bytes, actor: User) -> dict:
    """Backfill historical bills (no stock movement - history only). Rows are grouped by receipt."""
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    cols = {c.strip().lower() for c in (reader.fieldnames or [])}
    missing = {"receipt_number", "occurred_at", "store_id", "product_id", "quantity"} - cols
    if missing:
        raise ValidationFailedError(f"Missing column(s): {', '.join(sorted(missing))}",
                                    details={"expected": SALES_CSV_COLUMNS})
    stores = {s.code.upper(): s for s in db.scalars(select(Store).where(Store.merchant_id == merchant_id))}
    products = {p.sku.upper(): p for p in db.scalars(select(Product).where(Product.merchant_id == merchant_id))}
    existing = set(db.scalars(select(SalesTransaction.receipt_number).where(SalesTransaction.merchant_id == merchant_id)))
    errors: list[dict] = []
    receipts: dict[str, dict] = {}
    n = 0
    for n, raw in enumerate(reader, start=2):
        if n - 1 > MAX_SALES_ROWS:
            raise ValidationFailedError(f"File has more than {MAX_SALES_ROWS} rows; split it into smaller files")
        row = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k}
        try:
            store = stores.get(row["store_id"].upper())
            if store is None or (allowed_store_ids is not None and store.id not in allowed_store_ids):
                raise ValueError(f"unknown store '{row['store_id']}'")
            p = products.get(row["product_id"].upper())
            if p is None:
                raise ValueError(f"unknown product '{row['product_id']}'")
            qty = int(float(row["quantity"]))
            if qty <= 0:
                raise ValueError("quantity must be positive")
            price = Decimal(row["unit_price"]) if row.get("unit_price") else p.price
            when = _parse_when(row["occurred_at"])
            channel = (row.get("channel") or "pos").lower()
            if channel not in CHANNELS:
                raise ValueError(f"channel must be one of {', '.join(CHANNELS)}")
        except (ValueError, InvalidOperation, KeyError) as exc:
            if len(errors) < 50:
                errors.append({"row": n, "message": str(exc)})
            continue
        rec = receipts.setdefault(row["receipt_number"][:40], {"store": store, "when": when, "channel": channel, "lines": []})
        rec["lines"].append((p, qty, price))
    skipped_dupes = 0
    txn_rows, item_rows = [], []
    for receipt, rec in receipts.items():
        if receipt in existing:
            skipped_dupes += 1
            continue
        tid = uuid.uuid4()
        total = Decimal(0)
        for p, qty, price in rec["lines"]:
            lt = (price * qty).quantize(Decimal("0.01"))
            total += lt
            item_rows.append({"id": uuid.uuid4(), "transaction_id": tid, "product_id": p.id, "quantity": qty,
                              "detected_quantity": None, "unit_price": price, "discount": Decimal(0), "line_total": lt})
        txn_rows.append({"id": tid, "merchant_id": merchant_id, "store_id": rec["store"].id, "customer_id": None,
                         "channel": rec["channel"], "transaction_type": "sale", "receipt_number": receipt,
                         "original_transaction_id": None, "occurred_at": rec["when"], "subtotal": total,
                         "discount_total": Decimal(0), "total": total, "payment_method": "card", "terminal_id": None,
                         "item_count": sum(q for _, q, _ in rec["lines"]), "is_simulated": False})
    for i in range(0, len(txn_rows), 2000):
        db.execute(insert(SalesTransaction), txn_rows[i:i + 2000])
    for i in range(0, len(item_rows), 5000):
        db.execute(insert(TransactionItem), item_rows[i:i + 5000])
    stats = {"rows": max(0, n - 1), "receipts_imported": len(txn_rows), "lines_imported": len(item_rows),
             "duplicate_receipts_skipped": skipped_dupes, "error_rows": len(errors), "errors": errors}
    record_audit(db, action="channel.sales_history.imported", entity_type="merchant", entity_id=merchant_id,
                 summary=f"Imported {len(txn_rows)} historical receipts", actor=actor, merchant_id=merchant_id,
                 after={k: v for k, v in stats.items() if k != "errors"})
    db.commit()
    return stats


def starter_sales_csv(db: Session, store: Store, days: int = 60, per_day: int = 40, seed: int = 7) -> str:
    """A realistic sample sales export for a new store (basket 'missions' over its own catalog), so an
    owner can try the history import and see forecasts / affinity immediately."""
    from app.seed import catalog_data as C

    rng = random.Random(seed)
    products = {p.sku.upper(): p for p in db.scalars(select(Product).where(Product.merchant_id == store.merchant_id))}
    if len(products) < 5:
        raise BusinessRuleError("Add products to the catalog before generating sample sales")
    allowed = set(products)
    fallback = list(products)
    today = datetime.now(IST).date()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(SALES_CSV_COLUMNS)

    def pick(options: list[tuple[str, float]]) -> str:
        r = rng.random() * sum(x for _, x in options)
        for sku, x in options:
            r -= x
            if r <= 0:
                return sku
        return options[-1][0]

    for di in range(days, 0, -1):
        d: date = today - timedelta(days=di)
        n = int(per_day * (1.25 if d.weekday() >= 5 else 1.0) * (0.85 + 0.3 * rng.random()))
        for k in range(n):
            basket: dict[str, int] = defaultdict(int)
            mission = rng.choices(C.MISSIONS, weights=[m[1] for m in C.MISSIONS])[0]
            for prob, options in mission[2]:
                if rng.random() < prob:
                    sku = pick(options)
                    if sku in allowed:
                        basket[sku] += 1 if rng.random() < 0.85 else 2
            for a, b, p in C.ACCESSORY_RULES:
                if a in basket and b in allowed and rng.random() < p:
                    basket[b] = 1
            if not basket:
                basket[rng.choice(fallback)] = 1
            hour = rng.choices(range(8, 23), weights=[3, 5, 6, 5, 4, 4, 5, 6, 8, 10, 11, 9, 7, 4, 2])[0]
            when = datetime.combine(d, time(hour, rng.randint(0, 59)))
            channel = "online" if rng.random() < 0.12 else "pos"
            receipt = f"{store.code}-H{d:%y%m%d}-{k:04d}"
            for sku, qty in basket.items():
                w.writerow([receipt, when.strftime("%Y-%m-%d %H:%M"), store.code, channel, sku, qty, f"{products[sku].price}"])
    return buf.getvalue()


def random_basket(db: Session, store: Store, rng: random.Random | None = None, size: int | None = None) -> list[OrderLine]:
    """A plausible in-stock basket for the POS simulator."""
    rng = rng or random.Random()
    items = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store.id,
                                                   InventoryItem.quantity_on_hand > 0)).all()
    if not items:
        raise BusinessRuleError("This store has no stock to sell yet")
    chosen = rng.sample(items, k=min(len(items), size or rng.randint(2, 5)))
    return [OrderLine(quantity=min(it.quantity_on_hand, 1 if rng.random() < 0.8 else 2), product_id=it.product_id)
            for it in chosen]


def ceil_qty(q: float) -> int:
    return max(1, math.ceil(q))
