"""Real-time transport negotiation (Firestore via Firebase Auth custom tokens, or the WebSocket fallback)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import build_merchant_context, get_current_user, require_customer
from app.core.exceptions import BusinessRuleError
from app.db.models import User
from app.db.session import get_db
from app.integrations.firebase import firebase
from app.services import shopping_service

router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.get("/config")
def config(_: User = Depends(get_current_user)) -> dict:
    """Which transport the browser should use. Firestore when the deployment has Firebase enabled."""
    return {"transport": "firestore" if firebase.available() else "websocket"}


@router.post("/token")
def token(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict:
    """Firebase Auth custom token for the signed-in user (uid = user id, claims scope Firestore reads)."""
    claims: dict = {"account_type": user.account_type}
    if user.account_type == "merchant":
        claims["merchant_id"] = str(build_merchant_context(db, user).merchant_id)
    tok = firebase.custom_token(user.id, claims)
    if tok is None:
        raise BusinessRuleError("Real-time sync through Firebase is not enabled on this deployment",
                                code="firebase_disabled")
    return {"token": tok, "uid": str(user.id), "claims": claims}


@router.post("/lists/{list_id}/subscribe")
def subscribe_list(list_id: uuid.UUID, user: User = Depends(require_customer), db: Session = Depends(get_db)) -> dict:
    """Make sure the Firestore list document carries the current members before the browser listens."""
    sl, _ = shopping_service.get_list_for(db, list_id, user)
    return {"version": sl.version, "firestore": firebase.ensure_list(sl.id)}
