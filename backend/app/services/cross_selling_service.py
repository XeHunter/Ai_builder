"""Product-affinity analysis runs (job ``affinity_run``) and cross-selling queries."""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.analytics.basket_analysis.association import InsufficientData, mine_pair_rules
from app.db.models import (
    AffinityRule,
    AffinityRun,
    CategoryAffinity,
    Product,
    ProductRelation,
    SalesTransaction,
    TransactionItem,
)


def load_baskets(db: Session, merchant_id: uuid.UUID, store_id: uuid.UUID | None, since: datetime) -> list[frozenset]:
    stmt = (
        select(TransactionItem.transaction_id, TransactionItem.product_id)
        .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
        .where(SalesTransaction.merchant_id == merchant_id, SalesTransaction.transaction_type == "sale",
               SalesTransaction.occurred_at >= since)
    )
    if store_id:
        stmt = stmt.where(SalesTransaction.store_id == store_id)
    baskets: dict[uuid.UUID, set] = defaultdict(set)
    for tid, pid in db.execute(stmt):
        baskets[tid].add(pid)
    return [frozenset(b) for b in baskets.values()]


def run_affinity(db: Session, run: AffinityRun) -> AffinityRun:
    run.status = "running"
    db.commit()
    since = datetime.now(UTC) - timedelta(days=run.window_days)
    baskets = load_baskets(db, run.merchant_id, run.store_id, since)
    db.execute(delete(AffinityRule).where(AffinityRule.run_id == run.id))
    db.execute(delete(CategoryAffinity).where(CategoryAffinity.run_id == run.id))
    run.transactions_analyzed = len(baskets)
    try:
        rules, _, n = mine_pair_rules(baskets, min_support=run.min_support, min_confidence=run.min_confidence,
                                      min_pair_count=run.min_pair_count)
    except InsufficientData as exc:
        run.status, run.error, run.finished_at = "failed", str(exc), datetime.now(UTC)
        db.commit()
        return run
    for r in rules:
        db.add(AffinityRule(run_id=run.id, antecedent_id=r.antecedent, consequent_id=r.consequent,
                            pair_count=r.pair_count, support=r.support, confidence=r.confidence, lift=r.lift,
                            antecedent_support=r.antecedent_support, consequent_support=r.consequent_support))
    cat_of = dict(db.execute(select(Product.id, Product.category_id).where(Product.merchant_id == run.merchant_id)).all())
    cat_baskets = [frozenset(cat_of[p] for p in b if cat_of.get(p)) for b in baskets]
    try:
        crules, _, _ = mine_pair_rules(cat_baskets, min_support=0.01, min_confidence=0.0,
                                       min_pair_count=run.min_pair_count)
        seen = set()
        for r in crules:
            key = tuple(sorted((str(r.antecedent), str(r.consequent))))
            if key in seen:
                continue
            seen.add(key)
            db.add(CategoryAffinity(run_id=run.id, category_a_id=r.antecedent, category_b_id=r.consequent,
                                    pair_count=r.pair_count, support=r.support, lift=r.lift))
    except InsufficientData:
        pass
    run.rules_found = len(rules)
    run.status, run.finished_at = "succeeded", datetime.now(UTC)
    db.commit()
    return run


def latest_run(db: Session, merchant_id: uuid.UUID, store_id: uuid.UUID | None = None) -> AffinityRun | None:
    stmt = select(AffinityRun).where(AffinityRun.merchant_id == merchant_id, AffinityRun.status == "succeeded")
    stmt = stmt.where(AffinityRun.store_id == store_id) if store_id else stmt
    return db.scalars(stmt.order_by(AffinityRun.finished_at.desc())).first()


def complements_for(db: Session, merchant_id: uuid.UUID, product_id: uuid.UUID, store_id: uuid.UUID | None,
                    limit: int = 4) -> list[dict]:
    """Curated compatibility relations first, then mined co-purchase rules (with their evidence)."""
    out: list[dict] = []
    seen: set[uuid.UUID] = set()
    for rel in db.scalars(select(ProductRelation).where(ProductRelation.merchant_id == merchant_id,
                                                        ProductRelation.product_id == product_id,
                                                        ProductRelation.relation_type.in_(("compatible_accessory", "complement")))):
        seen.add(rel.related_product_id)
        out.append({"product_id": rel.related_product_id, "source": "merchant_relation",
                    "relation": rel.relation_type, "reason": rel.note or "Listed by the store as compatible."})
    run = latest_run(db, merchant_id, store_id) or latest_run(db, merchant_id)
    if run:
        for r in db.scalars(select(AffinityRule).where(AffinityRule.run_id == run.id,
                                                       AffinityRule.antecedent_id == product_id, AffinityRule.lift > 1.2)
                            .order_by(AffinityRule.lift.desc()).limit(limit * 2)):
            if r.consequent_id in seen:
                continue
            seen.add(r.consequent_id)
            out.append({"product_id": r.consequent_id, "source": "basket_analysis",
                        "reason": f"Bought together in {r.confidence * 100:.0f}% of baskets with this item "
                                  f"(lift {r.lift:.1f}, {r.pair_count} baskets).",
                        "confidence": r.confidence, "lift": r.lift})
    return out[:limit]
