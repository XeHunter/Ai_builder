"""Merchandising recommendations for physical layouts.

Generators (all deterministic and evidence-based):
* ``adjacency_test`` - a strong co-purchase rule (lift, confidence, pair count) whose products are far
  apart on the walking graph: test a secondary placement of the consequent near the antecedent.
* ``eye_level_test`` - a high-velocity, healthy-margin product on the bottom shelf: test moving it to
  an eye-level shelf in the same fixture (a visibility test, framed as an experiment).
* ``safety_relocation`` - heavy items placed above the safe height: move down (not optional).

Every recommendation carries the evidence used, an evidence-quality band, the metric to watch, an
A/B test plan and implementation steps. Expected outcomes are hypotheses to test, never promised
uplift. Children's products and confectionery are never targeted with checkout or child-eye-level
placements (see ``layout_service.PLACEMENT_RULES``).
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import (
    AffinityRule,
    MerchandisingRecommendation,
    Product,
    ProductPlacement,
    SalesTransaction,
    ShelfLocation,
    Store,
    TransactionItem,
    User,
)
from app.services import catalog_service, cross_selling_service, layout_service, navigation_service
from app.services.audit_service import record_audit
from app.services.pricing_policy import margin_pct

FAR_APART_M = 12.0
OPEN_STATUSES = ("proposed", "accepted", "implemented")


def _evidence_quality(pair_count: int, lift: float) -> str:
    if pair_count >= 100 and lift >= 2:
        return "high"
    if pair_count >= 40 and lift >= 1.5:
        return "medium"
    return "low"


def _ab_plan(baseline_rate: float, weekly_baskets: float, metric: str) -> dict:
    p = min(max(baseline_rate, 0.01), 0.95)
    mde = max(0.25 * p, 0.02)  # detect a 25% relative change (min 2 points)
    n = math.ceil(16 * p * (1 - p) / mde**2)  # per arm, ~80% power at alpha 0.05 (rule of thumb)
    weeks = max(2, math.ceil(2 * n / max(weekly_baskets, 1)))
    return {"design": "Alternate weeks (or matched control store): control = current placement, treatment = proposed",
            "primary_metric": metric, "baseline_rate": round(p, 3), "minimum_detectable_change": round(mde, 3),
            "baskets_needed_per_arm": n, "estimated_duration_weeks": min(weeks, 12),
            "stop_rule": "Run for the planned duration; do not stop early on a promising interim result."}


def _locations(db: Session, layout_id: uuid.UUID) -> tuple[dict[uuid.UUID, list[ShelfLocation]], dict[uuid.UUID, int]]:
    rows = db.execute(select(ProductPlacement, ShelfLocation)
                      .join(ShelfLocation, ShelfLocation.id == ProductPlacement.shelf_location_id)
                      .where(ProductPlacement.layout_id == layout_id)).all()
    by_product: dict[uuid.UUID, list[ShelfLocation]] = {}
    used: dict[uuid.UUID, int] = {}
    for pl, sl in rows:
        by_product.setdefault(pl.product_id, []).append(sl)
        used[sl.id] = used.get(sl.id, 0) + pl.facings
    return by_product, used


def _sales_30d(db: Session, store_id: uuid.UUID) -> tuple[dict[uuid.UUID, float], int]:
    since = datetime.now(UTC) - timedelta(days=30)
    rows = db.execute(select(TransactionItem.product_id, func.sum(TransactionItem.quantity))
                      .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
                      .where(SalesTransaction.store_id == store_id, SalesTransaction.transaction_type == "sale",
                             SalesTransaction.occurred_at >= since)
                      .group_by(TransactionItem.product_id)).all()
    baskets = db.scalar(select(func.count(SalesTransaction.id)).where(
        SalesTransaction.store_id == store_id, SalesTransaction.transaction_type == "sale",
        SalesTransaction.occurred_at >= since)) or 0
    return {pid: float(q or 0) / 30 for pid, q in rows}, int(baskets)


def generate(db: Session, store: Store, actor: User | None = None, max_recs: int = 8) -> list[MerchandisingRecommendation]:
    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        raise BusinessRuleError("Store has no active layout")
    existing_keys: set = set()
    for r in db.scalars(select(MerchandisingRecommendation).where(
            MerchandisingRecommendation.store_id == store.id,
            MerchandisingRecommendation.status.in_((*OPEN_STATUSES, "rejected")))):
        existing_keys |= {(r.rec_type, r.product_id, r.related_product_id),
                          (r.rec_type, frozenset({r.product_id, r.related_product_id})), ("adj_product", r.product_id)}
    by_product, used = _locations(db, layout.id)
    shelves = db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id)).all()
    graph = navigation_service.load_graph(db, layout.id)
    velocity, baskets_30d = _sales_30d(db, store.id)
    created: list[MerchandisingRecommendation] = []

    def add(rec: MerchandisingRecommendation) -> None:
        key = (rec.rec_type, rec.product_id, rec.related_product_id)
        pair = (rec.rec_type, frozenset({rec.product_id, rec.related_product_id}))
        if key in existing_keys or pair in existing_keys or len(created) >= max_recs:
            return
        # one secondary-placement test per product, and never two proposals for the same free shelf
        if rec.rec_type == "adjacency_test" and ("adj_product", rec.product_id) in existing_keys:
            return
        if rec.proposed_location_id and used.get(rec.proposed_location_id, 0) > 0 and rec.rec_type != "safety_relocation":
            return
        existing_keys.update({key, pair, ("adj_product", rec.product_id)} if rec.rec_type == "adjacency_test" else {key, pair})
        if rec.proposed_location_id:
            used[rec.proposed_location_id] = used.get(rec.proposed_location_id, 0) + 1
        db.add(rec)
        created.append(rec)

    # 1) safety relocations (always first)
    for pid, locs in by_product.items():
        p = db.get(Product, pid)
        for loc in locs:
            if (p.weight_kg or 0) >= layout_service.HEAVY_KG and loc.height_cm > layout_service.MAX_HEAVY_HEIGHT_CM:
                target = _free_shelf(db, shelves, used, p, loc.fixture_id, levels=(1, 2))
                add(MerchandisingRecommendation(
                    merchant_id=store.merchant_id, store_id=store.id, layout_id=layout.id, rec_type="safety_relocation",
                    product_id=pid, current_location_id=loc.id, proposed_location_id=target.id if target else None,
                    title=f"Move {p.name} to a lower shelf",
                    rationale=f"{p.name} weighs {p.weight_kg} kg and sits at {loc.height_cm} cm ({loc.code}). Heavy items "
                              f"above {layout_service.MAX_HEAVY_HEIGHT_CM} cm are a lifting and falling hazard.",
                    evidence={"weight_kg": p.weight_kg, "height_cm": loc.height_cm, "policy_max_cm": layout_service.MAX_HEAVY_HEIGHT_CM},
                    evidence_quality="high", expected_metric="Safety compliance (no heavy items above 100 cm)",
                    implementation_steps=[f"Move {p.name} from {loc.code} to {target.code if target else 'a level 1-2 shelf'}.",
                                          "Update the shelf label.", "Confirm in the planogram."],
                    ab_test_plan={"design": "Not an experiment - safety correction."}))

    # 2) adjacency tests from basket analysis
    run = cross_selling_service.latest_run(db, store.merchant_id, store.id) or cross_selling_service.latest_run(db, store.merchant_id)
    if run:
        rules = db.scalars(select(AffinityRule).where(AffinityRule.run_id == run.id, AffinityRule.lift >= 1.5,
                                                      AffinityRule.confidence >= 0.2, AffinityRule.pair_count >= 20)
                           .order_by(AffinityRule.lift.desc()).limit(40)).all()
        for r in rules:
            a_locs, c_locs = by_product.get(r.antecedent_id), by_product.get(r.consequent_id)
            if not a_locs or not c_locs:
                continue
            a_loc, c_loc = a_locs[0], c_locs[0]
            if not a_loc.access_node_id or not c_loc.access_node_id:
                continue
            dist, _ = navigation_service.shortest_path(graph, a_loc.access_node_id, c_loc.access_node_id)
            if dist < FAR_APART_M:
                continue
            consequent = db.get(Product, r.consequent_id)
            antecedent = db.get(Product, r.antecedent_id)
            if consequent.price > antecedent.price:
                continue  # place the (cheaper) complement next to the anchor product, not the reverse
            target = _nearest_free_shelf(db, shelves, used, consequent, a_loc, graph)
            if target is None:
                continue
            weekly = baskets_30d / 30 * 7 * r.antecedent_support
            add(MerchandisingRecommendation(
                merchant_id=store.merchant_id, store_id=store.id, layout_id=layout.id, rec_type="adjacency_test",
                product_id=r.consequent_id, related_product_id=r.antecedent_id, current_location_id=c_loc.id,
                proposed_location_id=target.id, affinity_run_id=run.id,
                title=f"Test a secondary placement of {consequent.name} near {antecedent.name}",
                rationale=(f"{r.confidence * 100:.0f}% of baskets with {antecedent.name} also contain {consequent.name} "
                           f"(lift {r.lift:.1f}, {r.pair_count} baskets), but the two are {dist:.0f} m apart. "
                           f"A secondary placement at {target.code} is a hypothesis to test; co-purchase does not "
                           f"prove that adjacency will change behaviour."),
                evidence={"support": r.support, "confidence": r.confidence, "lift": r.lift, "pair_count": r.pair_count,
                          "transactions_analyzed": run.transactions_analyzed, "walking_distance_m": round(dist, 1),
                          "affinity_window_days": run.window_days},
                evidence_quality=_evidence_quality(r.pair_count, r.lift),
                expected_metric=f"Attach rate of {consequent.name} in baskets containing {antecedent.name}",
                implementation_steps=[f"Keep {consequent.name} at its primary location {c_loc.code}.",
                                      f"Add 1-2 facings at {target.code} ({target.fixture.label}).",
                                      "Mark the change as implemented to start outcome tracking."],
                ab_test_plan=_ab_plan(r.confidence, weekly, "attach_rate")))

    # 3) eye-level visibility tests
    for pid, locs in by_product.items():
        p = db.get(Product, pid)
        v = velocity.get(pid, 0.0)
        if layout_service.is_kid_targeted(p) or v < 2 or margin_pct(p.price, p.cost_price) < 20:
            continue
        loc = locs[0]
        if loc.level != 1 or loc.fixture.kind not in ("aisle_shelf", "wall_shelf"):
            continue
        target = _free_shelf(db, shelves, used, p, loc.fixture_id, levels=(3, 4), section=loc.section)
        if target is None:
            continue
        add(MerchandisingRecommendation(
            merchant_id=store.merchant_id, store_id=store.id, layout_id=layout.id, rec_type="eye_level_test",
            product_id=pid, current_location_id=loc.id, proposed_location_id=target.id,
            title=f"Visibility test: move {p.name} from the bottom shelf to eye level",
            rationale=(f"{p.name} sells {v:.1f} units/day at a {margin_pct(p.price, p.cost_price):.0f}% gross margin from "
                       f"the bottom shelf ({loc.code}). Test whether an eye-level position ({target.code}) changes sales; "
                       f"the effect size is unknown until measured."),
            evidence={"units_per_day_30d": round(v, 2), "gross_margin_pct": margin_pct(p.price, p.cost_price),
                      "current_level": loc.level, "proposed_level": target.level},
            evidence_quality="low", expected_metric=f"Units/day of {p.name}",
            implementation_steps=[f"Swap {p.name} to {target.code}.", "Update labels.", "Run for the planned duration."],
            ab_test_plan={**_ab_plan(0.1, baskets_30d / 30 * 7, "units_per_day"),
                          "design": "Before/after with a matched control product in the same aisle"}))

    for rec in created:
        record_audit(db, action="merchandising.recommendation.created", entity_type="merchandising_recommendation",
                     entity_id=rec.id, summary=rec.title, actor=actor, merchant_id=store.merchant_id)
    db.commit()
    return created


def _free_shelf(db: Session, shelves: list[ShelfLocation], used: dict, product: Product, fixture_id: uuid.UUID,
                levels: tuple[int, ...], section: int | None = None) -> ShelfLocation | None:
    cands = [s for s in shelves if s.fixture_id == fixture_id and s.level in levels and (section is None or s.section == section)]
    for s in sorted(cands, key=lambda s: (abs(s.section - (section or s.section)), s.level)):
        if not [v for v in layout_service.placement_violations(product, s, used.get(s.id, 0), 1) if v["severity"] == "block"] \
                and used.get(s.id, 0) == 0:
            return s
    return None


def _nearest_free_shelf(db: Session, shelves: list[ShelfLocation], used: dict, product: Product,
                        anchor: ShelfLocation, graph) -> ShelfLocation | None:
    best, best_d = None, math.inf
    dist, _ = navigation_service.dijkstra(graph, anchor.access_node_id)
    for s in shelves:
        if s.is_clearance or s.access_node_id is None or used.get(s.id, 0) > 0:
            continue
        if s.height_cm > 150 or s.level == 1:
            continue
        if layout_service.is_kid_targeted(product) and s.height_cm <= layout_service.KID_EYE_LEVEL_MAX_CM:
            continue
        if [v for v in layout_service.placement_violations(product, s, 0, 1) if v["severity"] == "block"]:
            continue
        d = dist.get(s.access_node_id, math.inf) + (0 if s.fixture.kind == "endcap" else 0.5)
        if d < best_d:
            best, best_d = s, d
    return best if best_d <= 8 else None


def get_rec(db: Session, merchant_id: uuid.UUID, rec_id: uuid.UUID) -> MerchandisingRecommendation:
    rec = db.get(MerchandisingRecommendation, rec_id)
    if rec is None or rec.merchant_id != merchant_id:
        raise NotFoundError("Recommendation not found")
    return rec


REC_TRANSITIONS = {"proposed": {"accepted", "rejected"}, "accepted": {"implemented", "rejected"},
                   "implemented": {"completed"}, "rejected": set(), "completed": set()}


def review(db: Session, rec: MerchandisingRecommendation, to: str, actor: User, note: str | None) -> MerchandisingRecommendation:
    if to not in REC_TRANSITIONS[rec.status]:
        raise BusinessRuleError(f"Cannot move a recommendation from {rec.status} to {to}")
    before = rec.status
    rec.status, rec.reviewed_by_id, rec.review_note = to, actor.id, note
    if to == "implemented":
        rec.implemented_at = datetime.now(UTC)
    if to == "completed":
        rec.outcome = measure_outcome(db, rec)
    record_audit(db, action=f"merchandising.recommendation.{to}", entity_type="merchandising_recommendation",
                 entity_id=rec.id, summary=f"{rec.title}: {before} -> {to}", actor=actor, merchant_id=rec.merchant_id)
    return rec


def apply_to_draft(db: Session, rec: MerchandisingRecommendation, actor: User) -> dict:
    """Add the proposed placement to the store's draft layout (creating the draft if needed)."""
    from app.db.models import StoreLayout

    if rec.proposed_location_id is None:
        raise BusinessRuleError("This recommendation has no proposed shelf location")
    draft = db.scalars(select(StoreLayout).where(StoreLayout.store_id == rec.store_id, StoreLayout.status == "draft")).first()
    if draft is None:
        active = catalog_service.active_layout(db, rec.store_id)
        draft = layout_service.clone_layout(db, active, actor)
    proposed = db.get(ShelfLocation, rec.proposed_location_id)
    product = db.get(Product, rec.product_id)
    from_code = None
    if rec.rec_type in ("safety_relocation", "eye_level_test") and rec.current_location_id:
        from_code = db.get(ShelfLocation, rec.current_location_id).code
    res = layout_service.place_product(db, draft, product=product, shelf_code=proposed.code, facings=1,
                                       from_shelf_code=from_code, actor=actor)
    if rec.status == "proposed":
        review(db, rec, "accepted", actor, "applied to draft layout")
    return {"draft_layout_id": str(draft.id), **res}


def measure_outcome(db: Session, rec: MerchandisingRecommendation, days: int = 28) -> dict:
    """Observational before/after measurement of the recommendation's metric."""
    if rec.implemented_at is None:
        return {"status": "not_implemented"}
    t0 = rec.implemented_at
    now = datetime.now(UTC)
    before_start, after_end = t0 - timedelta(days=days), min(now, t0 + timedelta(days=days))

    def attach(a: datetime, b: datetime) -> dict:
        tx = db.execute(select(TransactionItem.transaction_id, TransactionItem.product_id)
                        .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
                        .where(SalesTransaction.store_id == rec.store_id, SalesTransaction.transaction_type == "sale",
                               SalesTransaction.occurred_at >= a, SalesTransaction.occurred_at < b,
                               TransactionItem.product_id.in_([rec.product_id] + ([rec.related_product_id] if rec.related_product_id else [])))).all()
        baskets: dict = {}
        for tid, pid in tx:
            baskets.setdefault(tid, set()).add(pid)
        if rec.related_product_id:
            with_a = [b for b in baskets.values() if rec.related_product_id in b]
            hits = sum(1 for b in with_a if rec.product_id in b)
            return {"baskets": len(with_a), "attach_rate": round(hits / len(with_a), 4) if with_a else None}
        units = sum(1 for b in baskets.values() if rec.product_id in b)
        span = max((b - a).days, 1)
        return {"baskets": units, "units_per_day": round(units / span, 3)}

    return {"before": attach(before_start, t0), "after": attach(t0, after_end), "window_days": days,
            "method": "observational_before_after",
            "caveat": "No randomised control: seasonality and promotions can confound the comparison."}
