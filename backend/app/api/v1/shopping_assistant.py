"""Conversational shopping concierge and visual product discovery."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.orm import Session

from app.ai.recommendations.assistant import chat
from app.ai.visual_search.service import search_by_image
from app.api.dependencies import get_current_user
from app.core.config import get_settings
from app.core.exceptions import NotFoundError, ValidationFailedError
from app.core.rate_limit import rate_limiter
from app.db.models import Store, User
from app.db.session import get_db
from app.schemas.shopping import AssistantRequest, AssistantResponse, VisualSearchResponse

router = APIRouter(tags=["shopping-assistant"])


@router.post("/assistant/chat", response_model=AssistantResponse)
def assistant_chat(body: AssistantRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Interpret a shopping request and answer from verified catalog, stock, price and location data."""
    rate_limiter.hit(f"assistant:{user.id}", 30)
    store = db.get(Store, body.store_id)
    if store is None:
        raise NotFoundError("Store not found")
    return chat(db, store, body.message, body.context_product_id)


@router.post("/visual-search", response_model=VisualSearchResponse)
def visual_search(
    store_id: uuid.UUID = Form(...),
    image: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Find catalog products that look like the uploaded photo (JPEG/PNG/WebP, size-limited)."""
    rate_limiter.hit(f"visual:{user.id}", 20)
    store = db.get(Store, store_id)
    if store is None:
        raise NotFoundError("Store not found")
    limit = get_settings().max_upload_bytes
    data = image.file.read(limit + 1)
    if len(data) > limit:
        raise ValidationFailedError(f"Image exceeds the {get_settings().max_upload_mb} MB limit")
    return search_by_image(db, store, data, image.content_type)
