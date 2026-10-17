"""FastAPI dependencies: database session, authentication, merchant tenancy and permissions."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

import jwt
from fastapi import Depends, Header, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.exceptions import AuthenticationError, NotFoundError, PermissionDeniedError
from app.core.security import decode_access_token
from app.db.models import AuthSession, MerchantMembership, Store, StoreMembership, User
from app.db.session import get_db
from app.schemas.common import PageParams

DbSession = Session


def _extract_token(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.cookies.get(get_settings().session_cookie_name)


def authenticate_token(db: Session, token: str | None) -> tuple[User, AuthSession]:
    if not token:
        raise AuthenticationError("Authentication required")
    try:
        claims = decode_access_token(token)
        user_id = uuid.UUID(claims["sub"])
        session_id = uuid.UUID(claims["sid"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise AuthenticationError("Invalid or expired session") from exc
    sess = db.get(AuthSession, session_id)
    now = datetime.now(UTC)
    if sess is None or sess.user_id != user_id or sess.revoked_at is not None or sess.expires_at <= now:
        raise AuthenticationError("Session has ended, please sign in again")
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("Account is disabled")
    return user, sess


def get_current_session(request: Request, db: Session = Depends(get_db)) -> tuple[User, AuthSession]:
    return authenticate_token(db, _extract_token(request))


def get_current_user(auth: tuple[User, AuthSession] = Depends(get_current_session)) -> User:
    return auth[0]


def get_optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    token = _extract_token(request)
    if not token:
        return None
    try:
        return authenticate_token(db, token)[0]
    except AuthenticationError:
        return None


def require_customer(user: User = Depends(get_current_user)) -> User:
    if user.account_type != "customer":
        raise PermissionDeniedError("This action is only available to shopper accounts")
    return user


@dataclass(frozen=True)
class MerchantContext:
    """The authenticated merchant user, their active tenant, permissions and store scope."""

    user: User
    merchant_id: uuid.UUID
    merchant_name: str
    role: str
    permissions: frozenset[str]
    all_stores: bool
    store_ids: frozenset[uuid.UUID] = field(default_factory=frozenset)

    def can(self, permission: str) -> bool:
        return permission in self.permissions

    def require(self, permission: str) -> None:
        if not self.can(permission):
            raise PermissionDeniedError(f"Missing permission: {permission}")

    def can_access_store(self, store_id: uuid.UUID) -> bool:
        return self.all_stores or store_id in self.store_ids

    @property
    def actor_label(self) -> str:
        return f"{self.user.full_name} <{self.user.email}>"


def build_merchant_context(db: Session, user: User, merchant_id: uuid.UUID | None = None) -> MerchantContext:
    if user.account_type != "merchant":
        raise PermissionDeniedError("Merchant access required")
    stmt = select(MerchantMembership).where(
        MerchantMembership.user_id == user.id, MerchantMembership.is_active.is_(True)
    )
    if merchant_id:
        stmt = stmt.where(MerchantMembership.merchant_id == merchant_id)
    membership = db.scalars(stmt.order_by(MerchantMembership.created_at)).first()
    if membership is None:
        raise PermissionDeniedError("You are not a member of this merchant")
    store_ids: frozenset[uuid.UUID] = frozenset()
    if not membership.all_stores:
        store_ids = frozenset(
            db.scalars(select(StoreMembership.store_id).where(StoreMembership.user_id == user.id)).all()
        )
    return MerchantContext(
        user=user,
        merchant_id=membership.merchant_id,
        merchant_name=membership.merchant.name,
        role=membership.role.name,
        permissions=frozenset(p.code for p in membership.role.permissions),
        all_stores=membership.all_stores,
        store_ids=store_ids,
    )


def get_merchant_context(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    x_merchant_id: uuid.UUID | None = Header(default=None),
) -> MerchantContext:
    return build_merchant_context(db, user, x_merchant_id)


def require_permission(permission: str) -> Callable[..., MerchantContext]:
    def _dep(ctx: MerchantContext = Depends(get_merchant_context)) -> MerchantContext:
        ctx.require(permission)
        return ctx

    _dep.__name__ = f"require_{permission.replace('.', '_')}"
    return _dep


def get_store_scoped(db: Session, ctx: MerchantContext, store_id: uuid.UUID) -> Store:
    """Load a store owned by the caller's merchant. Foreign stores look like 404 (no existence leak)."""
    store = db.get(Store, store_id)
    if store is None or store.merchant_id != ctx.merchant_id:
        raise NotFoundError("Store not found")
    if not ctx.can_access_store(store_id):
        raise PermissionDeniedError("You do not have access to this store")
    return store


def resolve_store_ids(db: Session, ctx: MerchantContext, store_id: uuid.UUID | None) -> list[uuid.UUID]:
    """Stores a merchant query should cover: a specific (validated) store or every accessible store."""
    if store_id:
        return [get_store_scoped(db, ctx, store_id).id]
    ids = db.scalars(select(Store.id).where(Store.merchant_id == ctx.merchant_id)).all()
    return [i for i in ids if ctx.can_access_store(i)]


def page_params(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200)) -> PageParams:
    return PageParams(page=page, page_size=page_size)
