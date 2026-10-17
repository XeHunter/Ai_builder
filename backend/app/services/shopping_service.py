"""Smart shopping lists: parsing, catalog matching, list operations, aisle grouping and routing.

All list mutations go through ``apply_operation`` which (1) checks the caller's list role,
(2) applies the change with optimistic versioning, (3) appends a ``shopping_list_events`` row with
the next sequence number and (4) returns the event for real-time broadcast. REST endpoints and
the WebSocket channel share this code path, so both behave identically.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai.providers import get_ai_provider
from app.core.exceptions import (
    BusinessRuleError,
    ConflictError,
    NotFoundError,
    PermissionDeniedError,
    ValidationFailedError,
)
from app.db.models import (
    InventoryItem,
    ListMembership,
    Product,
    ShelfLocation,
    ShoppingList,
    ShoppingListEvent,
    ShoppingListItem,
    Store,
    User,
)
from app.services import catalog_service, navigation_service

MATCH_THRESHOLD = 0.30
AMBIGUITY_RATIO = 0.92

# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def _store_product_ids(db: Session, store: Store) -> set[uuid.UUID]:
    return set(db.scalars(select(InventoryItem.product_id).where(InventoryItem.store_id == store.id)))


def match_text(db: Session, store: Store, text: str, pop: dict[uuid.UUID, int] | None = None,
               carried: set[uuid.UUID] | None = None) -> dict:
    carried = carried if carried is not None else _store_product_ids(db, store)
    hits = catalog_service.search(db, store.merchant_id, text, limit=6, candidate_ids=carried or None)
    pop = pop or {}
    max_pop = max(pop.values(), default=0) or 1
    ranked = sorted(hits, key=lambda h: (-(h.score + 0.04 * pop.get(h.product_id, 0) / max_pop), str(h.product_id)))
    products = catalog_service.load_products(db, [h.product_id for h in ranked])
    cards = catalog_service.product_cards(db, store, products, {h.product_id: h.score for h in ranked})
    candidates = [{"product_id": c["id"], "name": c["name"], "price": c["price"], "in_stock": c["in_stock"],
                   "score": c["score"], "location": (c["location"] or {}).get("shelf_code")} for c in cards]
    result: dict[str, Any] = {"product_id": None, "confidence": 0.0, "status": "unresolved", "candidates": candidates,
                              "needs_review": False, "display_name": text}
    if not cards or cards[0]["score"] < MATCH_THRESHOLD:
        return result
    chosen = cards[0]
    if not chosen["in_stock"]:
        alt = next((c for c in cards[1:] if c["in_stock"] and c["score"] >= chosen["score"] - 0.1), None)
        if alt:
            chosen = alt
    result.update(product_id=chosen["id"], confidence=round(min(chosen["score"], 1.0), 3), display_name=chosen["name"],
                  status="pending" if chosen["in_stock"] else "unavailable")
    result["needs_review"] = len(cards) > 1 and cards[1]["score"] >= cards[0]["score"] * AMBIGUITY_RATIO
    return result


def parse_and_match(db: Session, store: Store, text: str) -> dict:
    if len(text) > 4000:
        raise ValidationFailedError("Shopping list text is too long (max 4000 characters)")
    provider = get_ai_provider()
    parsed = provider.parse_shopping_list(text)
    pop = catalog_service.popularity(db, store.id)
    carried = _store_product_ids(db, store)
    items: list[dict] = []
    by_product: dict[str, dict] = {}
    duplicates: list[dict] = []
    for p in parsed.items:
        m = match_text(db, store, p.text, pop, carried)
        entry = {"raw_text": p.text, "quantity": p.quantity, "unit": p.unit, **m}
        pid = m["product_id"]
        if pid and pid in by_product:
            by_product[pid]["quantity"] += p.quantity
            duplicates.append({"raw_text": p.text, "merged_into": by_product[pid]["display_name"]})
            continue
        if pid:
            by_product[pid] = entry
        items.append(entry)
    return {
        "items": items,
        "duplicates_merged": duplicates,
        "unresolved": [i["raw_text"] for i in items if i["status"] == "unresolved"],
        "parser": {"provider": provider.name, "kind": provider.kind,
                   "fell_back": getattr(provider, "last_call_fell_back", False)},
    }


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------


def membership(db: Session, list_id: uuid.UUID, user_id: uuid.UUID) -> ListMembership | None:
    return db.scalars(select(ListMembership).where(ListMembership.list_id == list_id,
                                                   ListMembership.user_id == user_id)).first()


def get_list_for(db: Session, list_id: uuid.UUID, user: User, write: bool = False) -> tuple[ShoppingList, ListMembership]:
    sl = db.get(ShoppingList, list_id)
    m = membership(db, list_id, user.id) if sl else None
    if sl is None or m is None:
        raise NotFoundError("Shopping list not found")
    if write and m.role == "viewer":
        raise PermissionDeniedError("You have view-only access to this list")
    return sl, m


def user_lists(db: Session, user: User) -> list[tuple[ShoppingList, ListMembership]]:
    rows = db.execute(
        select(ShoppingList, ListMembership).join(ListMembership, ListMembership.list_id == ShoppingList.id)
        .where(ListMembership.user_id == user.id, ShoppingList.status != "archived")
        .order_by(ShoppingList.updated_at.desc())
    ).all()
    return [(r[0], r[1]) for r in rows]


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def item_view(it: ShoppingListItem, card: dict | None) -> dict:
    return {
        "id": str(it.id), "raw_text": it.raw_text, "display_name": it.display_name,
        "product_id": str(it.product_id) if it.product_id else None, "quantity": it.quantity, "unit": it.unit,
        "status": it.status, "match_confidence": it.match_confidence, "candidates": it.candidates or [],
        "position": it.position, "version": it.version,
        "collected_by_id": str(it.collected_by_id) if it.collected_by_id else None,
        "collected_at": it.collected_at.isoformat() if it.collected_at else None,
        "updated_at": it.updated_at.isoformat() if it.updated_at else None,
        "product": card,
    }


def list_view(db: Session, sl: ShoppingList, m: ListMembership | None = None) -> dict:
    store = db.get(Store, sl.store_id) if sl.store_id else None
    items = [i for i in sl.items]
    cards: dict[str, dict] = {}
    if store:
        prods = catalog_service.load_products(db, [i.product_id for i in items if i.product_id])
        cards = {c["id"]: c for c in catalog_service.product_cards(db, store, prods)}
    views = [item_view(i, cards.get(str(i.product_id)) if i.product_id else None) for i in items]
    groups: dict[str, dict] = {}
    for v in views:
        loc = (v["product"] or {}).get("location")
        if v["status"] == "unresolved" or v["product"] is None:
            key, label, order = "unresolved", "Needs a product match", "zz1"
        elif loc is None:
            key, label, order = "no_location", "Location unknown", "zz0"
        else:
            key, label = loc["aisle_code"] or loc["fixture_label"], loc["aisle_label"]
            order = _aisle_sort_key(key)
        g = groups.setdefault(key, {"key": key, "label": label, "order": order, "item_ids": []})
        g["item_ids"].append(v["id"])
    total = len(views)
    collected = sum(1 for v in views if v["status"] == "collected")
    members = db.scalars(select(ListMembership).where(ListMembership.list_id == sl.id)).all()
    return {
        "id": str(sl.id), "name": sl.name, "status": sl.status, "is_shared": sl.is_shared, "version": sl.version,
        "store": {"id": str(store.id), "name": store.name, "code": store.code} if store else None,
        "raw_input": sl.raw_input, "items": views,
        "groups": sorted(groups.values(), key=lambda g: g["order"]),
        "progress": {"total": total, "collected": collected,
                     "unresolved": sum(1 for v in views if v["status"] == "unresolved"),
                     "unavailable": sum(1 for v in views if v["status"] == "unavailable"),
                     "percent": round(collected / total * 100) if total else 0},
        "my_role": m.role if m else None,
        "members": [{"user_id": str(x.user_id), "name": x.user.full_name, "role": x.role} for x in members],
        "updated_at": sl.updated_at.isoformat(),
    }


def _aisle_sort_key(code: str) -> str:
    m = re.match(r"([A-Z]+)(\d*)", code or "")
    if not m:
        return code or ""
    prefix_order = {"P": "0", "A": "1", "E": "2", "D": "3", "Z": "4", "CLR": "5"}
    return f"{prefix_order.get(m.group(1), '9')}{int(m.group(2) or 0):03d}"


# ---------------------------------------------------------------------------
# Mutations (single code path for REST + WebSocket)
# ---------------------------------------------------------------------------


def _next_event(db: Session, sl: ShoppingList, event_type: str, actor: User, payload: dict,
                item_id: uuid.UUID | None = None, client_event_id: str | None = None) -> ShoppingListEvent:
    sl.version += 1
    sl.updated_at = datetime.now(UTC)
    ev = ShoppingListEvent(list_id=sl.id, seq=sl.version, event_type=event_type, item_id=item_id, actor_id=actor.id,
                           payload=payload, client_event_id=client_event_id)
    db.add(ev)
    db.flush()
    return ev


def event_view(ev: ShoppingListEvent, actor_name: str | None = None) -> dict:
    return {"seq": ev.seq, "type": ev.event_type, "item_id": str(ev.item_id) if ev.item_id else None,
            "actor_id": str(ev.actor_id) if ev.actor_id else None, "actor_name": actor_name, "payload": ev.payload,
            "client_event_id": ev.client_event_id, "created_at": ev.created_at.isoformat()}


def create_list(db: Session, user: User, *, name: str, store_id: uuid.UUID | None, raw_input: str | None,
                items: list[dict]) -> ShoppingList:
    store = db.get(Store, store_id) if store_id else None
    if store_id and store is None:
        raise NotFoundError("Store not found")
    sl = ShoppingList(owner_id=user.id, store_id=store_id, name=name, raw_input=raw_input)
    db.add(sl)
    db.flush()
    db.add(ListMembership(list_id=sl.id, user_id=user.id, role="owner"))
    for i, spec in enumerate(items):
        _add_item(db, sl, store, user, spec, position=i)
    _next_event(db, sl, "list_created", user, {"name": name, "items": len(items)})
    db.commit()
    return sl


def _resolve_product(db: Session, store: Store | None, product_id: Any) -> Product | None:
    if not product_id:
        return None
    p = db.get(Product, uuid.UUID(str(product_id)))
    if p is None or (store and p.merchant_id != store.merchant_id):
        raise NotFoundError("Product not found in this store's catalog")
    return p


def _add_item(db: Session, sl: ShoppingList, store: Store | None, user: User, spec: dict, position: int | None = None) -> tuple[ShoppingListItem, bool]:
    raw = (spec.get("raw_text") or "").strip()
    product = _resolve_product(db, store, spec.get("product_id"))
    qty = float(spec.get("quantity") or 1)
    if qty <= 0 or qty > 1000:
        raise ValidationFailedError("Quantity must be between 0 and 1000")
    match: dict = {}
    if product is None and raw and store is not None and not spec.get("skip_match"):
        match = match_text(db, store, raw)
        if match["product_id"]:
            product = db.get(Product, uuid.UUID(match["product_id"]))
    elif product is not None and raw and store is not None:
        # explicit choice: keep alternatives so the shopper can change the match later
        match = {"candidates": match_text(db, store, raw)["candidates"], "confidence": 1.0}
    if not raw and product is None:
        raise ValidationFailedError("Provide raw_text or product_id")
    if product is not None:
        dup = next((i for i in sl.items if i.product_id == product.id and i.status != "collected"), None)
        if dup:
            dup.quantity += qty
            dup.version += 1
            return dup, True
    status = "unresolved"
    if product is not None:
        status = match.get("status") or "pending"
        if store is not None and status == "pending":
            stock = catalog_service.stock_snapshot(db, store.id, [product.id]).get(product.id, {"qty": 0})
            status = "pending" if stock["qty"] > 0 else "unavailable"
    it = ShoppingListItem(list_id=sl.id, product_id=product.id if product else None, raw_text=(raw or product.name)[:160],
                          display_name=(product.name if product else raw)[:160], quantity=qty, unit=spec.get("unit"),
                          status=status, match_confidence=match.get("confidence") if match else (1.0 if product else None),
                          candidates=match.get("candidates", [])[:5] if match else [],
                          position=position if position is not None else len(sl.items), added_by_id=user.id)
    sl.items.append(it)
    db.flush()
    return it, False


def apply_operation(db: Session, sl: ShoppingList, m: ListMembership, user: User, op: dict) -> tuple[ShoppingListEvent, dict | None]:
    """Apply one client operation. Returns the event and the affected item view."""
    if m.role == "viewer":
        raise PermissionDeniedError("You have view-only access to this list")
    if sl.status == "archived":
        raise BusinessRuleError("This list is archived")
    cid = op.get("client_event_id")
    if cid:
        prior = db.scalars(select(ShoppingListEvent).where(ShoppingListEvent.list_id == sl.id,
                                                           ShoppingListEvent.client_event_id == cid)).first()
        if prior:  # idempotent retry (e.g. resent after a reconnect)
            item = db.get(ShoppingListItem, prior.item_id) if prior.item_id else None
            return prior, item_view(item, None) if item else None
    store = db.get(Store, sl.store_id) if sl.store_id else None
    kind = op.get("op")
    if kind == "add_item":
        it, merged = _add_item(db, sl, store, user, op)
        ev = _next_event(db, sl, "item_updated" if merged else "item_added", user,
                         {"item": item_view(it, None), "merged_duplicate": merged}, it.id, cid)
        if not merged and sl.is_shared:
            _notify_members(db, sl, user, f"{user.full_name} added {it.display_name}")
        db.commit()
        return ev, item_view(it, None)

    item_id = op.get("item_id")
    it = db.get(ShoppingListItem, uuid.UUID(str(item_id))) if item_id else None
    if it is None or it.list_id != sl.id:
        raise NotFoundError("Item not found (it may have been removed by another member)")

    if kind == "remove_item":
        snapshot = item_view(it, None)
        sl.items.remove(it)
        db.delete(it)
        ev = _next_event(db, sl, "item_removed", user, {"item": snapshot}, it.id, cid)
        db.commit()
        return ev, None

    if kind in ("collect", "uncollect"):
        # Check-off is conflict-free: setting the same state twice is a no-op, so concurrent shoppers
        # ticking the same item never conflict.
        target = "collected" if kind == "collect" else "pending"
        if it.status == target:
            ev = _next_event(db, sl, "item_collected" if kind == "collect" else "item_uncollected", user,
                             {"item": item_view(it, None), "noop": True}, it.id, cid)
            db.commit()
            return ev, item_view(it, None)
        if kind == "collect" and it.status == "unresolved":
            raise BusinessRuleError("Resolve the product match before collecting this item")
        it.status = target
        it.collected_by_id = user.id if kind == "collect" else None
        it.collected_at = datetime.now(UTC) if kind == "collect" else None
        it.version += 1
        ev = _next_event(db, sl, "item_collected" if kind == "collect" else "item_uncollected", user,
                         {"item": item_view(it, None)}, it.id, cid)
        if all(i.status == "collected" for i in sl.items if i.status != "unresolved") and sl.items:
            sl.status = "completed"
        elif sl.status == "completed":
            sl.status = "active"
        db.commit()
        return ev, item_view(it, None)

    if kind == "update_item":
        expected = op.get("expected_version")
        if expected is not None and int(expected) != it.version:
            raise ConflictError("This item was changed by someone else", details={"current": item_view(it, None)})
        changes: dict[str, Any] = {}
        if "quantity" in op and op["quantity"] is not None:
            q = float(op["quantity"])
            if q <= 0 or q > 1000:
                raise ValidationFailedError("Quantity must be between 0 and 1000")
            it.quantity, changes["quantity"] = q, q
        if "unit" in op:
            it.unit, changes["unit"] = op["unit"], op["unit"]
        if op.get("product_id"):
            p = _resolve_product(db, store, op["product_id"])
            it.product_id, it.display_name, it.match_confidence = p.id, p.name, 1.0
            stock = catalog_service.stock_snapshot(db, store.id, [p.id]).get(p.id, {"qty": 0}) if store else {"qty": 1}
            it.status = "pending" if stock["qty"] > 0 else "unavailable"
            changes["product_id"] = str(p.id)
        if not changes:
            raise ValidationFailedError("Nothing to update")
        it.version += 1
        ev = _next_event(db, sl, "item_updated", user, {"item": item_view(it, None), "changes": changes}, it.id, cid)
        db.commit()
        return ev, item_view(it, None)

    raise ValidationFailedError(f"Unknown operation '{kind}'")


def _notify_members(db: Session, sl: ShoppingList, actor: User, text: str) -> None:
    """In-app notification for other members; at most one per member per list per hour."""
    from app.services.notification_service import notify

    bucket = datetime.now(UTC).strftime("%Y%m%d%H")
    for m in db.scalars(select(ListMembership).where(ListMembership.list_id == sl.id, ListMembership.user_id != actor.id)):
        notify(db, user_id=m.user_id, notification_type="shared_list", title=f"'{sl.name}' was updated",
               body=f"{text}.", idempotency_key=f"list-change:{sl.id}:{m.user_id}:{bucket}", link=f"/shop/lists/{sl.id}")


def events_since(db: Session, sl: ShoppingList, since: int, limit: int = 500) -> list[ShoppingListEvent]:
    return list(db.scalars(select(ShoppingListEvent).where(ShoppingListEvent.list_id == sl.id,
                                                           ShoppingListEvent.seq > since)
                           .order_by(ShoppingListEvent.seq).limit(limit)))


def event_count_since(db: Session, sl: ShoppingList, since: int) -> int:
    return int(db.scalar(select(func.count(ShoppingListEvent.id)).where(ShoppingListEvent.list_id == sl.id,
                                                                     ShoppingListEvent.seq > since)) or 0)


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def route_for_list(db: Session, sl: ShoppingList, *, start_x: float | None = None, start_y: float | None = None,
                   accessible_only: bool = False, include_collected: bool = False, end: str = "checkout") -> dict:
    if sl.store_id is None:
        raise BusinessRuleError("Select a store for this list before planning a route")
    store = db.get(Store, sl.store_id)
    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        raise BusinessRuleError("This store has no floor plan")
    g = navigation_service.load_graph(db, layout.id, accessible_only)
    items = [i for i in sl.items if i.product_id and (include_collected or i.status in ("pending", "unavailable"))]
    locs = catalog_service.product_locations(db, layout.id, [i.product_id for i in items])
    stops, unrouted = [], []
    for it in items:
        loc: ShelfLocation | None = locs.get(it.product_id)
        if loc is None or loc.access_node_id is None or loc.access_node_id not in g.nodes:
            unrouted.append({"item_id": str(it.id), "name": it.display_name, "reason": "no known shelf location"})
            continue
        if it.status == "unavailable":
            unrouted.append({"item_id": str(it.id), "name": it.display_name, "reason": "out of stock at this store"})
            continue
        stops.append(navigation_service.Stop(key=str(it.id), label=it.display_name, node_id=loc.access_node_id, shelf=loc))
    unresolved = [{"item_id": str(i.id), "name": i.raw_text, "reason": "no product match"}
                  for i in sl.items if i.product_id is None and i.status == "unresolved"]
    start = g.nearest_node(start_x, start_y) if start_x is not None and start_y is not None else (g.first_of_kind("entrance") or next(iter(g.nodes)))
    end_node = g.first_of_kind("checkout" if end == "checkout" else "exit") or start
    plan = navigation_service.plan_route(g, start, stops, end_node)
    return {
        "list_id": str(sl.id), "store_id": str(store.id), "layout_id": str(layout.id), "list_version": sl.version,
        "algorithm": plan.algorithm, "total_distance_m": plan.total_distance_m,
        "unoptimized_distance_m": plan.naive_distance_m,
        "saved_distance_m": round(max(plan.naive_distance_m - plan.total_distance_m, 0), 1),
        "stops": [
            {"order": n + 1, "node_code": g.node(group[0].node_id).code, "x": g.node(group[0].node_id).x,
             "y": g.node(group[0].node_id).y,
             "items": [{"item_id": s.key, "name": s.label, "shelf_code": s.shelf.code if s.shelf else None,
                        "level": s.shelf.level if s.shelf else None, "shelf_x": s.shelf.x if s.shelf else None,
                        "shelf_y": s.shelf.y if s.shelf else None} for s in group]}
            for n, group in enumerate(plan.ordered_stops)
        ],
        "path": navigation_service.serialize_path(g, plan.node_path),
        "steps": plan.steps,
        "unrouted": unrouted + unresolved,
        "accessible_only": accessible_only,
        "positioning": "manual_start_point",
    }
