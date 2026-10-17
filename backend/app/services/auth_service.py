"""Authentication: credential checks, session issuing/revocation and registration."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dependencies import build_merchant_context
from app.core.exceptions import AuthenticationError, ConflictError
from app.core.security import create_access_token, hash_password, session_expiry, verify_password
from app.db.models import AccountSecurityEvent, AuthSession, NotificationPreference, User
from app.schemas.auth import MerchantAccess, MeResponse, UserOut
from app.services.audit_service import record_audit


def login(db: Session, email: str, password: str, user_agent: str | None, ip: str | None) -> tuple[User, str, datetime]:
    user = db.scalars(select(User).where(func.lower(User.email) == email.lower())).first()
    if user is None or not verify_password(password, user.password_hash):
        if user is not None:
            db.add(AccountSecurityEvent(user_id=user.id, event_type="failed_login", ip_address=ip))
            db.commit()
        raise AuthenticationError("Incorrect email or password", code="invalid_credentials")
    if not user.is_active:
        raise AuthenticationError("Account is disabled")
    expires_at = session_expiry()
    sess = AuthSession(user_id=user.id, expires_at=expires_at, user_agent=(user_agent or "")[:255], ip_address=ip)
    db.add(sess)
    user.last_login_at = datetime.now(UTC)
    db.flush()
    merchant_id = None
    if user.account_type == "merchant" and user.memberships:
        merchant_id = user.memberships[0].merchant_id
    record_audit(
        db, action="auth.login", entity_type="user", entity_id=user.id, summary="Signed in",
        actor=user, merchant_id=merchant_id, ip_address=ip,
    )
    db.commit()
    return user, create_access_token(user.id, sess.id, expires_at), expires_at


def logout(db: Session, sess: AuthSession, user: User) -> None:
    sess.revoked_at = datetime.now(UTC)
    record_audit(db, action="auth.logout", entity_type="user", entity_id=user.id, summary="Signed out", actor=user)
    db.commit()


def register_customer(db: Session, email: str, password: str, full_name: str) -> User:
    exists = db.scalars(select(User.id).where(func.lower(User.email) == email.lower())).first()
    if exists:
        raise ConflictError("An account with this email already exists")
    user = User(email=email.lower(), full_name=full_name, password_hash=hash_password(password), account_type="customer")
    db.add(user)
    db.flush()
    db.add(NotificationPreference(user_id=user.id))
    record_audit(db, action="auth.register", entity_type="user", entity_id=user.id, summary="Registered", actor=user)
    db.commit()
    return user


def describe_user(db: Session, user: User) -> MeResponse:
    merchant = None
    if user.account_type == "merchant":
        ctx = build_merchant_context(db, user)
        merchant = MerchantAccess(
            merchant_id=ctx.merchant_id,
            merchant_name=ctx.merchant_name,
            role=ctx.role,
            permissions=sorted(ctx.permissions),
            all_stores=ctx.all_stores,
            store_ids=sorted(ctx.store_ids),
        )
    return MeResponse(user=UserOut.model_validate(user), merchant=merchant)
