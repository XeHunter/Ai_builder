"""Shared shopping: invitations, membership and the real-time WebSocket channel.

WebSocket protocol (``/api/v1/ws/shopping-lists/{list_id}?last_seq=N``):

server -> client
  {"type": "snapshot", "list": ListView}                 initial state, or after a large gap
  {"type": "events", "events": [EventView, ...]}         catch-up after reconnect (last_seq given)
  {"type": "event", "event": EventView}                  live change made by anyone
  {"type": "ack", "client_event_id": str, "seq": int}    your operation was persisted
  {"type": "error", "client_event_id": str, "code": str, "message": str, "details": ...}
  {"type": "presence", "members_online": [...]}
  {"type": "pong"}
client -> server
  {"type": "op", "op": "add_item|update_item|remove_item|collect|uncollect", "client_event_id": str, ...}
  {"type": "ping"}

Authentication uses the session cookie (sent automatically by browsers on same-origin upgrades)
or ``?token=`` for non-browser clients. Membership is checked on connect and on every operation.
"""

from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, Query, Response, WebSocket, WebSocketDisconnect, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.api.dependencies import authenticate_token, require_customer
from app.core.config import get_settings
from app.core.exceptions import AppError
from app.core.logging import get_logger
from app.db.models import User
from app.db.session import SessionLocal, get_db
from app.schemas.shopping import (
    InvitationCreate,
    InvitationCreated,
    InvitationOut,
    InvitationPreview,
    ListView,
)
from app.services import collaboration_service, shopping_service
from app.websocket.hub import hub

log = get_logger(__name__)
router = APIRouter(tags=["shared-shopping"])
RESYNC_EVENT_LIMIT = 200


def _inv_out(inv) -> dict:
    return {"id": str(inv.id), "role": inv.role, "expires_at": inv.expires_at.isoformat(), "max_uses": inv.max_uses,
            "use_count": inv.use_count, "revoked": inv.revoked_at is not None, "created_at": inv.created_at.isoformat()}


@router.post("/shopping-lists/{list_id}/invitations", response_model=InvitationCreated, status_code=status.HTTP_201_CREATED)
def create_invitation(list_id: uuid.UUID, body: InvitationCreate, db: Session = Depends(get_db),
                      user: User = Depends(require_customer)) -> dict:
    """Create an expiring, use-limited invitation link + QR code. The token is shown only once."""
    sl, m = shopping_service.get_list_for(db, list_id, user)
    inv, token = collaboration_service.create_invitation(db, sl, m, user, role=body.role, ttl_hours=body.ttl_hours,
                                                         max_uses=body.max_uses)
    url = collaboration_service.invitation_url(token)
    return {**_inv_out(inv), "token": token, "url": url, "qr_svg": collaboration_service.qr_svg(url)}


@router.get("/shopping-lists/{list_id}/invitations", response_model=list[InvitationOut])
def list_invitations(list_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> list[dict]:
    sl, _ = shopping_service.get_list_for(db, list_id, user)
    return [_inv_out(i) for i in collaboration_service.list_invitations(db, sl)]


@router.delete("/shopping-lists/{list_id}/invitations/{invitation_id}", response_model=InvitationOut)
def revoke_invitation(list_id: uuid.UUID, invitation_id: uuid.UUID, db: Session = Depends(get_db),
                      user: User = Depends(require_customer)) -> dict:
    sl, m = shopping_service.get_list_for(db, list_id, user)
    return _inv_out(collaboration_service.revoke_invitation(db, sl, m, invitation_id))


@router.get("/invitations/{token}", response_model=InvitationPreview)
def preview_invitation(token: str, db: Session = Depends(get_db), _: User = Depends(require_customer)) -> dict:
    return collaboration_service.preview_invitation(db, token)


@router.post("/invitations/{token}/accept", response_model=ListView)
def accept_invitation(token: str, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    sl, m, new = collaboration_service.accept_invitation(db, token, user)
    if new:
        ev = shopping_service.events_since(db, sl, sl.version - 1)
        if ev:
            hub.publish(sl.id, {"type": "event", "event": shopping_service.event_view(ev[-1], user.full_name)})
    return shopping_service.list_view(db, sl, m)


@router.delete("/shopping-lists/{list_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(list_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db),
                  user: User = Depends(require_customer)) -> Response:
    sl, m = shopping_service.get_list_for(db, list_id, user)
    collaboration_service.remove_member(db, sl, m, user, user_id)
    hub.publish(sl.id, {"type": "member_removed", "user_id": str(user_id)})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------- WebSocket


def _ws_connect(token: str | None, list_id: uuid.UUID, last_seq: int | None) -> tuple[dict, list[dict]]:
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, token)
        sl, m = shopping_service.get_list_for(db, list_id, user)
        messages: list[dict] = []
        if last_seq is not None and 0 <= last_seq <= sl.version and \
                shopping_service.event_count_since(db, sl, last_seq) <= RESYNC_EVENT_LIMIT:
            evs = shopping_service.events_since(db, sl, last_seq, RESYNC_EVENT_LIMIT)
            messages.append({"type": "events", "events": [shopping_service.event_view(e) for e in evs],
                             "list_version": sl.version})
        else:
            messages.append({"type": "snapshot", "list": shopping_service.list_view(db, sl, m)})
        return {"user_id": str(user.id), "name": user.full_name, "id": user.id}, messages
    finally:
        db.close()


def _ws_apply(user_id: uuid.UUID, list_id: uuid.UUID, op: dict) -> dict:
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        sl, m = shopping_service.get_list_for(db, list_id, user, write=True)
        ev, item = shopping_service.apply_operation(db, sl, m, user, op)
        return {"event": shopping_service.event_view(ev, user.full_name), "item": item}
    finally:
        db.close()


@router.websocket("/ws/shopping-lists/{list_id}")
async def list_socket(websocket: WebSocket, list_id: uuid.UUID, last_seq: int | None = Query(None),
                      token: str | None = Query(None)) -> None:
    token = token or websocket.cookies.get(get_settings().session_cookie_name)
    try:
        user, initial = await run_in_threadpool(_ws_connect, token, list_id, last_seq)
    except AppError as exc:
        await websocket.close(code=4401 if exc.status_code == 401 else 4404, reason=exc.message[:120])
        return
    await websocket.accept()
    hub.bind_loop(asyncio.get_running_loop())
    for msg in initial:
        await websocket.send_json(msg)
    await hub.join(list_id, websocket, {"user_id": user["user_id"], "name": user["name"]})
    try:
        while True:
            msg = await websocket.receive_json()
            kind = msg.get("type")
            if kind == "ping":
                await websocket.send_json({"type": "pong"})
                continue
            if kind != "op":
                await websocket.send_json({"type": "error", "code": "bad_message", "message": "Unknown message type"})
                continue
            cid = msg.get("client_event_id")
            try:
                res = await run_in_threadpool(_ws_apply, user["id"], list_id, msg)
            except AppError as exc:
                await websocket.send_json({"type": "error", "client_event_id": cid, "code": exc.code,
                                           "message": exc.message, "details": exc.details})
                continue
            except Exception as exc:  # pragma: no cover
                log.exception("WebSocket op failed: %s", exc)
                await websocket.send_json({"type": "error", "client_event_id": cid, "code": "internal_error",
                                           "message": "Operation failed"})
                continue
            await websocket.send_json({"type": "ack", "client_event_id": cid, "seq": res["event"]["seq"],
                                       "item": res["item"]})
            hub.publish(list_id, {"type": "event", "event": res["event"]})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover
        log.warning("WebSocket closed with error: %s", exc)
    finally:
        await hub.leave(list_id, websocket)
