"""Inventory: batch-level stock ledger, adjustments and CSV/XLSX import.

Invariants
* All stock lives in ``inventory_batches``; ``inventory_items.quantity_on_hand`` is recomputed as
  the sum of remaining batch quantities whenever a batch changes.
* Every quantity change writes a ``stock_adjustments`` row (who, why, delta, resulting quantity).
* Decrements consume batches first-expiry-first-out (FEFO).
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.exceptions import BusinessRuleError, NotFoundError, ValidationFailedError
from app.db.models import (
    ImportJob,
    ImportJobRow,
    InventoryBatch,
    InventoryItem,
    Product,
    ProductCategory,
    ProductPlacement,
    ShelfLocation,
    StockAdjustment,
    Store,
    User,
)
from app.services import catalog_service
from app.services.audit_service import record_audit

# ---------------------------------------------------------------------------
# Stock ledger
# ---------------------------------------------------------------------------


def get_or_create_item(db: Session, store: Store, product: Product) -> InventoryItem:
    item = db.scalars(
        select(InventoryItem).where(InventoryItem.store_id == store.id, InventoryItem.product_id == product.id)
    ).first()
    if item is None:
        item = InventoryItem(merchant_id=store.merchant_id, store_id=store.id, product_id=product.id, quantity_on_hand=0)
        db.add(item)
        db.flush()
    return item


def recompute_item(db: Session, item: InventoryItem) -> int:
    db.flush()
    total = db.scalar(
        select(func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0)).where(
            InventoryBatch.inventory_item_id == item.id
        )
    )
    item.quantity_on_hand = int(total or 0)
    return item.quantity_on_hand


def _log(db: Session, batch: InventoryBatch | None, item: InventoryItem, delta: int, reason: str,
         actor: User | None, note: str | None, reference: str | None) -> None:
    after = recompute_item(db, item)
    db.add(StockAdjustment(merchant_id=item.merchant_id, store_id=item.store_id, product_id=item.product_id,
                           batch_id=batch.id if batch else None, delta=delta, quantity_after=after, reason=reason,
                           note=note, reference=reference, actor_id=actor.id if actor else None))


def receive_batch(db: Session, store: Store, product: Product, *, batch_code: str, quantity: int,
                  expiry_date: date | None, actor: User | None, reason: str = "receive",
                  reference: str | None = None, received_at: datetime | None = None) -> InventoryBatch:
    if quantity < 0:
        raise BusinessRuleError("Quantity cannot be negative")
    if product.is_perishable and expiry_date is None:
        raise BusinessRuleError("Perishable products require an expiry date")
    item = get_or_create_item(db, store, product)
    batch = db.scalars(select(InventoryBatch).where(
        InventoryBatch.store_id == store.id, InventoryBatch.product_id == product.id,
        InventoryBatch.batch_code == batch_code)).first()
    if batch is not None:
        raise BusinessRuleError(f"Batch {batch_code} already exists for this product at this store")
    batch = InventoryBatch(merchant_id=store.merchant_id, store_id=store.id, product_id=product.id,
                           inventory_item_id=item.id, batch_code=batch_code, quantity_received=quantity,
                           quantity_remaining=quantity, expiry_date=expiry_date,
                           received_at=received_at or datetime.now(UTC),
                           status="depleted" if quantity == 0 else "active")
    db.add(batch)
    db.flush()
    _log(db, batch, item, quantity, reason, actor, None, reference)
    return batch


def set_batch_quantity(db: Session, batch: InventoryBatch, new_quantity: int, *, reason: str, actor: User | None,
                       note: str | None = None, reference: str | None = None) -> int:
    if new_quantity < 0:
        raise BusinessRuleError("Quantity cannot be negative")
    delta = new_quantity - batch.quantity_remaining
    if delta == 0:
        return 0
    batch.quantity_remaining = new_quantity
    if new_quantity > batch.quantity_received:
        batch.quantity_received = new_quantity
    if new_quantity == 0 and batch.status in ("active", "markdown", "clearance"):
        batch.status = "depleted"
    elif new_quantity > 0 and batch.status == "depleted":
        batch.status = "active"
    _log(db, batch, batch.inventory_item, delta, reason, actor, note, reference)
    return delta


def consume_fefo(db: Session, item: InventoryItem, quantity: int, *, reason: str, actor: User | None,
                 note: str | None = None, reference: str | None = None) -> list[tuple[InventoryBatch, int]]:
    """Remove ``quantity`` units from the earliest-expiring sellable batches."""
    if quantity <= 0:
        raise BusinessRuleError("Quantity to remove must be positive")
    batches = db.scalars(
        select(InventoryBatch).where(InventoryBatch.inventory_item_id == item.id, InventoryBatch.quantity_remaining > 0)
        .order_by(InventoryBatch.expiry_date.is_(None), InventoryBatch.expiry_date, InventoryBatch.received_at)
    ).all()
    available = sum(b.quantity_remaining for b in batches)
    if available < quantity:
        raise BusinessRuleError(f"Only {available} units available; cannot remove {quantity}")
    taken: list[tuple[InventoryBatch, int]] = []
    remaining = quantity
    for b in batches:
        if remaining == 0:
            break
        take = min(b.quantity_remaining, remaining)
        set_batch_quantity(db, b, b.quantity_remaining - take, reason=reason, actor=actor, note=note, reference=reference)
        taken.append((b, take))
        remaining -= take
    return taken


def adjust_stock(db: Session, *, store: Store, product: Product, delta: int, reason: str, actor: User,
                 batch_id: uuid.UUID | None = None, note: str | None = None, expiry_date: date | None = None,
                 batch_code: str | None = None) -> InventoryItem:
    item = get_or_create_item(db, store, product)
    before = item.quantity_on_hand
    if batch_id:
        batch = db.get(InventoryBatch, batch_id)
        if batch is None or batch.inventory_item_id != item.id:
            raise NotFoundError("Batch not found for this product/store")
        set_batch_quantity(db, batch, batch.quantity_remaining + delta, reason=reason, actor=actor, note=note)
    elif delta > 0:
        code = batch_code or f"RCV-{datetime.now(UTC):%Y%m%d%H%M%S}"
        receive_batch(db, store, product, batch_code=code, quantity=delta, expiry_date=expiry_date, actor=actor,
                      reason=reason)
    elif delta < 0:
        consume_fefo(db, item, -delta, reason=reason, actor=actor, note=note)
    else:
        raise BusinessRuleError("Adjustment delta cannot be zero")
    record_audit(db, action="inventory.adjust", entity_type="inventory_item", entity_id=item.id,
                 summary=f"{product.name} @ {store.code}: {before} -> {item.quantity_on_hand} ({reason})",
                 actor=actor, merchant_id=store.merchant_id,
                 before={"quantity": before}, after={"quantity": item.quantity_on_hand, "reason": reason, "note": note})
    return item


# ---------------------------------------------------------------------------
# Inventory queries
# ---------------------------------------------------------------------------


def list_inventory(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID], *, q: str | None,
                   category_id: uuid.UUID | None, stock_status: str | None, offset: int, limit: int) -> tuple[list[InventoryItem], int]:
    stmt = (
        select(InventoryItem)
        .join(Product, Product.id == InventoryItem.product_id)
        .where(InventoryItem.merchant_id == merchant_id, InventoryItem.store_id.in_(store_ids))
    )
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Product.name).like(like), func.lower(Product.sku).like(like)))
    if category_id:
        stmt = stmt.where(Product.category_id == category_id)
    if stock_status == "out_of_stock":
        stmt = stmt.where(InventoryItem.quantity_on_hand <= 0)
    elif stock_status == "low_stock":
        stmt = stmt.where(InventoryItem.quantity_on_hand > 0, InventoryItem.quantity_on_hand <= InventoryItem.reorder_point)
    elif stock_status == "in_stock":
        stmt = stmt.where(InventoryItem.quantity_on_hand > InventoryItem.reorder_point)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Product.name, InventoryItem.store_id).offset(offset).limit(limit)).all()
    return list(rows), int(total or 0)


# ---------------------------------------------------------------------------
# CSV / XLSX import
# ---------------------------------------------------------------------------

IMPORT_COLUMNS = [
    "product_id", "product_name", "description", "category", "price", "cost_price", "stock_quantity", "store_id",
    "aisle_id", "shelf_location", "shelf_coordinates", "batch_id", "expiry_date", "target_segment",
    "min_allowed_price", "promotion_eligible",
]
REQUIRED_COLUMNS = {"product_id", "store_id", "stock_quantity"}
_FOREIGN_CURRENCY = re.compile(r"[$€£¥]|usd|eur|gbp", re.I)
_TRUE = {"true", "yes", "y", "1"}
_FALSE = {"false", "no", "n", "0"}


def sample_import_rows(today: date) -> list[list[str]]:
    """Demo import file: valid updates, a new product, a short-dated batch, and deliberate errors."""
    tomorrow = (today + timedelta(days=1)).isoformat()
    yesterday = (today - timedelta(days=1)).isoformat()
    return [
        IMPORT_COLUMNS,
        ["MLK-003", "Mother Dairy Cow Milk 500 ml", "", "Dairy", "32", "24", "30", "BAN01", "D", "D-3-2", "",
         "MLK-003-B10", tomorrow, "families", "25", "true"],
        ["BEV-005", "Masala Chai Premix 500 g", "Instant masala chai premix", "Tea & Coffee", "210", "150", "36", "AND01",
         "A1", "A1-R-4-2", "", "", "", "all", "170", "true"],
        ["PRC-003", "", "", "", "", "", "55", "AND01", "", "", "", "", "", "", "", ""],
        ["SEA-001", "", "", "", "", "", "45", "AND01", "A6", "", "36.6;16.2", "", "", "", "", ""],
        ["BRD-002", "", "", "", "", "", "20", "AND01", "", "Q9-9-9", "", "BRD-002-B20", tomorrow, "", "", ""],
        ["DRY-002", "", "", "", "", "", "4", "AND01", "", "", "", "DRY-002-OLD", yesterday, "", "", ""],
        ["TEA-001", "", "", "", "", "", "-5", "AND01", "", "", "", "", "", "", "", ""],
        ["CHO-001", "", "", "", "", "", "12", "AND01", "", "", "", "", "31/31/2026", "", "", ""],
        ["NEW-404", "Mystery Snack", "", "Snacks & Confectionery", "", "", "10", "AND01", "", "", "", "", "", "", "", ""],
        ["SNK-001", "", "", "", "", "", "10", "ZZZ99", "", "", "", "", "", "", "", ""],
        ["COF-001", "", "", "", "$4.99", "", "10", "AND01", "", "", "", "", "", "", "", ""],
        ["HHD-002", "", "", "", "", "", "10", "AND01", "", "", "", "", "", "", "300", ""],
        ["BEV-005", "Masala Chai Premix 500 g", "", "Tea & Coffee", "210", "150", "36", "AND01", "", "", "", "", "",
         "", "", ""],
    ]


def sample_import_csv(today: date) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(sample_import_rows(today))
    return buf.getvalue()


def csv_template() -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(IMPORT_COLUMNS)
    w.writerow(["MLK-001", "Amul Taaza Toned Milk 1 L", "Toned milk, 1 litre pouch", "Dairy", "68", "58", "40",
                "AND01", "D", "D-2-2", "", "MLK-001-B9", date.today().isoformat(), "families", "55", "true"])
    w.writerow(["SEA-001", "Folding Umbrella", "Compact 3-fold umbrella", "Seasonal", "399", "250", "25",
                "AND01", "A6", "A6-R-3-3", "", "", "", "all", "299", "true"])
    return buf.getvalue()


def _parse_money(raw: str) -> Decimal:
    s = raw.strip()
    if _FOREIGN_CURRENCY.search(s):
        raise ValueError("only INR amounts are supported")
    s = re.sub(r"(?i)^(rs\.?|inr|₹)\s*", "", s).replace(",", "").strip()
    try:
        v = Decimal(s)
    except InvalidOperation as exc:
        raise ValueError("not a valid amount") from exc
    if v.as_tuple().exponent < -2:
        raise ValueError("more than 2 decimal places")
    return v


def _parse_date(raw: str) -> date:
    s = raw.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError("expected YYYY-MM-DD or DD/MM/YYYY")


def _read_rows(filename: str, content: bytes) -> list[dict[str, str]]:
    name = filename.lower()
    if name.endswith(".xlsx"):
        from openpyxl import load_workbook

        try:
            wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as exc:
            raise ValidationFailedError("The file is not a readable .xlsx workbook") from exc
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []
        header = [str(h or "").strip().lower() for h in rows[0]]
        out = []
        for r in rows[1:]:
            vals = ["" if v is None else (v.isoformat() if isinstance(v, (date, datetime)) else str(v)) for v in r]
            if any(v.strip() for v in vals):
                out.append({header[i]: vals[i] for i in range(min(len(header), len(vals)))})
        return out
    if not name.endswith((".csv", ".txt")):
        raise ValidationFailedError("Unsupported file type; upload a .csv or .xlsx file")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValidationFailedError("The file must be UTF-8 encoded") from exc
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return []
    reader.fieldnames = [f.strip().lower() for f in reader.fieldnames]
    return [{k: (v or "") for k, v in r.items() if k} for r in reader if any((v or "").strip() for v in r.values())]


@dataclass
class _Ctx:
    merchant_id: uuid.UUID
    stores_by_code: dict[str, Store]
    stores_by_id: dict[str, Store]
    allowed_store_ids: set[uuid.UUID]
    products: dict[str, Product]
    categories: dict[str, ProductCategory]
    shelves: dict[uuid.UUID, dict[str, ShelfLocation]]  # store_id -> code -> shelf (active layout)


def _load_ctx(db: Session, merchant_id: uuid.UUID, allowed_store_ids: set[uuid.UUID]) -> _Ctx:
    stores = db.scalars(select(Store).where(Store.merchant_id == merchant_id)).all()
    shelves: dict[uuid.UUID, dict[str, ShelfLocation]] = {}
    for st in stores:
        layout = catalog_service.active_layout(db, st.id)
        if layout:
            shelves[st.id] = {s.code: s for s in db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id))}
    return _Ctx(
        merchant_id=merchant_id,
        stores_by_code={s.code.upper(): s for s in stores},
        stores_by_id={str(s.id): s for s in stores},
        allowed_store_ids=allowed_store_ids,
        products={p.sku.upper(): p for p in db.scalars(select(Product).where(Product.merchant_id == merchant_id))},
        categories={c.name.lower(): c for c in db.scalars(select(ProductCategory).where(ProductCategory.merchant_id == merchant_id))},
        shelves=shelves,
    )


def validate_row(raw: dict[str, str], ctx: _Ctx, seen_keys: dict[tuple, int], seen_products: dict[str, dict]) -> tuple[dict | None, list[dict], list[dict], str]:
    errors: list[dict] = []
    warnings: list[dict] = []

    def err(f: str, m: str) -> None:
        errors.append({"field": f, "message": m})

    def warn(f: str, m: str) -> None:
        warnings.append({"field": f, "message": m})

    g = {k: (raw.get(k) or "").strip() for k in IMPORT_COLUMNS}
    sku = g["product_id"].upper()
    if not sku:
        err("product_id", "is required")
    elif not re.fullmatch(r"[A-Z0-9][A-Z0-9_\-\.]{0,63}", sku):
        err("product_id", "may only contain letters, digits, '-', '_' and '.'")
    existing = ctx.products.get(sku)
    out: dict = {"sku": sku}

    store = ctx.stores_by_code.get(g["store_id"].upper()) or ctx.stores_by_id.get(g["store_id"])
    if not g["store_id"]:
        err("store_id", "is required")
    elif store is None:
        err("store_id", f"unknown store '{g['store_id']}'")
    elif store.id not in ctx.allowed_store_ids:
        err("store_id", "you do not have access to this store")
    else:
        out["store_id"] = str(store.id)
        out["store_code"] = store.code

    if existing is None:
        for f in ("product_name", "category", "price", "cost_price"):
            if not g[f]:
                err(f, "is required for a new product")
    out["name"] = g["product_name"] or (existing.name if existing else None)
    if g["product_name"] and len(g["product_name"]) > 160:
        err("product_name", "must be at most 160 characters")
    out["description"] = g["description"] or None

    for f in ("price", "cost_price", "min_allowed_price"):
        if g[f]:
            try:
                v = _parse_money(g[f])
                if v < 0:
                    err(f, "cannot be negative")
                elif f == "price" and v == 0:
                    err(f, "must be greater than zero")
                out[f] = str(v)
            except ValueError as exc:
                err(f, str(exc))
    price = Decimal(out["price"]) if "price" in out else (existing.price if existing else None)
    cost = Decimal(out["cost_price"]) if "cost_price" in out else (existing.cost_price if existing else None)
    floor = Decimal(out["min_allowed_price"]) if "min_allowed_price" in out else (existing.min_allowed_price if existing else None)
    if price is not None and floor is not None and floor > price:
        err("min_allowed_price", "cannot exceed price")
    if price is not None and cost is not None and cost > price:
        warn("cost_price", "cost price is higher than selling price (negative margin)")

    if g["category"]:
        out["category"] = g["category"]
        if g["category"].lower() not in ctx.categories:
            warn("category", f"new category '{g['category']}' will be created")

    if not g["stock_quantity"]:
        err("stock_quantity", "is required")
    else:
        try:
            qf = float(g["stock_quantity"].replace(",", ""))
            if qf != int(qf):
                err("stock_quantity", "must be a whole number")
            elif qf < 0:
                err("stock_quantity", "cannot be negative")
            elif qf > 1_000_000:
                err("stock_quantity", "is unrealistically large")
            else:
                out["stock_quantity"] = int(qf)
        except ValueError:
            err("stock_quantity", "must be a number")

    if g["expiry_date"]:
        try:
            exp = _parse_date(g["expiry_date"])
            out["expiry_date"] = exp.isoformat()
            if exp < datetime.now(UTC).date():
                warn("expiry_date", "date is in the past; the batch will be recorded as expired and not sellable")
        except ValueError as exc:
            err("expiry_date", str(exc))

    perishable = existing.is_perishable if existing else bool(
        ctx.categories.get(g["category"].lower()).is_perishable if g["category"].lower() in ctx.categories else False
    )
    out["is_perishable"] = perishable
    if perishable and not g["expiry_date"]:
        err("expiry_date", "is required for perishable products")
    out["batch_code"] = g["batch_id"] or None
    if perishable and not g["batch_id"]:
        warn("batch_id", "no batch id given; one will be generated from the expiry date")

    if g["promotion_eligible"]:
        v = g["promotion_eligible"].lower()
        if v in _TRUE:
            out["promotion_eligible"] = True
        elif v in _FALSE:
            out["promotion_eligible"] = False
        else:
            err("promotion_eligible", "must be true/false")
    out["target_segment"] = g["target_segment"] or None

    # Location: shelf code must exist in the store's active layout; never invented.
    if store is not None and (g["shelf_location"] or g["aisle_id"] or g["shelf_coordinates"]):
        shelves = ctx.shelves.get(store.id, {})
        shelf = shelves.get(g["shelf_location"].upper()) if g["shelf_location"] else None
        if g["shelf_location"] and shelf is None:
            warn("shelf_location", f"shelf '{g['shelf_location']}' not found in the active layout; location left unresolved")
        if shelf is None and g["shelf_coordinates"]:
            m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*[;,| ]\s*(-?\d+(?:\.\d+)?)\s*", g["shelf_coordinates"])
            if not m:
                err("shelf_coordinates", "expected 'x;y' in metres")
            else:
                x, y = float(m.group(1)), float(m.group(2))
                cands = [s for s in shelves.values() if not g["aisle_id"] or s.aisle_code == g["aisle_id"].upper()]
                near = min(cands, key=lambda s: (s.x - x) ** 2 + (s.y - y) ** 2 + s.level * 1e-6, default=None)
                if near and (near.x - x) ** 2 + (near.y - y) ** 2 <= 1.5 ** 2:
                    shelf = near
                    warn("shelf_coordinates", f"resolved to nearest shelf {near.code}")
                else:
                    warn("shelf_coordinates", "no shelf within 1.5 m; location left unresolved")
        if shelf is not None and g["aisle_id"] and shelf.aisle_code != g["aisle_id"].upper():
            err("aisle_id", f"shelf {shelf.code} is in {shelf.aisle_code}, not {g['aisle_id']}")
        if shelf is not None:
            out["shelf_location_id"] = str(shelf.id)
            out["shelf_code"] = shelf.code

    key = (sku, out.get("store_id"), (out["batch_code"] or "").upper())
    if sku and key in seen_keys:
        err("product_id", f"duplicate of row {seen_keys[key]} (same product, store and batch)")
    if sku:
        prev = seen_products.get(sku)
        if prev:
            for f in ("price", "name"):
                if out.get(f) and prev.get(f) and out[f] != prev[f]:
                    err("product_id", f"conflicting {f} for {sku} across rows")
        else:
            seen_products[sku] = {"price": out.get("price"), "name": g["product_name"] or None}

    action = "update" if existing else "create"
    return (out if not errors else None), errors, warnings, action


def stage_import(db: Session, *, merchant_id: uuid.UUID, allowed_store_ids: set[uuid.UUID], filename: str,
                 content: bytes, idempotency_key: str | None, actor: User) -> ImportJob:
    s = get_settings()
    if len(content) > s.max_upload_bytes:
        raise ValidationFailedError(f"File exceeds the {s.max_upload_mb} MB limit")
    sha = hashlib.sha256(content).hexdigest()
    key = idempotency_key or sha
    existing = db.scalars(select(ImportJob).where(ImportJob.merchant_id == merchant_id, ImportJob.idempotency_key == key)).first()
    if existing:
        return existing
    rows = _read_rows(filename, content)
    if not rows:
        raise ValidationFailedError("The file has no data rows")
    missing = REQUIRED_COLUMNS - set(rows[0].keys())
    if missing:
        raise ValidationFailedError("Missing required columns", details={"missing": sorted(missing),
                                                                          "expected": IMPORT_COLUMNS})
    if len(rows) > s.max_csv_rows:
        raise ValidationFailedError(f"Too many rows ({len(rows)}); the limit is {s.max_csv_rows}")
    unknown = sorted(set(rows[0].keys()) - set(IMPORT_COLUMNS))
    ctx = _load_ctx(db, merchant_id, allowed_store_ids)
    prior = db.scalars(select(ImportJob).where(ImportJob.merchant_id == merchant_id, ImportJob.file_sha256 == sha,
                                               ImportJob.status == "completed")).first()
    job = ImportJob(merchant_id=merchant_id, filename=filename[:255], file_sha256=sha, idempotency_key=key,
                    status="validated", total_rows=len(rows), created_by_id=actor.id)
    db.add(job)
    db.flush()
    seen_keys: dict[tuple, int] = {}
    seen_products: dict[str, dict] = {}
    counts = {"create": 0, "update": 0}
    new_skus: set[str] = set()
    for i, raw in enumerate(rows, start=2):  # row 1 is the header
        normalized, errors, warnings, action = validate_row(raw, ctx, seen_keys, seen_products)
        if normalized:
            seen_keys[(normalized["sku"], normalized.get("store_id"), (normalized.get("batch_code") or "").upper())] = i
            counts[action] += 1
            if action == "create":
                new_skus.add(normalized["sku"])
        db.add(ImportJobRow(job_id=job.id, row_number=i, raw={k: raw.get(k, "") for k in raw}, normalized=normalized,
                            errors=errors, warnings=warnings, action=action if normalized else "skip",
                            is_valid=normalized is not None))
        job.valid_rows += normalized is not None
        job.error_rows += normalized is None
        job.warning_rows += bool(warnings)
    job.summary = {"would_create_products": len(new_skus),
                   "rows_creating": counts["create"], "rows_updating": counts["update"],
                   "unknown_columns": unknown,
                   "previously_imported_at": prior.committed_at.isoformat() if prior and prior.committed_at else None}
    record_audit(db, action="inventory.import.validated", entity_type="import_job", entity_id=job.id,
                 summary=f"Validated {filename}: {job.valid_rows} valid, {job.error_rows} with errors",
                 actor=actor, merchant_id=merchant_id)
    db.commit()
    return job


def commit_import(db: Session, job: ImportJob, actor: User | None) -> ImportJob:
    """Apply all valid rows in one transaction. Rows with errors are skipped (never partially applied)."""
    if job.status == "completed":
        return job
    if job.status not in ("validated", "committing"):
        raise BusinessRuleError(f"Import is {job.status} and cannot be committed")
    if job.valid_rows == 0:
        raise BusinessRuleError("There are no valid rows to import")
    ctx_products = {p.sku.upper(): p for p in db.scalars(select(Product).where(Product.merchant_id == job.merchant_id))}
    categories = {c.name.lower(): c for c in db.scalars(select(ProductCategory).where(ProductCategory.merchant_id == job.merchant_id))}
    stats = {"products_created": 0, "products_updated": 0, "batches_created": 0, "batches_updated": 0,
             "placements_set": 0, "units_delta": 0}
    rows = db.scalars(select(ImportJobRow).where(ImportJobRow.job_id == job.id, ImportJobRow.is_valid.is_(True))
                      .order_by(ImportJobRow.row_number)).all()
    ref = f"import:{job.id}"
    try:
        for r in rows:
            n = r.normalized or {}
            store = db.get(Store, uuid.UUID(n["store_id"]))
            product = ctx_products.get(n["sku"])
            cat = None
            if n.get("category"):
                cat = categories.get(n["category"].lower())
                if cat is None:
                    slug = re.sub(r"[^a-z0-9]+", "-", n["category"].lower()).strip("-")
                    cat = ProductCategory(merchant_id=job.merchant_id, name=n["category"], slug=slug)
                    db.add(cat)
                    db.flush()
                    categories[n["category"].lower()] = cat
            if product is None:
                product = Product(merchant_id=job.merchant_id, sku=n["sku"], name=n["name"],
                                  description=n.get("description") or "", category_id=cat.id if cat else None,
                                  price=Decimal(n["price"]), cost_price=Decimal(n["cost_price"]),
                                  min_allowed_price=Decimal(n["min_allowed_price"]) if n.get("min_allowed_price") else None,
                                  target_segment=n.get("target_segment"),
                                  promotion_eligible=n.get("promotion_eligible", True),
                                  is_perishable=bool(cat.is_perishable) if cat else False)
                db.add(product)
                db.flush()
                ctx_products[n["sku"]] = product
                stats["products_created"] += 1
            else:
                changed = False
                for field_name, value in (("name", n.get("name")), ("description", n.get("description")),
                                          ("target_segment", n.get("target_segment"))):
                    if value and getattr(product, field_name) != value:
                        setattr(product, field_name, value)
                        changed = True
                for field_name in ("price", "cost_price", "min_allowed_price"):
                    if n.get(field_name) is not None and getattr(product, field_name) != Decimal(n[field_name]):
                        setattr(product, field_name, Decimal(n[field_name]))
                        changed = True
                if "promotion_eligible" in n and product.promotion_eligible != n["promotion_eligible"]:
                    product.promotion_eligible = n["promotion_eligible"]
                    changed = True
                if cat and product.category_id != cat.id:
                    product.category_id = cat.id
                    changed = True
                stats["products_updated"] += changed

            expiry = date.fromisoformat(n["expiry_date"]) if n.get("expiry_date") else None
            # Rows without a batch id address the store's standard batch for that product, so
            # stock_quantity behaves as a stock count (not an additive receipt).
            code = n.get("batch_code") or (f"{product.sku}-{store.code}-{expiry:%Y%m%d}" if expiry
                                           else f"{product.sku}-{store.code}-STD")
            item = get_or_create_item(db, store, product)
            batch = db.scalars(select(InventoryBatch).where(InventoryBatch.inventory_item_id == item.id,
                                                            InventoryBatch.batch_code == code)).first()
            qty = int(n["stock_quantity"])
            if batch is None:
                b = receive_batch(db, store, product, batch_code=code, quantity=qty, expiry_date=expiry, actor=actor,
                                  reason="import", reference=ref)
                if expiry and expiry < datetime.now(UTC).date():
                    b.status = "expired"
                stats["batches_created"] += 1
                stats["units_delta"] += qty
            else:
                if expiry and batch.expiry_date != expiry:
                    batch.expiry_date = expiry
                delta = set_batch_quantity(db, batch, qty, reason="import", actor=actor, reference=ref,
                                           note="stock count from import")
                stats["batches_updated"] += 1
                stats["units_delta"] += delta
            if n.get("shelf_location_id"):
                shelf = db.get(ShelfLocation, uuid.UUID(n["shelf_location_id"]))
                if shelf:
                    exists = db.scalars(select(ProductPlacement).where(
                        ProductPlacement.layout_id == shelf.layout_id, ProductPlacement.product_id == product.id)).all()
                    if not any(p.shelf_location_id == shelf.id for p in exists):
                        for p in exists:
                            p.is_primary = False
                        db.add(ProductPlacement(layout_id=shelf.layout_id, shelf_location_id=shelf.id,
                                                product_id=product.id, facings=2, is_primary=True))
                        stats["placements_set"] += 1
        job.status = "completed"
        job.committed_at = datetime.now(UTC)
        job.summary = {**(job.summary or {}), **stats}
        record_audit(db, action="inventory.import.committed", entity_type="import_job", entity_id=job.id,
                     summary=f"Imported {job.filename}: {stats}", actor=actor, merchant_id=job.merchant_id,
                     after=stats)
        db.commit()
    except Exception as exc:
        db.rollback()
        job = db.get(ImportJob, job.id)
        job.status, job.error_message = "failed", str(exc)[:2000]
        db.commit()
        raise
    catalog_service.invalidate_index(job.merchant_id)
    return job
