"""Store-owner onboarding: sign-up, stores, floor-plan builder, starter files and first analytics run."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, require_permission
from app.api.v1.auth import login as login_endpoint
from app.core.exceptions import ValidationFailedError
from app.core.rate_limit import rate_limiter
from app.db.session import get_db
from app.schemas.auth import LoginRequest, LoginResponse
from app.seed.layout_builder import LayoutSpec
from app.services import channel_service, onboarding_service

router = APIRouter(tags=["onboarding"])


class MerchantSignup(BaseModel):
    business_name: str = Field(min_length=2, max_length=120)
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LayoutSpecIn(BaseModel):
    aisles: int = Field(6, ge=1, le=12)
    sections: int = Field(4, ge=2, le=8)
    levels: int = Field(5, ge=2, le=6)
    dairy_wall: bool = True
    produce_wall: bool = True
    frozen_wall: bool = True
    checkouts: int = Field(3, ge=1, le=8)

    def spec(self) -> LayoutSpec:
        return LayoutSpec(**self.model_dump())


class StoreCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    address: str = Field("", max_length=255)
    city: str = Field("", max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9]{2,12}$")
    layout: LayoutSpecIn | None = None


@router.post("/onboarding/merchant", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
def signup(body: MerchantSignup, request: Request, response: Response, db: Session = Depends(get_db)) -> LoginResponse:
    """Self-service sign-up for a store owner. Creates the tenant with default policies and signs in."""
    rate_limiter.hit(f"register:ip:{request.client.host if request.client else 'unknown'}", 5)
    onboarding_service.register_merchant(db, business_name=body.business_name, full_name=body.full_name,
                                         email=body.email, password=body.password)
    return login_endpoint(LoginRequest(email=body.email, password=body.password), request, response, db)


@router.get("/merchant/onboarding/status")
def onboarding_status(ctx: MerchantContext = Depends(require_permission("insights.read")),
                      db: Session = Depends(get_db)) -> dict:
    return onboarding_service.status(db, ctx.merchant_id)


@router.post("/merchant/stores", status_code=status.HTTP_201_CREATED)
def create_store(body: StoreCreate, ctx: MerchantContext = Depends(require_permission("settings.manage")),
                 db: Session = Depends(get_db)) -> dict:
    store = onboarding_service.create_store(
        db, merchant_id=ctx.merchant_id, actor=ctx.user, name=body.name, address=body.address, city=body.city,
        latitude=body.latitude, longitude=body.longitude, code=body.code,
        layout=body.layout.spec() if body.layout else None)
    return {"id": str(store.id), "code": store.code, "name": store.name, "city": store.city}


@router.post("/merchant/stores/{store_id}/layout-preview")
def layout_preview(store_id: uuid.UUID, body: LayoutSpecIn,
                   ctx: MerchantContext = Depends(require_permission("layout.read")), db: Session = Depends(get_db)) -> dict:
    """Generate a floor plan from the parameters without saving it."""
    store = onboarding_service.get_owned_store(db, ctx.merchant_id, store_id)
    return onboarding_service.preview_layout(db, store, body.spec())


@router.post("/merchant/stores/{store_id}/layout-generate", status_code=status.HTTP_201_CREATED)
def layout_generate(store_id: uuid.UUID, body: LayoutSpecIn,
                    ctx: MerchantContext = Depends(require_permission("layout.write")), db: Session = Depends(get_db)) -> dict:
    """Save the generated plan: active for a new store, or a draft when products are already placed."""
    store = onboarding_service.get_owned_store(db, ctx.merchant_id, store_id)
    if not ctx.can_access_store(store.id):
        raise ValidationFailedError("You do not have access to this store")
    layout, outcome = onboarding_service.apply_layout(db, store, body.spec(), ctx.user)
    return {"layout_id": str(layout.id), "status": outcome, "version": layout.version}


@router.get("/merchant/stores/{store_id}/starter-catalog.csv", response_class=PlainTextResponse)
def starter_catalog(store_id: uuid.UUID, limit: int = Query(60, ge=5, le=200),
                    ctx: MerchantContext = Depends(require_permission("inventory.import")),
                    db: Session = Depends(get_db)) -> PlainTextResponse:
    """Sample catalog in the standard import format with shelf codes from this store's layout."""
    store = onboarding_service.get_owned_store(db, ctx.merchant_id, store_id)
    return PlainTextResponse(onboarding_service.starter_catalog_csv(db, store, limit), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{store.code}-starter-catalog.csv"'})


@router.get("/merchant/stores/{store_id}/starter-sales.csv", response_class=PlainTextResponse)
def starter_sales(store_id: uuid.UUID, days: int = Query(60, ge=14, le=120), per_day: int = Query(40, ge=5, le=150),
                  ctx: MerchantContext = Depends(require_permission("inventory.import")),
                  db: Session = Depends(get_db)) -> PlainTextResponse:
    """Sample POS export (sales history) generated over this store's own catalog."""
    store = onboarding_service.get_owned_store(db, ctx.merchant_id, store_id)
    return PlainTextResponse(channel_service.starter_sales_csv(db, store, days=days, per_day=per_day),
                             media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{store.code}-sales-history.csv"'})


@router.post("/merchant/onboarding/finish")
def finish(ctx: MerchantContext = Depends(require_permission("settings.manage")), db: Session = Depends(get_db)) -> dict:
    """Generate missing product images, rebuild the search index and run the first analytics."""
    return {**onboarding_service.run_setup_analytics(db, ctx.merchant_id, ctx.user),
            "status": onboarding_service.status(db, ctx.merchant_id)}
