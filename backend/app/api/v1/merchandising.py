"""Store layouts (planogram editor) and merchandising recommendations."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_permission, resolve_store_ids
from app.core.exceptions import NotFoundError
from app.db.models import MerchandisingRecommendation, Product, StoreLayout
from app.db.session import get_db
from app.services import catalog_service, layout_service, merchandising_service
from app.services.audit_service import record_audit

router = APIRouter(prefix="/merchant", tags=["merchandising"])


@router.get("/stores/{store_id}/layouts")
def list_layouts(store_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.read")),
                 db: Session = Depends(get_db)) -> list[dict]:
    store = get_store_scoped(db, ctx, store_id)
    rows = db.scalars(select(StoreLayout).where(StoreLayout.store_id == store.id).order_by(StoreLayout.version.desc())).all()
    return [{"id": str(r.id), "name": r.name, "version": r.version, "status": r.status,
             "published_at": r.published_at.isoformat() if r.published_at else None,
             "created_at": r.created_at.isoformat()} for r in rows]


def _layout(db: Session, ctx: MerchantContext, layout_id: uuid.UUID) -> StoreLayout:
    layout = layout_service.get_layout(db, ctx.merchant_id, layout_id)
    get_store_scoped(db, ctx, layout.store_id)
    return layout


@router.get("/layouts/{layout_id}")
def layout_detail(layout_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.read")),
                  db: Session = Depends(get_db)) -> dict:
    return layout_service.layout_detail(db, _layout(db, ctx, layout_id))


@router.get("/layouts/{layout_id}/rules")
def layout_rules(layout_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.read")),
                 db: Session = Depends(get_db)) -> dict:
    """The placement rule book with live compliance for this layout (what the editor and the AI enforce)."""
    return layout_service.layout_compliance(db, _layout(db, ctx, layout_id))


@router.post("/stores/{store_id}/layouts/draft", status_code=status.HTTP_201_CREATED)
def create_draft(store_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.write")),
                 db: Session = Depends(get_db)) -> dict:
    """Clone the active layout into an editable draft (proposed layout)."""
    store = get_store_scoped(db, ctx, store_id)
    active = catalog_service.active_layout(db, store.id)
    if active is None:
        raise NotFoundError("Store has no active layout")
    draft = layout_service.clone_layout(db, active, ctx.user)
    db.commit()
    return layout_service.layout_detail(db, draft)


class PlaceBody(BaseModel):
    product_id: uuid.UUID
    shelf_code: str = Field(min_length=1, max_length=32)
    from_shelf_code: str | None = Field(default=None, max_length=32)
    facings: int = Field(default=1, ge=1, le=12)


@router.post("/layouts/{layout_id}/placements")
def place(layout_id: uuid.UUID, body: PlaceBody, ctx: MerchantContext = Depends(require_permission("layout.write")),
          db: Session = Depends(get_db)) -> dict:
    """Place or move a product on a draft layout. Hard constraints block; soft ones return warnings."""
    layout = _layout(db, ctx, layout_id)
    product = db.get(Product, body.product_id)
    if product is None or product.merchant_id != ctx.merchant_id:
        raise NotFoundError("Product not found")
    res = layout_service.place_product(db, layout, product=product, shelf_code=body.shelf_code, facings=body.facings,
                                       from_shelf_code=body.from_shelf_code, actor=ctx.user)
    db.commit()
    return res


@router.delete("/layouts/{layout_id}/placements/{placement_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_placement(layout_id: uuid.UUID, placement_id: uuid.UUID,
                     ctx: MerchantContext = Depends(require_permission("layout.write")), db: Session = Depends(get_db)) -> Response:
    layout_service.remove_placement(db, _layout(db, ctx, layout_id), placement_id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class MoveFixture(BaseModel):
    x: float = Field(ge=0, le=500)
    y: float = Field(ge=0, le=500)


@router.patch("/layouts/{layout_id}/fixtures/{fixture_id}")
def move_fixture(layout_id: uuid.UUID, fixture_id: uuid.UUID, body: MoveFixture,
                 ctx: MerchantContext = Depends(require_permission("layout.write")), db: Session = Depends(get_db)) -> dict:
    res = layout_service.move_fixture(db, _layout(db, ctx, layout_id), fixture_id, body.x, body.y)
    db.commit()
    return res


@router.post("/layouts/{layout_id}/publish")
def publish(layout_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.write")),
            db: Session = Depends(get_db)) -> dict:
    layout = layout_service.publish_draft(db, _layout(db, ctx, layout_id), ctx.user)
    db.commit()
    return {"id": str(layout.id), "status": layout.status, "version": layout.version}


@router.delete("/layouts/{layout_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard(layout_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.write")),
            db: Session = Depends(get_db)) -> Response:
    """Discard a draft layout (revert to the active layout)."""
    layout_service.discard_draft(db, _layout(db, ctx, layout_id), ctx.user)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/layouts/{layout_id}/diff")
def diff(layout_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.read")),
         db: Session = Depends(get_db)) -> dict:
    """Placement differences between this layout and the store's active layout."""
    layout = _layout(db, ctx, layout_id)
    active = catalog_service.active_layout(db, layout.store_id)
    return {"base_layout_id": str(active.id), "layout_id": str(layout.id),
            "changes": layout_service.diff_layouts(db, active, layout)}


# ---------------------------------------------------------------------------- recommendations


def _rec_out(r: MerchandisingRecommendation) -> dict:
    loc = lambda s: {"id": str(s.id), "code": s.code, "level": s.level, "fixture": s.fixture.label, "x": s.x, "y": s.y} if s else None  # noqa: E731
    return {"id": str(r.id), "store_id": str(r.store_id), "rec_type": r.rec_type, "title": r.title,
            "product_id": str(r.product_id), "product": r.product.name,
            "related_product_id": str(r.related_product_id) if r.related_product_id else None,
            "related_product": r.related_product.name if r.related_product else None,
            "current_location": loc(r.current_location), "proposed_location": loc(r.proposed_location),
            "rationale": r.rationale, "evidence": r.evidence, "evidence_quality": r.evidence_quality,
            "expected_metric": r.expected_metric, "implementation_steps": r.implementation_steps,
            "ab_test_plan": r.ab_test_plan, "status": r.status, "review_note": r.review_note,
            "implemented_at": r.implemented_at.isoformat() if r.implemented_at else None, "outcome": r.outcome,
            "created_at": r.created_at.isoformat()}


@router.get("/merchandising/recommendations")
def list_recs(store_id: uuid.UUID | None = None, status_filter: str | None = Query(None, alias="status"),
              ctx: MerchantContext = Depends(require_permission("merchandising.read")), db: Session = Depends(get_db)) -> list[dict]:
    store_ids = resolve_store_ids(db, ctx, store_id)
    stmt = select(MerchandisingRecommendation).where(MerchandisingRecommendation.store_id.in_(store_ids))
    if status_filter:
        stmt = stmt.where(MerchandisingRecommendation.status.in_(status_filter.split(",")))
    return [_rec_out(r) for r in db.scalars(stmt.order_by(MerchandisingRecommendation.created_at.desc()).limit(100))]


@router.post("/merchandising/recommendations/generate")
def generate(store_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("merchandising.manage")),
             db: Session = Depends(get_db)) -> dict:
    store = get_store_scoped(db, ctx, store_id)
    recs = merchandising_service.generate(db, store, ctx.user)
    return {"created": len(recs), "recommendations": [_rec_out(r) for r in recs]}


def _rec(db: Session, ctx: MerchantContext, rec_id: uuid.UUID) -> MerchandisingRecommendation:
    r = merchandising_service.get_rec(db, ctx.merchant_id, rec_id)
    get_store_scoped(db, ctx, r.store_id)
    return r


@router.get("/merchandising/recommendations/{rec_id}")
def get_rec(rec_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("merchandising.read")),
            db: Session = Depends(get_db)) -> dict:
    r = _rec(db, ctx, rec_id)
    out = _rec_out(r)
    if r.status in ("implemented", "completed"):
        out["live_outcome"] = merchandising_service.measure_outcome(db, r)
    return out


class ReviewBody(BaseModel):
    status: str = Field(pattern="^(accepted|rejected|implemented|completed)$")
    note: str | None = Field(default=None, max_length=500)


@router.post("/merchandising/recommendations/{rec_id}/review")
def review(rec_id: uuid.UUID, body: ReviewBody, ctx: MerchantContext = Depends(require_permission("merchandising.manage")),
           db: Session = Depends(get_db)) -> dict:
    r = merchandising_service.review(db, _rec(db, ctx, rec_id), body.status, ctx.user, body.note)
    db.commit()
    return _rec_out(r)


@router.post("/merchandising/recommendations/{rec_id}/apply-to-draft")
def apply_to_draft(rec_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("layout.write")),
                   db: Session = Depends(get_db)) -> dict:
    r = _rec(db, ctx, rec_id)
    res = merchandising_service.apply_to_draft(db, r, ctx.user)
    record_audit(db, action="merchandising.recommendation.applied", entity_type="merchandising_recommendation",
                 entity_id=r.id, summary=f"Applied to draft layout: {r.title}", actor=ctx.user, merchant_id=ctx.merchant_id)
    db.commit()
    return res
