"""Smart shopping lists: parse, CRUD, item operations, event log and route planning."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import require_customer
from app.core.exceptions import BusinessRuleError, NotFoundError, PermissionDeniedError
from app.db.models import Store, User
from app.db.session import get_db
from app.schemas.shopping import (
    EventView,
    ItemUpdate,
    ListCreate,
    ListItemIn,
    ListSummary,
    ListUpdate,
    ListView,
    OperationResult,
    ParseRequest,
    ParseResponse,
    RouteRequest,
    RouteResponse,
)
from app.services import channel_service, notification_service, shopping_service
from app.websocket.hub import hub

router = APIRouter(prefix="/shopping-lists", tags=["shopping-lists"])


@router.post("/parse", response_model=ParseResponse)
def parse(body: ParseRequest, db: Session = Depends(get_db), _: User = Depends(require_customer)) -> dict:
    """Turn free text into structured items matched against the store catalog (nothing is saved)."""
    store = db.get(Store, body.store_id)
    if store is None:
        raise NotFoundError("Store not found")
    return shopping_service.parse_and_match(db, store, body.text)


@router.get("", response_model=list[ListSummary])
def my_lists(db: Session = Depends(get_db), user: User = Depends(require_customer)) -> list[dict]:
    out = []
    for sl, m in shopping_service.user_lists(db, user):
        store = db.get(Store, sl.store_id) if sl.store_id else None
        out.append({"id": str(sl.id), "name": sl.name, "status": sl.status, "is_shared": sl.is_shared,
                    "store_id": str(store.id) if store else None, "store_name": store.name if store else None, "item_count": len(sl.items),
                    "collected_count": sum(1 for i in sl.items if i.status == "collected"), "my_role": m.role,
                    "updated_at": sl.updated_at.isoformat()})
    return out


@router.post("", response_model=ListView, status_code=status.HTTP_201_CREATED)
def create(body: ListCreate, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    sl = shopping_service.create_list(db, user, name=body.name, store_id=body.store_id, raw_input=body.raw_input,
                                      items=[i.model_dump() for i in body.items])
    sl, m = shopping_service.get_list_for(db, sl.id, user)
    return shopping_service.list_view(db, sl, m)


@router.get("/{list_id}", response_model=ListView)
def detail(list_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    sl, m = shopping_service.get_list_for(db, list_id, user)
    return shopping_service.list_view(db, sl, m)


@router.patch("/{list_id}", response_model=ListView)
def update(list_id: uuid.UUID, body: ListUpdate, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    sl, m = shopping_service.get_list_for(db, list_id, user, write=True)
    changes = body.model_dump(exclude_unset=True)
    if "store_id" in changes and changes["store_id"] and db.get(Store, changes["store_id"]) is None:
        raise NotFoundError("Store not found")
    for k, v in changes.items():
        setattr(sl, k, v)
    ev = shopping_service._next_event(db, sl, "list_updated", user, {k: str(v) for k, v in changes.items()})
    db.commit()
    hub.publish(sl.id, {"type": "event", "event": shopping_service.event_view(ev, user.full_name)})
    return shopping_service.list_view(db, sl, m)


@router.delete("/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete(list_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> Response:
    sl, m = shopping_service.get_list_for(db, list_id, user)
    if m.role != "owner":
        raise PermissionDeniedError("Only the owner can delete this list")
    hub.publish(sl.id, {"type": "list_deleted"})
    db.delete(sl)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _run_op(db: Session, list_id: uuid.UUID, user: User, op: dict) -> dict:
    sl, m = shopping_service.get_list_for(db, list_id, user, write=True)
    ev, item = shopping_service.apply_operation(db, sl, m, user, op)
    view = shopping_service.event_view(ev, user.full_name)
    hub.publish(sl.id, {"type": "event", "event": view})
    return {"event": view, "item": item, "list_version": sl.version}


@router.post("/{list_id}/items", response_model=OperationResult, status_code=status.HTTP_201_CREATED)
def add_item(list_id: uuid.UUID, body: ListItemIn, client_event_id: str | None = Query(None, max_length=64),
             db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    """Add an item by free text (matched to the catalog) or by product id. Duplicates are merged."""
    return _run_op(db, list_id, user, {"op": "add_item", **body.model_dump(mode="json"), "client_event_id": client_event_id})


@router.patch("/{list_id}/items/{item_id}", response_model=OperationResult)
def update_item(list_id: uuid.UUID, item_id: uuid.UUID, body: ItemUpdate, db: Session = Depends(get_db),
                user: User = Depends(require_customer)) -> dict:
    """Change quantity/unit/product match (optimistic ``expected_version``) or collect/uncollect."""
    data = body.model_dump(mode="json", exclude_unset=True)
    status_change = data.pop("status", None)
    cid = data.pop("client_event_id", None)
    if status_change:
        return _run_op(db, list_id, user, {"op": "collect" if status_change == "collected" else "uncollect",
                                           "item_id": str(item_id), "client_event_id": cid})
    return _run_op(db, list_id, user, {"op": "update_item", "item_id": str(item_id), "client_event_id": cid, **data})


@router.delete("/{list_id}/items/{item_id}", response_model=OperationResult)
def remove_item(list_id: uuid.UUID, item_id: uuid.UUID, client_event_id: str | None = Query(None, max_length=64),
                db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    return _run_op(db, list_id, user, {"op": "remove_item", "item_id": str(item_id), "client_event_id": client_event_id})


@router.get("/{list_id}/events", response_model=list[EventView])
def events(list_id: uuid.UUID, since: int = Query(0, ge=0), db: Session = Depends(get_db),
           user: User = Depends(require_customer)) -> list[dict]:
    """Events after sequence ``since`` - used by clients to resynchronise after a disconnect."""
    sl, _ = shopping_service.get_list_for(db, list_id, user)
    return [shopping_service.event_view(e) for e in shopping_service.events_since(db, sl, since)]


@router.post("/{list_id}/route", response_model=RouteResponse)
def route(list_id: uuid.UUID, body: RouteRequest, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    """Optimised walking route through the store for the list's uncollected items."""
    sl, _ = shopping_service.get_list_for(db, list_id, user)
    return shopping_service.route_for_list(db, sl, start_x=body.start_x, start_y=body.start_y,
                                           accessible_only=body.accessible_only,
                                           include_collected=body.include_collected, end=body.end)


_COUNT_UNITS = {None, "", "pc", "pcs", "piece", "pieces", "pack", "packs", "packet", "packets", "x", "each"}


class PickupOrder(BaseModel):
    payment_method: str = Field("upi", pattern="^(upi|card|cash|wallet)$")


@router.post("/{list_id}/order", status_code=status.HTTP_201_CREATED)
def order_for_pickup(list_id: uuid.UUID, body: PickupOrder, db: Session = Depends(get_db),
                     user: User = Depends(require_customer)) -> dict:
    """Click & collect: order the list's matched, uncollected items for pickup at the list's store.

    The order goes through the same omnichannel ingestion as a POS bill (``channel=online``): stock is
    reserved FEFO, the store's live feed updates instantly, and shared-list members see the items
    ticked off in real time."""
    sl, m = shopping_service.get_list_for(db, list_id, user, write=True)
    store = db.get(Store, sl.store_id) if sl.store_id else None
    if store is None:
        raise BusinessRuleError("Choose a store for this list before ordering")
    items = [i for i in sl.items if i.product_id and i.status == "pending"]
    if not items:
        raise BusinessRuleError("There are no matched, uncollected items to order")
    lines = [channel_service.OrderLine(
        quantity=channel_service.ceil_qty(i.quantity) if (i.unit or "").lower() in _COUNT_UNITS else 1,
        product_id=i.product_id) for i in items]
    order = channel_service.ingest_order(db, merchant_id=store.merchant_id, store=store, channel="online",
                                         external_id=None, lines=lines, customer=user, payment_method=body.payment_method,
                                         source="OmniPulse app - click & collect")
    for it in items:
        ev, _ = shopping_service.apply_operation(db, sl, m, user, {"op": "collect", "item_id": str(it.id)})
        hub.publish(sl.id, {"type": "event", "event": shopping_service.event_view(ev, user.full_name)})
    notification_service.notify(
        db, user_id=user.id, notification_type="shopping_reminder", title=f"Order {order['receipt_number']} confirmed",
        body=f"{order['item_count']} items, ₹{order['total']:.2f}. Pick up at {store.name} - we'll keep it at the checkout.",
        idempotency_key=f"pickup:{order['id']}", link=f"/shop/lists/{sl.id}")
    db.commit()
    return order
