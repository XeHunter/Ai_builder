"""Store layouts and the simplified planogram editor.

Supported edits on a *draft* layout (the active layout is never edited in place):
* place / move / remove product placements on shelf locations (with constraint checks);
* move ``is_movable`` fixtures (endcaps, displays, clearance bin) - rejected if the fixture would
  overlap a walkway (keeps accessible routes clear) or leave the floor.
Publishing a draft archives the previous active layout; reverting discards the draft. Fixture
geometry of aisles/walls and the walkway graph are not editable in this version.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import (
    LayoutFixture,
    NavEdge,
    NavNode,
    Product,
    ProductPlacement,
    ShelfLocation,
    Store,
    StoreLayout,
    User,
)
from app.services import catalog_service
from app.services.audit_service import record_audit

HEAVY_KG = 5.0
MAX_HEAVY_HEIGHT_CM = 100
WALKWAY_CLEARANCE_M = 0.6
# Shelves at or below this height are at a young child's eye level and reach.
KID_EYE_LEVEL_MAX_CM = 90
KID_TARGETED_TAGS = frozenset({"chocolate", "confectionery", "candy", "chips", "crisps", "toy"})


def is_kid_targeted(product: Product) -> bool:
    """Children's products and confectionery / crisps ('pester power' items)."""
    return bool(product.is_child_product) or bool(KID_TARGETED_TAGS & {t.lower() for t in (product.tags or [])})


# The merchandising rule book. Codes match ``placement_violations`` and the recommendation generators,
# so the UI shows exactly what the editor enforces and what the AI is allowed to suggest.
PLACEMENT_RULES: list[dict] = [
    {"code": "needs_refrigeration", "kind": "block", "group": "Food safety", "title": "Chilled goods stay in chillers",
     "description": "Products in chilled categories (dairy, frozen...) can only be placed on chilled fixtures.",
     "why": "Cold-chain breaks spoil stock and are a food-safety risk."},
    {"code": "unsafe_height", "kind": "block", "group": "Customer safety", "title": "Heavy items low",
     "description": f"Items of {HEAVY_KG:g} kg or more may not sit above {MAX_HEAVY_HEIGHT_CM} cm.",
     "why": "Lifting heavy packs from high shelves causes falls and injuries."},
    {"code": "child_checkout", "kind": "block", "group": "Responsible retail", "title": "No kids' treats at checkout",
     "description": "Children's products, confectionery and crisps cannot be placed on checkout impulse fixtures.",
     "why": "Queue-side 'pester power' placement targets children; several countries restrict it (e.g. UK HFSS rules)."},
    {"code": "kid_eye_level", "kind": "warn", "group": "Responsible retail", "title": "Treats above kids' eye level",
     "description": f"Confectionery, crisps and children's products at {KID_EYE_LEVEL_MAX_CM} cm or lower are flagged. "
                    "The AI never recommends moving them lower.",
     "why": "Keeps sweets out of young children's line of sight and reach without hiding them from adults."},
    {"code": "capacity", "kind": "block", "group": "Operations", "title": "Shelf capacity",
     "description": "A shelf cannot hold more facings than its capacity.",
     "why": "Overfilled shelves cause damage and out-of-place stock."},
    {"code": "chiller_space", "kind": "warn", "group": "Operations", "title": "Don't waste chiller space",
     "description": "Ambient, non-perishable products on chilled fixtures are flagged.",
     "why": "Refrigerated space is scarce and costs energy."},
    {"code": "walkway_clearance", "kind": "block", "group": "Accessibility", "title": "Clear walkways",
     "description": f"Movable fixtures must stay at least {WALKWAY_CLEARANCE_M:g} m from walking routes.",
     "why": "Keeps aisles passable for trolleys, wheelchairs and in-store navigation."},
    {"code": "eye_level_test", "kind": "ai", "group": "AI recommendations", "title": "Best sellers to adult eye level",
     "description": "Fast sellers (2+ units/day, 20%+ margin) stuck on the bottom shelf are proposed for a 100-140 cm "
                    "shelf as an A/B test. Children's products are excluded.",
     "why": "Eye-level shelves get more attention; the effect is measured, not assumed."},
    {"code": "adjacency_test", "kind": "ai", "group": "AI recommendations", "title": "Bought together, placed together",
     "description": "Strong co-purchase pairs (lift 1.5+) more than 12 m apart get a secondary placement test near "
                    "each other, never at kids' height or above 150 cm.",
     "why": "Shortens the shopper's walk and makes complements easy to find."},
    {"code": "safety_relocation", "kind": "ai", "group": "AI recommendations", "title": "Fix unsafe placements",
     "description": "Heavy items found above the safe height get a mandatory move-down recommendation.",
     "why": "Safety issues are corrected, not tested."},
]


def layout_compliance(db: Session, layout: StoreLayout) -> dict:
    """Check every placement of a layout against the rule book."""
    placements = db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == layout.id)).all()
    used: dict[uuid.UUID, int] = {}
    for pl in placements:
        used[pl.shelf_location_id] = used.get(pl.shelf_location_id, 0) + pl.facings
    ids = {pl.product_id for pl in placements}
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(ids)))} if ids else {}
    found: dict[str, list[dict]] = {}
    for pl in placements:
        p, shelf = products.get(pl.product_id), pl.shelf_location
        if p is None:
            continue
        for v in placement_violations(p, shelf, used[shelf.id] - pl.facings, pl.facings):
            found.setdefault(v["code"], []).append({"product": p.name, "sku": p.sku, "shelf_code": shelf.code,
                                                     "height_cm": shelf.height_cm, "message": v["message"]})
    rules = []
    for r in PLACEMENT_RULES:
        issues = found.get(r["code"], [])
        rules.append({**r, "checked": r["kind"] != "ai", "violations": len(issues), "examples": issues[:5]})
    return {"layout_id": str(layout.id), "layout_name": layout.name, "status": layout.status,
            "placements_checked": len(placements),
            "kid_targeted_products": sum(1 for p in products.values() if is_kid_targeted(p)),
            "blocking": sum(r["violations"] for r in rules if r["kind"] == "block"),
            "warnings": sum(r["violations"] for r in rules if r["kind"] == "warn"), "rules": rules}


def placement_violations(product: Product, shelf: ShelfLocation, used_facings: int, facings: int) -> list[dict]:
    """Hard (``block``) and soft (``warn``) merchandising constraints for placing a product on a shelf."""
    out: list[dict] = []
    fx = shelf.fixture
    needs_cold = bool(product.category and product.category.requires_chilling)
    if needs_cold and not fx.is_chilled:
        out.append({"severity": "block", "code": "needs_refrigeration",
                    "message": f"{product.name} must be stored in a chilled fixture."})
    if (product.weight_kg or 0) >= HEAVY_KG and shelf.height_cm > MAX_HEAVY_HEIGHT_CM:
        out.append({"severity": "block", "code": "unsafe_height",
                    "message": f"Items of {product.weight_kg} kg must not be placed above {MAX_HEAVY_HEIGHT_CM} cm."})
    if is_kid_targeted(product) and fx.kind == "checkout":
        out.append({"severity": "block", "code": "child_checkout",
                    "message": "Children's products and confectionery are not placed at checkout impulse fixtures."})
    elif is_kid_targeted(product) and shelf.height_cm <= KID_EYE_LEVEL_MAX_CM:
        out.append({"severity": "warn", "code": "kid_eye_level",
                    "message": f"{product.name} at {shelf.height_cm} cm is at a young child's eye level; "
                               f"keep confectionery above {KID_EYE_LEVEL_MAX_CM} cm."})
    if used_facings + facings > shelf.capacity_facings:
        out.append({"severity": "block", "code": "capacity",
                    "message": f"Shelf {shelf.code} has {shelf.capacity_facings - used_facings} free facings."})
    if fx.is_chilled and not needs_cold and not product.is_perishable:
        out.append({"severity": "warn", "code": "chiller_space",
                    "message": "Ambient product in a chilled fixture uses scarce refrigerated space."})
    return out


def get_layout(db: Session, merchant_id: uuid.UUID, layout_id: uuid.UUID) -> StoreLayout:
    layout = db.get(StoreLayout, layout_id)
    store = db.get(Store, layout.store_id) if layout else None
    if layout is None or store is None or store.merchant_id != merchant_id:
        raise NotFoundError("Layout not found")
    return layout


def layout_detail(db: Session, layout: StoreLayout, include_products: bool = True) -> dict:
    shelves = db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id)).all()
    nodes = db.scalars(select(NavNode).where(NavNode.layout_id == layout.id)).all()
    edges = db.scalars(select(NavEdge).where(NavEdge.layout_id == layout.id)).all()
    placements = db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == layout.id)).all() if include_products else []
    pids = {p.product_id for p in placements}
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(pids)))} if pids else {}
    code_of = {n.id: n.code for n in nodes}
    by_shelf: dict[uuid.UUID, list] = {}
    for pl in placements:
        p = products.get(pl.product_id)
        by_shelf.setdefault(pl.shelf_location_id, []).append({
            "placement_id": str(pl.id), "product_id": str(pl.product_id), "name": p.name if p else "?",
            "sku": p.sku if p else "?", "facings": pl.facings, "is_primary": pl.is_primary,
            "category": p.category.name if p and p.category else None})
    return {
        "id": str(layout.id), "store_id": str(layout.store_id), "name": layout.name, "version": layout.version,
        "status": layout.status, "width_m": layout.width_m, "height_m": layout.height_m,
        "based_on_layout_id": str(layout.based_on_layout_id) if layout.based_on_layout_id else None,
        "published_at": layout.published_at.isoformat() if layout.published_at else None,
        "fixtures": [{"id": str(f.id), "code": f.code, "kind": f.kind, "label": f.label, "aisle_code": f.aisle_code,
                      "x": f.x, "y": f.y, "width": f.width, "height": f.height, "levels": f.levels,
                      "is_chilled": f.is_chilled, "is_movable": f.is_movable} for f in layout.fixtures],
        "shelves": [{"id": str(s.id), "code": s.code, "fixture_id": str(s.fixture_id), "aisle_code": s.aisle_code,
                     "section": s.section, "level": s.level, "height_cm": s.height_cm, "x": s.x, "y": s.y,
                     "capacity_facings": s.capacity_facings, "is_clearance": s.is_clearance,
                     "access_node": code_of.get(s.access_node_id),
                     "products": by_shelf.get(s.id, [])} for s in shelves],
        "nodes": [{"code": n.code, "x": n.x, "y": n.y, "kind": n.kind, "label": n.label} for n in nodes],
        "edges": [{"from": code_of[e.from_node_id], "to": code_of[e.to_node_id], "distance_m": e.distance_m,
                   "accessible": e.is_accessible, "blocked": e.is_blocked} for e in edges],
    }


def clone_layout(db: Session, src: StoreLayout, actor: User | None, name: str | None = None) -> StoreLayout:
    existing = db.scalars(select(StoreLayout).where(StoreLayout.store_id == src.store_id, StoreLayout.status == "draft")).first()
    if existing:
        raise BusinessRuleError("This store already has a draft layout; publish or discard it first",
                                details={"draft_layout_id": str(existing.id)})
    version = (db.scalar(select(func.max(StoreLayout.version)).where(StoreLayout.store_id == src.store_id)) or 0) + 1
    dst = StoreLayout(store_id=src.store_id, name=name or f"{src.name} (proposal v{version})", version=version,
                      status="draft", based_on_layout_id=src.id, width_m=src.width_m, height_m=src.height_m,
                      notes=f"Draft cloned from v{src.version}", created_by_id=actor.id if actor else None)
    db.add(dst)
    db.flush()
    fmap, nmap, smap = {}, {}, {}
    for f in src.fixtures:
        nf = LayoutFixture(layout_id=dst.id, code=f.code, kind=f.kind, label=f.label, aisle_code=f.aisle_code, x=f.x,
                           y=f.y, width=f.width, height=f.height, levels=f.levels, is_chilled=f.is_chilled,
                           is_movable=f.is_movable, properties=dict(f.properties or {}))
        db.add(nf)
        db.flush()
        fmap[f.id] = nf.id
    for n in db.scalars(select(NavNode).where(NavNode.layout_id == src.id)):
        nn = NavNode(layout_id=dst.id, code=n.code, x=n.x, y=n.y, kind=n.kind, label=n.label)
        db.add(nn)
        db.flush()
        nmap[n.id] = nn.id
    for e in db.scalars(select(NavEdge).where(NavEdge.layout_id == src.id)):
        db.add(NavEdge(layout_id=dst.id, from_node_id=nmap[e.from_node_id], to_node_id=nmap[e.to_node_id],
                       distance_m=e.distance_m, is_accessible=e.is_accessible, is_blocked=e.is_blocked))
    for s in db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == src.id)):
        ns = ShelfLocation(layout_id=dst.id, fixture_id=fmap[s.fixture_id], code=s.code, aisle_code=s.aisle_code,
                           section=s.section, level=s.level, height_cm=s.height_cm, x=s.x, y=s.y,
                           capacity_facings=s.capacity_facings,
                           access_node_id=nmap.get(s.access_node_id) if s.access_node_id else None,
                           is_clearance=s.is_clearance)
        db.add(ns)
        db.flush()
        smap[s.id] = ns.id
    for p in db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == src.id)):
        db.add(ProductPlacement(layout_id=dst.id, shelf_location_id=smap[p.shelf_location_id], product_id=p.product_id,
                                facings=p.facings, is_primary=p.is_primary))
    store = db.get(Store, src.store_id)
    record_audit(db, action="layout.draft_created", entity_type="store_layout", entity_id=dst.id,
                 summary=f"Draft layout v{version} created from v{src.version}", actor=actor, merchant_id=store.merchant_id)
    db.flush()
    db.refresh(dst)
    return dst


def _require_draft(layout: StoreLayout) -> None:
    if layout.status != "draft":
        raise BusinessRuleError("Only draft layouts can be edited; create a draft from the active layout")


def _used_facings(db: Session, shelf_id: uuid.UUID, exclude_placement: uuid.UUID | None = None) -> int:
    stmt = select(func.coalesce(func.sum(ProductPlacement.facings), 0)).where(ProductPlacement.shelf_location_id == shelf_id)
    if exclude_placement:
        stmt = stmt.where(ProductPlacement.id != exclude_placement)
    return int(db.scalar(stmt) or 0)


def place_product(db: Session, layout: StoreLayout, *, product: Product, shelf_code: str, facings: int,
                  from_shelf_code: str | None, actor: User, force_warnings: bool = True) -> dict:
    _require_draft(layout)
    shelf = db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id, ShelfLocation.code == shelf_code)).first()
    if shelf is None:
        raise NotFoundError(f"Shelf {shelf_code} not found in this layout")
    moving = None
    if from_shelf_code:
        src = db.scalars(select(ShelfLocation).where(ShelfLocation.layout_id == layout.id,
                                                     ShelfLocation.code == from_shelf_code)).first()
        if src is None:
            raise NotFoundError(f"Shelf {from_shelf_code} not found")
        moving = db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == layout.id,
                                                           ProductPlacement.shelf_location_id == src.id,
                                                           ProductPlacement.product_id == product.id)).first()
        if moving is None:
            raise NotFoundError(f"{product.name} is not placed on {from_shelf_code}")
    already = db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == layout.id,
                                                        ProductPlacement.shelf_location_id == shelf.id,
                                                        ProductPlacement.product_id == product.id)).first()
    if already and already is not moving:
        raise BusinessRuleError(f"{product.name} is already on {shelf_code}")
    violations = placement_violations(product, shelf, _used_facings(db, shelf.id), facings)
    blocking = [v for v in violations if v["severity"] == "block"]
    if blocking:
        raise BusinessRuleError("Placement violates merchandising constraints", details={"violations": violations})
    if moving:
        moving.shelf_location_id, moving.facings = shelf.id, facings
        pl = moving
    else:
        has_primary = db.scalars(select(ProductPlacement.id).where(ProductPlacement.layout_id == layout.id,
                                                                   ProductPlacement.product_id == product.id)).first()
        pl = ProductPlacement(layout_id=layout.id, shelf_location_id=shelf.id, product_id=product.id, facings=facings,
                              is_primary=has_primary is None)
        db.add(pl)
    db.flush()
    return {"placement_id": str(pl.id), "shelf_code": shelf.code, "warnings": violations}


def remove_placement(db: Session, layout: StoreLayout, placement_id: uuid.UUID) -> None:
    _require_draft(layout)
    pl = db.get(ProductPlacement, placement_id)
    if pl is None or pl.layout_id != layout.id:
        raise NotFoundError("Placement not found")
    was_primary, pid = pl.is_primary, pl.product_id
    db.delete(pl)
    db.flush()
    if was_primary:
        nxt = db.scalars(select(ProductPlacement).where(ProductPlacement.layout_id == layout.id,
                                                        ProductPlacement.product_id == pid)).first()
        if nxt:
            nxt.is_primary = True


def _seg_rect_distance(ax: float, ay: float, bx: float, by: float, rx: float, ry: float, rw: float, rh: float) -> float:
    # sample the segment; adequate for metre-scale layouts
    best = math.inf
    steps = max(2, int(math.hypot(bx - ax, by - ay) / 0.25))
    for i in range(steps + 1):
        t = i / steps
        px, py = ax + (bx - ax) * t, ay + (by - ay) * t
        dx = max(rx - px, 0, px - (rx + rw))
        dy = max(ry - py, 0, py - (ry + rh))
        best = min(best, math.hypot(dx, dy))
    return best


def move_fixture(db: Session, layout: StoreLayout, fixture_id: uuid.UUID, x: float, y: float) -> dict:
    _require_draft(layout)
    f = db.get(LayoutFixture, fixture_id)
    if f is None or f.layout_id != layout.id:
        raise NotFoundError("Fixture not found")
    if not f.is_movable:
        raise BusinessRuleError(f"{f.label} is a fixed fixture and cannot be moved in this editor")
    if x < 0 or y < 0 or x + f.width > layout.width_m or y + f.height > layout.height_m:
        raise BusinessRuleError("Fixture must stay inside the store floor")
    nodes = {n.id: n for n in db.scalars(select(NavNode).where(NavNode.layout_id == layout.id))}
    for e in db.scalars(select(NavEdge).where(NavEdge.layout_id == layout.id)):
        a, b = nodes[e.from_node_id], nodes[e.to_node_id]
        if _seg_rect_distance(a.x, a.y, b.x, b.y, x, y, f.width, f.height) < WALKWAY_CLEARANCE_M:
            raise BusinessRuleError("Fixture would block a walkway; keep at least 0.6 m clearance from walking routes",
                                    details={"edge": [a.code, b.code]})
    for other in layout.fixtures:
        if other.id != f.id and x < other.x + other.width and x + f.width > other.x and y < other.y + other.height and y + f.height > other.y:
            raise BusinessRuleError(f"Fixture would overlap {other.label}")
    dx, dy = x - f.x, y - f.y
    f.x, f.y = x, y
    for s in db.scalars(select(ShelfLocation).where(ShelfLocation.fixture_id == f.id)):
        s.x, s.y = s.x + dx, s.y + dy
        s.access_node_id = min(nodes, key=lambda nid: (nodes[nid].x - s.x) ** 2 + (nodes[nid].y - s.y) ** 2)
    db.flush()
    return {"fixture_id": str(f.id), "x": f.x, "y": f.y}


def publish_draft(db: Session, layout: StoreLayout, actor: User) -> StoreLayout:
    _require_draft(layout)
    store = db.get(Store, layout.store_id)
    for old in db.scalars(select(StoreLayout).where(StoreLayout.store_id == layout.store_id, StoreLayout.status == "active")):
        old.status = "archived"
    layout.status, layout.published_at = "active", datetime.now(UTC)
    record_audit(db, action="layout.published", entity_type="store_layout", entity_id=layout.id,
                 summary=f"Layout v{layout.version} published for {store.code}", actor=actor, merchant_id=store.merchant_id)
    catalog_service.invalidate_index(store.merchant_id)
    return layout


def discard_draft(db: Session, layout: StoreLayout, actor: User) -> None:
    _require_draft(layout)
    store = db.get(Store, layout.store_id)
    record_audit(db, action="layout.draft_discarded", entity_type="store_layout", entity_id=layout.id,
                 summary=f"Draft layout v{layout.version} discarded", actor=actor, merchant_id=store.merchant_id)
    db.delete(layout)


def diff_layouts(db: Session, base: StoreLayout, other: StoreLayout) -> list[dict]:
    def placements(layout: StoreLayout) -> dict[uuid.UUID, set[str]]:
        rows = db.execute(select(ProductPlacement.product_id, ShelfLocation.code)
                          .join(ShelfLocation, ShelfLocation.id == ProductPlacement.shelf_location_id)
                          .where(ProductPlacement.layout_id == layout.id)).all()
        out: dict[uuid.UUID, set[str]] = {}
        for pid, code in rows:
            out.setdefault(pid, set()).add(code)
        return out

    a, b = placements(base), placements(other)
    names = dict(db.execute(select(Product.id, Product.name).where(Product.id.in_(set(a) | set(b)))).all())
    changes = []
    for pid in sorted(set(a) | set(b), key=lambda p: names.get(p, "")):
        if a.get(pid, set()) != b.get(pid, set()):
            changes.append({"product_id": str(pid), "name": names.get(pid), "current": sorted(a.get(pid, [])),
                            "proposed": sorted(b.get(pid, []))})
    return changes
