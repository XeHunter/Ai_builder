from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import ORMModel


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class DemoLoginRequest(BaseModel):
    persona: Literal["customer", "customer2", "owner", "manager", "analyst"]


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=120)


class MerchantAccess(BaseModel):
    merchant_id: uuid.UUID
    merchant_name: str
    role: str
    permissions: list[str]
    all_stores: bool
    store_ids: list[uuid.UUID]


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    full_name: str
    account_type: str
    preferred_store_id: uuid.UUID | None = None


class MeResponse(BaseModel):
    user: UserOut
    merchant: MerchantAccess | None = None


class LoginResponse(MeResponse):
    access_token: str
    token_type: str = "bearer"
    expires_at: str


class UpdateProfileRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=2, max_length=120)
    preferred_store_id: uuid.UUID | None = None
