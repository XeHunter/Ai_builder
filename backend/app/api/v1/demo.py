"""Demo maintenance: nightly reset of the date-relative demo dataset (scheduler only)."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Header

from app.core.config import get_settings
from app.core.exceptions import NotFoundError, PermissionDeniedError
from app.services import demo_service

router = APIRouter(prefix="/demo", tags=["demo"])


@router.post("/reset")
def reset(force: bool = False, x_reset_token: str | None = Header(default=None)) -> dict:
    """Wipe and reseed the demo data with today's dates. Needs ``X-Reset-Token`` = ``DEMO_RESET_TOKEN``.

    Disabled (404) unless the deployment is a demo with a reset token configured."""
    s = get_settings()
    if not (s.demo_mode and s.demo_reset_token):
        raise NotFoundError("Not found")
    if not x_reset_token or not hmac.compare_digest(x_reset_token, s.demo_reset_token):
        raise PermissionDeniedError("Invalid reset token")
    return demo_service.reset_demo_data(force=force)
