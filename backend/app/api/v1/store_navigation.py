"""Ad-hoc in-store routes for a set of products (shopping-list routes live under /shopping-lists)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import Store, User
from app.db.session import get_db
from app.schemas.shopping import ProductRouteRequest, RouteResponse
from app.services import catalog_service, navigation_service

router = APIRouter(tags=["store-navigation"])


@router.post("/stores/{store_id}/route", response_model=RouteResponse)
def product_route(store_id: uuid.UUID, body: ProductRouteRequest, db: Session = Depends(get_db),
                  _: User = Depends(get_current_user)) -> dict:
    store = db.get(Store, store_id)
    if store is None:
        raise NotFoundError("Store not found")
    layout = catalog_service.active_layout(db, store.id)
    if layout is None:
        raise BusinessRuleError("This store has no floor plan")
    g = navigation_service.load_graph(db, layout.id, body.accessible_only)
    products = [p for p in catalog_service.load_products(db, body.product_ids) if p.merchant_id == store.merchant_id]
    locs = catalog_service.product_locations(db, layout.id, [p.id for p in products])
    stops, unrouted = [], []
    for p in products:
        loc = locs.get(p.id)
        if loc is None or loc.access_node_id not in g.nodes:
            unrouted.append({"product_id": str(p.id), "name": p.name, "reason": "no known shelf location"})
            continue
        stops.append(navigation_service.Stop(key=str(p.id), label=p.name, node_id=loc.access_node_id, shelf=loc))
    start = g.nearest_node(body.start_x, body.start_y) if body.start_x is not None and body.start_y is not None \
        else (g.first_of_kind("entrance") or next(iter(g.nodes)))
    end = g.first_of_kind("checkout" if body.end == "checkout" else "exit") or start
    plan = navigation_service.plan_route(g, start, stops, end)
    return {
        "store_id": str(store.id), "layout_id": str(layout.id), "algorithm": plan.algorithm,
        "total_distance_m": plan.total_distance_m, "unoptimized_distance_m": plan.naive_distance_m,
        "saved_distance_m": round(max(plan.naive_distance_m - plan.total_distance_m, 0), 1),
        "stops": [{"order": i + 1, "node_code": g.node(grp[0].node_id).code, "x": g.node(grp[0].node_id).x,
                   "y": g.node(grp[0].node_id).y,
                   "items": [{"item_id": s.key, "name": s.label, "shelf_code": s.shelf.code, "level": s.shelf.level,
                              "shelf_x": s.shelf.x, "shelf_y": s.shelf.y} for s in grp]}
                  for i, grp in enumerate(plan.ordered_stops)],
        "path": navigation_service.serialize_path(g, plan.node_path), "steps": plan.steps, "unrouted": unrouted,
        "accessible_only": body.accessible_only, "positioning": "manual_start_point",
    }
