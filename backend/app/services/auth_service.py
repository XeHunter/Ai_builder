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
    return start_session(db, user, user_agent, ip)


def start_session(db: Session, user: User, user_agent: str | None, ip: str | None,
                  summary: str = "Signed in") -> tuple[User, str, datetime]:
    expires_at = session_expiry()
    sess = AuthSession(user_id=user.id, expires_at=expires_at, user_agent=(user_agent or "")[:255], ip_address=ip)
    db.add(sess)
    user.last_login_at = datetime.now(UTC)
    db.flush()
    merchant_id = None
    if user.account_type == "merchant" and user.memberships:
        merchant_id = user.memberships[0].merchant_id
    record_audit(
        db, action="auth.login", entity_type="user", entity_id=user.id, summary=summary,
        actor=user, merchant_id=merchant_id, ip_address=ip,
    )
    db.commit()
    return user, create_access_token(user.id, sess.id, expires_at), expires_at


# One-click personas for judges / demos (POST /auth/demo-login, only when DEMO_LOGIN_ENABLED).
DEMO_PERSONAS: dict[str, str] = {
    "customer": "priya@demo.omnipulse.ai",
    "customer2": "rohan@demo.omnipulse.ai",
    "owner": "admin@freshmart.demo",
    "manager": "manager.andheri@freshmart.demo",
    "analyst": "analyst@freshmart.demo",
}


def demo_login(db: Session, persona: str, user_agent: str | None, ip: str | None) -> tuple[User, str, datetime]:
    email = DEMO_PERSONAS.get(persona)
    user = db.scalars(select(User).where(User.email == email)).first() if email else None
    if user is None or not user.is_active:
        raise AuthenticationError("Demo account is not available", code="demo_unavailable")
    return start_session(db, user, user_agent, ip, summary=f"Signed in with the one-click demo ({persona})")


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
