"""Authentication endpoints. Sessions are JWTs carried in an httpOnly cookie (or a Bearer header)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_session, get_current_user
from app.core.config import get_settings
from app.core.exceptions import NotFoundError, PermissionDeniedError
from app.core.rate_limit import rate_limiter
from app.db.models import AuthSession, Store, User
from app.db.session import get_db
from app.schemas.auth import (
    DemoLoginRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    RegisterRequest,
    UpdateProfileRequest,
)
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        s.session_cookie_name,
        token,
        max_age=s.access_token_minutes * 60,
        httponly=True,
        secure=s.cookie_secure,
        samesite=s.cookie_samesite,
        path="/",
    )


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> LoginResponse:
    """Exchange credentials for a session. Rate limited per IP and per email."""
    ip = _client_ip(request)
    limit = get_settings().login_rate_limit_per_minute
    rate_limiter.hit(f"login:ip:{ip}", limit)
    rate_limiter.hit(f"login:email:{body.email.lower()}", limit)
    user, token, expires_at = auth_service.login(db, body.email, body.password, request.headers.get("user-agent"), ip)
    _set_cookie(response, token)
    me = auth_service.describe_user(db, user)
    return LoginResponse(**me.model_dump(), access_token=token, expires_at=expires_at.isoformat())


@router.get("/demo-personas")
def demo_personas() -> dict:
    """Whether one-click demo sign-in is available on this deployment (public)."""
    return {"enabled": get_settings().demo_login_enabled, "personas": sorted(auth_service.DEMO_PERSONAS)}


@router.post("/demo-login", response_model=LoginResponse)
def demo_login(body: DemoLoginRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> LoginResponse:
    """Sign in as a demo persona without a password (demo deployments only)."""
    if not get_settings().demo_login_enabled:
        raise PermissionDeniedError("One-click demo sign-in is disabled on this deployment")
    ip = _client_ip(request)
    rate_limiter.hit(f"login:ip:{ip}", get_settings().login_rate_limit_per_minute)
    user, token, expires_at = auth_service.demo_login(db, body.persona, request.headers.get("user-agent"), ip)
    _set_cookie(response, token)
    me = auth_service.describe_user(db, user)
    return LoginResponse(**me.model_dump(), access_token=token, expires_at=expires_at.isoformat())


@router.post("/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, request: Request, response: Response, db: Session = Depends(get_db)) -> LoginResponse:
    """Create a shopper account and sign it in. Merchant accounts are provisioned by an administrator."""
    rate_limiter.hit(f"register:ip:{_client_ip(request)}", 5)
    auth_service.register_customer(db, body.email, body.password, body.full_name)
    return login(LoginRequest(email=body.email, password=body.password), request, response, db)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    auth: tuple[User, AuthSession] = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> Response:
    user, sess = auth
    auth_service.logout(db, db.merge(sess), user)
    response.status_code = status.HTTP_204_NO_CONTENT
    response.delete_cookie(get_settings().session_cookie_name, path="/")
    return response


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MeResponse:
    return auth_service.describe_user(db, user)


@router.patch("/me", response_model=MeResponse)
def update_me(body: UpdateProfileRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MeResponse:
    user = db.merge(user)
    if body.full_name is not None:
        user.full_name = body.full_name
    if "preferred_store_id" in body.model_fields_set:
        if body.preferred_store_id and db.get(Store, body.preferred_store_id) is None:
            raise NotFoundError("Store not found")
        user.preferred_store_id = body.preferred_store_id
    db.commit()
    return auth_service.describe_user(db, user)
