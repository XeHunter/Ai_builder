"""Shared shopping: invitations (hashed, expiring, revocable, use-limited), QR codes and members."""

from __future__ import annotations

import io
import uuid
from datetime import UTC, datetime, timedelta

import segno
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.exceptions import BusinessRuleError, NotFoundError, PermissionDeniedError
from app.core.security import hash_token, new_opaque_token
from app.db.models import ListInvitation, ListMembership, ShoppingList, User
from app.services.notification_service import notify
from app.services.shopping_service import _next_event


def qr_svg(data: str) -> str:
    buf = io.BytesIO()
    segno.make(data, error="m").save(buf, kind="svg", scale=4, border=2, xmldecl=False, svgns=True)
    return buf.getvalue().decode()


def create_invitation(db: Session, sl: ShoppingList, m: ListMembership, actor: User, *, role: str,
                      ttl_hours: int | None, max_uses: int) -> tuple[ListInvitation, str]:
    if m.role != "owner":
        raise PermissionDeniedError("Only the list owner can invite members")
    if role not in ("editor", "viewer"):
        raise BusinessRuleError("Role must be editor or viewer")
    ttl = ttl_hours or get_settings().invitation_ttl_hours
    if not 1 <= ttl <= 24 * 14:
        raise BusinessRuleError("Invitation lifetime must be between 1 hour and 14 days")
    token = new_opaque_token()
    inv = ListInvitation(list_id=sl.id, token_hash=hash_token(token), role=role, created_by_id=actor.id,
                         expires_at=datetime.now(UTC) + timedelta(hours=ttl), max_uses=max_uses)
    db.add(inv)
    sl.is_shared = True
    db.commit()
    return inv, token


def invitation_url(token: str) -> str:
    return f"{get_settings().frontend_base_url.rstrip('/')}/invite/{token}"


def _valid_invitation(db: Session, token: str) -> ListInvitation:
    inv = db.scalars(select(ListInvitation).where(ListInvitation.token_hash == hash_token(token))).first()
    if inv is None:
        raise NotFoundError("Invitation not found")
    if inv.revoked_at is not None:
        raise BusinessRuleError("This invitation has been revoked", code="invitation_revoked")
    if inv.expires_at <= datetime.now(UTC):
        raise BusinessRuleError("This invitation has expired", code="invitation_expired")
    if inv.use_count >= inv.max_uses:
        raise BusinessRuleError("This invitation has reached its use limit", code="invitation_exhausted")
    return inv


def preview_invitation(db: Session, token: str) -> dict:
    inv = _valid_invitation(db, token)
    sl = db.get(ShoppingList, inv.list_id)
    owner = db.get(User, sl.owner_id)
    return {"list_name": sl.name, "owner_name": owner.full_name, "role": inv.role,
            "expires_at": inv.expires_at.isoformat(), "item_count": len(sl.items)}


def accept_invitation(db: Session, token: str, user: User) -> tuple[ShoppingList, ListMembership, bool]:
    if user.account_type != "customer":
        raise PermissionDeniedError("Only shopper accounts can join shopping lists")
    inv = _valid_invitation(db, token)
    sl = db.get(ShoppingList, inv.list_id)
    existing = db.scalars(select(ListMembership).where(ListMembership.list_id == sl.id,
                                                       ListMembership.user_id == user.id)).first()
    if existing:
        return sl, existing, False
    m = ListMembership(list_id=sl.id, user_id=user.id, role=inv.role)
    db.add(m)
    inv.use_count += 1
    _next_event(db, sl, "member_joined", user, {"user_id": str(user.id), "name": user.full_name, "role": inv.role})
    notify(db, user_id=sl.owner_id, notification_type="shared_list", title=f"{user.full_name} joined '{sl.name}'",
           body=f"{user.full_name} can now {'edit' if inv.role == 'editor' else 'view'} your list.",
           idempotency_key=f"joined:{sl.id}:{user.id}", link=f"/shop/lists/{sl.id}")
    db.commit()
    return sl, m, True


def revoke_invitation(db: Session, sl: ShoppingList, m: ListMembership, invitation_id: uuid.UUID) -> ListInvitation:
    if m.role != "owner":
        raise PermissionDeniedError("Only the list owner can revoke invitations")
    inv = db.get(ListInvitation, invitation_id)
    if inv is None or inv.list_id != sl.id:
        raise NotFoundError("Invitation not found")
    inv.revoked_at = inv.revoked_at or datetime.now(UTC)
    db.commit()
    return inv


def list_invitations(db: Session, sl: ShoppingList) -> list[ListInvitation]:
    return list(db.scalars(select(ListInvitation).where(ListInvitation.list_id == sl.id)
                           .order_by(ListInvitation.created_at.desc())))


def remove_member(db: Session, sl: ShoppingList, m: ListMembership, actor: User, user_id: uuid.UUID) -> None:
    if user_id != actor.id and m.role != "owner":
        raise PermissionDeniedError("Only the owner can remove other members")
    target = db.scalars(select(ListMembership).where(ListMembership.list_id == sl.id,
                                                     ListMembership.user_id == user_id)).first()
    if target is None:
        raise NotFoundError("Member not found")
    if target.role == "owner":
        raise BusinessRuleError("The owner cannot be removed from their own list")
    db.delete(target)
    _next_event(db, sl, "member_left", actor, {"user_id": str(user_id)})
    db.commit()
