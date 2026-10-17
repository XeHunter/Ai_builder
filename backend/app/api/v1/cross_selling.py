"""Product-affinity analytics: runs, association rules, category heatmap and network graph."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_permission
from app.core.exceptions import NotFoundError
from app.db.models import AffinityRule, AffinityRun, CategoryAffinity, ProductCategory
from app.db.session import get_db
from app.tasks.queue import enqueue

router = APIRouter(prefix="/merchant/affinity", tags=["cross-selling"])


class RunCreate(BaseModel):
    store_id: uuid.UUID | None = None
    window_days: int = Field(default=90, ge=7, le=365)
    min_support: float = Field(default=0.005, gt=0, le=0.5)
    min_confidence: float = Field(default=0.1, ge=0, le=1)
    min_pair_count: int = Field(default=20, ge=5, le=10000)


def _run_out(r: AffinityRun) -> dict:
    return {"id": str(r.id), "store_id": str(r.store_id) if r.store_id else None, "status": r.status,
            "window_days": r.window_days, "min_support": r.min_support, "min_confidence": r.min_confidence,
            "min_pair_count": r.min_pair_count, "transactions_analyzed": r.transactions_analyzed,
            "rules_found": r.rules_found, "error": r.error, "created_at": r.created_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED)
def create_run(body: RunCreate, ctx: MerchantContext = Depends(require_permission("affinity.run")),
               db: Session = Depends(get_db)) -> dict:
    if body.store_id:
        get_store_scoped(db, ctx, body.store_id)
    run = AffinityRun(merchant_id=ctx.merchant_id, created_by_id=ctx.user.id, **body.model_dump())
    db.add(run)
    db.commit()
    job = enqueue(db, "affinity_run", {"run_id": str(run.id)}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id,
                  max_attempts=1)
    db.refresh(run)
    return {**_run_out(run), "job_id": str(job.id)}


@router.get("/runs")
def list_runs(ctx: MerchantContext = Depends(require_permission("affinity.read")), db: Session = Depends(get_db)) -> list[dict]:
    return [_run_out(r) for r in db.scalars(select(AffinityRun).where(AffinityRun.merchant_id == ctx.merchant_id)
                                            .order_by(AffinityRun.created_at.desc()).limit(30))]


def _owned(db: Session, ctx: MerchantContext, run_id: uuid.UUID) -> AffinityRun:
    r = db.get(AffinityRun, run_id)
    if r is None or r.merchant_id != ctx.merchant_id:
        raise NotFoundError("Affinity run not found")
    return r


@router.get("/runs/{run_id}")
def get_run(run_id: uuid.UUID, min_lift: float = Query(1.0, ge=0), limit: int = Query(100, ge=1, le=1000),
            ctx: MerchantContext = Depends(require_permission("affinity.read")), db: Session = Depends(get_db)) -> dict:
    r = _owned(db, ctx, run_id)
    rules = db.scalars(select(AffinityRule).where(AffinityRule.run_id == r.id, AffinityRule.lift >= min_lift)
                       .order_by(AffinityRule.lift.desc(), AffinityRule.pair_count.desc()).limit(limit)).all()
    return {**_run_out(r), "rules": [{
        "antecedent_id": str(x.antecedent_id), "antecedent": x.antecedent.name,
        "consequent_id": str(x.consequent_id), "consequent": x.consequent.name, "pair_count": x.pair_count,
        "support": x.support, "confidence": x.confidence, "lift": x.lift, "antecedent_support": x.antecedent_support,
        "consequent_support": x.consequent_support} for x in rules],
        "interpretation": "Lift > 1: bought together more often than if independent. This is correlation in past "
                          "baskets, not evidence that one product causes the other's purchase."}


@router.get("/runs/{run_id}/heatmap")
def category_heatmap(run_id: uuid.UUID, ctx: MerchantContext = Depends(require_permission("affinity.read")),
                     db: Session = Depends(get_db)) -> dict:
    """Symmetric category x category lift matrix (cells without enough co-purchases are null)."""
    r = _owned(db, ctx, run_id)
    rows = db.scalars(select(CategoryAffinity).where(CategoryAffinity.run_id == r.id)).all()
    cats = {c.id: c.name for c in db.scalars(select(ProductCategory).where(ProductCategory.merchant_id == ctx.merchant_id))}
    used = sorted({x.category_a_id for x in rows} | {x.category_b_id for x in rows}, key=lambda c: cats.get(c, ""))
    idx = {c: i for i, c in enumerate(used)}
    matrix: list[list[float | None]] = [[None] * len(used) for _ in used]
    counts: list[list[int]] = [[0] * len(used) for _ in used]
    for x in rows:
        i, j = idx[x.category_a_id], idx[x.category_b_id]
        matrix[i][j] = matrix[j][i] = x.lift
        counts[i][j] = counts[j][i] = x.pair_count
    return {"categories": [cats.get(c, "?") for c in used], "lift": matrix, "pair_counts": counts}


@router.get("/runs/{run_id}/graph")
def product_graph(run_id: uuid.UUID, min_lift: float = Query(1.5, ge=1), max_edges: int = Query(60, ge=1, le=300),
                  ctx: MerchantContext = Depends(require_permission("affinity.read")), db: Session = Depends(get_db)) -> dict:
    r = _owned(db, ctx, run_id)
    rules = db.scalars(select(AffinityRule).where(AffinityRule.run_id == r.id, AffinityRule.lift >= min_lift)
                       .order_by(AffinityRule.lift.desc())).all()
    edges, seen = [], set()
    for x in rules:
        key = tuple(sorted((str(x.antecedent_id), str(x.consequent_id))))
        if key in seen:
            continue
        seen.add(key)
        edges.append({"source": str(x.antecedent_id), "target": str(x.consequent_id), "lift": x.lift,
                      "pair_count": x.pair_count, "confidence": x.confidence})
        if len(edges) >= max_edges:
            break
    names = {}
    for x in rules:
        names[str(x.antecedent_id)] = (x.antecedent.name, x.antecedent.category.name if x.antecedent.category else None)
        names[str(x.consequent_id)] = (x.consequent.name, x.consequent.category.name if x.consequent.category else None)
    node_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
    return {"nodes": [{"id": n, "name": names[n][0], "category": names[n][1]} for n in sorted(node_ids)], "edges": edges}
