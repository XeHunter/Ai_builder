"""Merchant inventory: stock levels, batches, adjustments and CSV/XLSX import."""

from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, Header, Query, UploadFile, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import (
    MerchantContext,
    get_store_scoped,
    page_params,
    require_permission,
    resolve_store_ids,
)
from app.core.config import get_settings
from app.core.exceptions import NotFoundError, ValidationFailedError
from app.db.models import (
    ImportJob,
    ImportJobRow,
    InventoryBatch,
    InventoryItem,
    Product,
    StockAdjustment,
    Store,
    User,
)
from app.db.session import get_db
from app.schemas.common import Page, PageParams
from app.services import catalog_service, inventory_service
from app.tasks.queue import enqueue

router = APIRouter(prefix="/merchant/inventory", tags=["inventory"])


class BatchOut(BaseModel):
    id: str
    batch_code: str
    quantity_received: int
    quantity_remaining: int
    received_at: str
    expiry_date: str | None
    days_to_expiry: int | None
    status: str
    markdown_price: float | None
    markdown_pct: int | None
    in_clearance: bool


class InventoryRow(BaseModel):
    id: str
    store_id: str
    store_code: str
    product_id: str
    sku: str
    name: str
    category: str | None
    is_perishable: bool
    quantity_on_hand: int
    reorder_point: int
    reorder_quantity: int
    price: float
    stock_status: str
    shelf_code: str | None
    next_expiry: str | None
    batch_count: int


class InventoryDetail(InventoryRow):
    batches: list[BatchOut]
    adjustments: list[dict]


class AdjustRequest(BaseModel):
    delta: int = Field(ne=0, ge=-100000, le=100000)
    reason: str = Field(pattern="^(receive|count_correction|damage|manual|return)$")
    note: str | None = Field(default=None, max_length=255)
    batch_id: uuid.UUID | None = None
    batch_code: str | None = Field(default=None, max_length=64)
    expiry_date: date | None = None


class ItemSettings(BaseModel):
    reorder_point: int | None = Field(default=None, ge=0, le=100000)
    reorder_quantity: int | None = Field(default=None, ge=1, le=100000)


def _row(db: Session, item: InventoryItem, stores: dict[uuid.UUID, Store], layout_locs: dict) -> dict:
    p: Product = item.product
    live = [b for b in item.batches if b.quantity_remaining > 0 and b.status not in ("expired", "withdrawn")]
    exp = sorted(b.expiry_date for b in live if b.expiry_date)
    status_ = "out_of_stock" if item.quantity_on_hand <= 0 else "low_stock" if item.quantity_on_hand <= item.reorder_point else "in_stock"
    loc = layout_locs.get((item.store_id, item.product_id))
    return {"id": str(item.id), "store_id": str(item.store_id), "store_code": stores[item.store_id].code,
            "product_id": str(p.id), "sku": p.sku, "name": p.name, "category": p.category.name if p.category else None,
            "is_perishable": p.is_perishable, "quantity_on_hand": item.quantity_on_hand,
            "reorder_point": item.reorder_point, "reorder_quantity": item.reorder_quantity,
            "price": float(item.price_override if item.price_override is not None else p.price),
            "stock_status": status_, "shelf_code": loc.code if loc else None,
            "next_expiry": exp[0].isoformat() if exp else None, "batch_count": len(live)}


def _locs(db: Session, items: list[InventoryItem]) -> dict:
    out = {}
    for sid in {i.store_id for i in items}:
        layout = catalog_service.active_layout(db, sid)
        locs = catalog_service.product_locations(db, layout.id if layout else None,
                                                 [i.product_id for i in items if i.store_id == sid])
        out.update({(sid, pid): loc for pid, loc in locs.items()})
    return out


@router.get("", response_model=Page[InventoryRow])
def list_inventory(
    store_id: uuid.UUID | None = None,
    q: str | None = Query(None, max_length=100),
    category_id: uuid.UUID | None = None,
    stock_status: str | None = Query(None, pattern="^(in_stock|low_stock|out_of_stock)$"),
    pp: PageParams = Depends(page_params),
    ctx: MerchantContext = Depends(require_permission("inventory.read")),
    db: Session = Depends(get_db),
) -> dict:
    store_ids = resolve_store_ids(db, ctx, store_id)
    items, total = inventory_service.list_inventory(db, ctx.merchant_id, store_ids, q=q, category_id=category_id,
                                                    stock_status=stock_status, offset=pp.offset, limit=pp.page_size)
    stores = {s.id: s for s in db.scalars(select(Store).where(Store.id.in_(store_ids)))}
    locs = _locs(db, items)
    return {"items": [_row(db, i, stores, locs) for i in items], "total": total, "page": pp.page, "page_size": pp.page_size}


def _item(db: Session, ctx: MerchantContext, item_id: uuid.UUID) -> InventoryItem:
    item = db.get(InventoryItem, item_id)
    if item is None or item.merchant_id != ctx.merchant_id:
        raise NotFoundError("Inventory item not found")
    get_store_scoped(db, ctx, item.store_id)
    return item


def _batch_out(b: InventoryBatch) -> dict:
    return {"id": str(b.id), "batch_code": b.batch_code, "quantity_received": b.quantity_received,
            "quantity_remaining": b.quantity_remaining, "received_at": b.received_at.isoformat(),
            "expiry_date": b.expiry_date.isoformat() if b.expiry_date else None,
            "days_to_expiry": (b.expiry_date - date.today()).days if b.expiry_date else None, "status": b.status,
            "markdown_price": float(b.markdown_price) if b.markdown_price is not None else None,
            "markdown_pct": b.markdown_pct, "in_clearance": b.in_clearance}


@router.get("/items/{item_id}", response_model=InventoryDetail)
def item_detail(item_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("inventory.read")),
                db: Session = Depends(get_db)) -> dict:
    item = _item(db, ctx, item_id)
    stores = {item.store_id: db.get(Store, item.store_id)}
    row = _row(db, item, stores, _locs(db, [item]))
    adj = db.scalars(select(StockAdjustment).where(StockAdjustment.store_id == item.store_id,
                                                   StockAdjustment.product_id == item.product_id)
                     .order_by(StockAdjustment.created_at.desc()).limit(50)).all()
    actors = {u.id: u.full_name for u in db.scalars(select(User).where(User.id.in_({a.actor_id for a in adj if a.actor_id})))}
    row["batches"] = [_batch_out(b) for b in sorted(item.batches, key=lambda b: (b.expiry_date is None, b.expiry_date, b.received_at))]
    row["adjustments"] = [{"id": str(a.id), "delta": a.delta, "quantity_after": a.quantity_after, "reason": a.reason,
                           "note": a.note, "reference": a.reference, "actor": actors.get(a.actor_id, "system"),
                           "created_at": a.created_at.isoformat()} for a in adj]
    return row


@router.post("/items/{item_id}/adjust", response_model=InventoryDetail)
def adjust(item_id: uuid.UUID, body: AdjustRequest, ctx: MerchantContext = Depends(require_permission("inventory.write")),
           db: Session = Depends(get_db)) -> dict:
    """Receive stock (positive delta creates a batch) or remove stock (FEFO across batches)."""
    item = _item(db, ctx, item_id)
    store = db.get(Store, item.store_id)
    inventory_service.adjust_stock(db, store=store, product=item.product, delta=body.delta, reason=body.reason,
                                   actor=ctx.user, batch_id=body.batch_id, note=body.note,
                                   expiry_date=body.expiry_date, batch_code=body.batch_code)
    db.commit()
    return item_detail(item_id, ctx, db)


@router.patch("/items/{item_id}", response_model=InventoryDetail)
def update_item_settings(item_id: uuid.UUID, body: ItemSettings,
                         ctx: MerchantContext = Depends(require_permission("inventory.write")),
                         db: Session = Depends(get_db)) -> dict:
    item = _item(db, ctx, item_id)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(item, k, v)
    db.commit()
    return item_detail(item_id, ctx, db)


@router.get("/adjustments/recent")
def recent_adjustments(store_id: uuid.UUID | None = None, limit: int = Query(50, ge=1, le=200),
                       ctx: MerchantContext = Depends(require_permission("inventory.read")),
                       db: Session = Depends(get_db)) -> list[dict]:
    store_ids = resolve_store_ids(db, ctx, store_id)
    rows = db.execute(select(StockAdjustment, Product.name).join(Product, Product.id == StockAdjustment.product_id)
                      .where(StockAdjustment.store_id.in_(store_ids))
                      .order_by(StockAdjustment.created_at.desc()).limit(limit)).all()
    return [{"id": str(a.id), "product": n, "delta": a.delta, "quantity_after": a.quantity_after, "reason": a.reason,
             "note": a.note, "created_at": a.created_at.isoformat()} for a, n in rows]


# ---------------------------------------------------------------------------- imports


class ImportJobOut(BaseModel):
    id: str
    filename: str
    status: str
    total_rows: int
    valid_rows: int
    error_rows: int
    warning_rows: int
    summary: dict
    error_message: str | None
    created_at: str
    committed_at: str | None


class ImportRowOut(BaseModel):
    row_number: int
    is_valid: bool
    action: str
    raw: dict
    normalized: dict | None
    errors: list[dict]
    warnings: list[dict]


def _job_out(j: ImportJob) -> dict:
    return {"id": str(j.id), "filename": j.filename, "status": j.status, "total_rows": j.total_rows,
            "valid_rows": j.valid_rows, "error_rows": j.error_rows, "warning_rows": j.warning_rows,
            "summary": j.summary or {}, "error_message": j.error_message, "created_at": j.created_at.isoformat(),
            "committed_at": j.committed_at.isoformat() if j.committed_at else None}


@router.get("/imports/template", response_class=PlainTextResponse)
def import_template(_: MerchantContext = Depends(require_permission("inventory.import"))) -> PlainTextResponse:
    return PlainTextResponse(inventory_service.csv_template(), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="omnipulse_inventory_template.csv"'})


@router.get("/imports/sample", response_class=PlainTextResponse)
def import_sample(_: MerchantContext = Depends(require_permission("inventory.import"))) -> PlainTextResponse:
    """Demo file with valid rows, a new product, a short-dated batch and deliberate validation errors."""
    return PlainTextResponse(inventory_service.sample_import_csv(date.today()), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="omnipulse_sample_import.csv"'})


@router.post("/imports", response_model=ImportJobOut, status_code=status.HTTP_201_CREATED)
def upload_import(
    file: UploadFile = File(...),
    idempotency_key: str | None = Header(default=None, max_length=80),
    ctx: MerchantContext = Depends(require_permission("inventory.import")),
    db: Session = Depends(get_db),
) -> dict:
    """Validate a CSV/XLSX file and stage it for preview. Nothing changes until the import is committed."""
    limit = get_settings().max_upload_bytes
    content = file.file.read(limit + 1)
    if len(content) > limit:
        raise ValidationFailedError(f"File exceeds the {get_settings().max_upload_mb} MB limit")
    store_ids = set(resolve_store_ids(db, ctx, None))
    job = inventory_service.stage_import(db, merchant_id=ctx.merchant_id, allowed_store_ids=store_ids,
                                         filename=file.filename or "upload.csv", content=content,
                                         idempotency_key=idempotency_key, actor=ctx.user)
    return _job_out(job)


@router.get("/imports", response_model=list[ImportJobOut])
def list_imports(ctx: MerchantContext = Depends(require_permission("inventory.read")), db: Session = Depends(get_db)) -> list[dict]:
    return [_job_out(j) for j in db.scalars(select(ImportJob).where(ImportJob.merchant_id == ctx.merchant_id)
                                            .order_by(ImportJob.created_at.desc()).limit(50))]


def _job(db: Session, ctx: MerchantContext, job_id: uuid.UUID) -> ImportJob:
    j = db.get(ImportJob, job_id)
    if j is None or j.merchant_id != ctx.merchant_id:
        raise NotFoundError("Import not found")
    return j


@router.get("/imports/{job_id}", response_model=ImportJobOut)
def get_import(job_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("inventory.read")),
               db: Session = Depends(get_db)) -> dict:
    return _job_out(_job(db, ctx, job_id))


@router.get("/imports/{job_id}/rows", response_model=Page[ImportRowOut])
def import_rows(job_id: uuid.UUID, only: str | None = Query(None, pattern="^(errors|warnings|valid)$"),
                pp: PageParams = Depends(page_params), ctx: MerchantContext = Depends(require_permission("inventory.read")),
                db: Session = Depends(get_db)) -> dict:
    j = _job(db, ctx, job_id)
    stmt = select(ImportJobRow).where(ImportJobRow.job_id == j.id)
    if only == "errors":
        stmt = stmt.where(ImportJobRow.is_valid.is_(False))
    elif only == "valid":
        stmt = stmt.where(ImportJobRow.is_valid.is_(True))
    rows = db.scalars(stmt.order_by(ImportJobRow.row_number)).all()
    if only == "warnings":
        rows = [r for r in rows if r.warnings]
    total = len(rows)
    rows = rows[pp.offset : pp.offset + pp.page_size]
    return {"items": [{"row_number": r.row_number, "is_valid": r.is_valid, "action": r.action, "raw": r.raw,
                       "normalized": r.normalized, "errors": r.errors, "warnings": r.warnings} for r in rows],
            "total": total, "page": pp.page, "page_size": pp.page_size}


@router.post("/imports/{job_id}/commit", status_code=status.HTTP_202_ACCEPTED)
def commit_import(job_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("inventory.import")),
                  db: Session = Depends(get_db)) -> dict:
    """Queue the import for processing (idempotent: committing twice runs once)."""
    j = _job(db, ctx, job_id)
    if j.status == "completed":
        return {"job_id": None, "import": _job_out(j)}
    if j.valid_rows == 0:
        raise ValidationFailedError("There are no valid rows to import")
    j.status = "committing"
    db.commit()
    job = enqueue(db, "inventory_import_commit", {"import_id": str(j.id)}, merchant_id=ctx.merchant_id,
                  dedupe_key=f"import-commit:{j.id}", created_by_id=ctx.user.id, max_attempts=1)
    db.refresh(j)
    return {"job_id": str(job.id), "job_status": job.status, "import": _job_out(j)}


@router.post("/imports/{job_id}/cancel", response_model=ImportJobOut)
def cancel_import(job_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("inventory.import")),
                  db: Session = Depends(get_db)) -> dict:
    j = _job(db, ctx, job_id)
    if j.status != "validated":
        raise ValidationFailedError(f"Import is {j.status} and cannot be cancelled")
    j.status = "cancelled"
    db.commit()
    return _job_out(j)


