"""Password hashing, JWT session tokens and opaque token helpers."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: uuid.UUID, session_id: uuid.UUID, expires_at: datetime) -> str:
    s = get_settings()
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": int(datetime.now(UTC).timestamp()),
        "exp": int(expires_at.timestamp()),
        "iss": "omnipulse",
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    s = get_settings()
    return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm], issuer="omnipulse")


def session_expiry() -> datetime:
    return datetime.now(UTC) + timedelta(minutes=get_settings().access_token_minutes)


def new_opaque_token(nbytes: int = 24) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    """Invitation tokens are stored hashed so a database leak does not grant list access."""
    return hashlib.sha256(token.encode()).hexdigest()
