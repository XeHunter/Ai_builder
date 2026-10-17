"""In-app notifications, notification/consent preferences and location reports (geofencing)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, require_customer
from app.core.exceptions import NotFoundError
from app.core.rate_limit import rate_limiter
from app.db.models import Notification, User
from app.db.session import get_db
from app.services import geofence_service
from app.services.audit_service import record_audit
from app.services.notification_service import get_preferences

router = APIRouter(tags=["notifications"])


@router.get("/notifications")
def list_notifications(unread_only: bool = False, limit: int = Query(30, ge=1, le=100), db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)) -> dict:
    stmt = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    rows = db.scalars(stmt.order_by(Notification.created_at.desc()).limit(limit)).all()
    unread = db.scalar(select(func.count(Notification.id)).where(Notification.user_id == user.id,
                                                                 Notification.read_at.is_(None))) or 0
    return {"unread": unread, "items": [{"id": str(n.id), "type": n.notification_type, "title": n.title, "body": n.body,
                                         "link": n.link, "data": n.data, "channel": n.channel,
                                         "read": n.read_at is not None, "created_at": n.created_at.isoformat()}
                                        for n in rows]}


@router.post("/notifications/{notification_id}/read")
def mark_read(notification_id: uuid.UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise NotFoundError("Notification not found")
    n.read_at = n.read_at or datetime.now(UTC)
    db.commit()
    return {"id": str(n.id), "read": True}


@router.post("/notifications/read-all")
def mark_all_read(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    res = db.execute(update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
                     .values(read_at=datetime.now(UTC)))
    db.commit()
    return {"updated": res.rowcount}


class PreferencesOut(BaseModel):
    in_app_enabled: bool
    email_enabled: bool
    sms_enabled: bool
    push_enabled: bool
    marketing_opt_in: bool
    location_consent: bool
    location_consent_at: datetime | None
    abandoned_list_reminders: bool
    cooldown_minutes: int


class PreferencesUpdate(BaseModel):
    in_app_enabled: bool | None = None
    email_enabled: bool | None = None
    sms_enabled: bool | None = None
    push_enabled: bool | None = None
    marketing_opt_in: bool | None = None
    location_consent: bool | None = None
    abandoned_list_reminders: bool | None = None
    cooldown_minutes: int | None = Field(default=None, ge=15, le=10080)


@router.get("/me/preferences", response_model=PreferencesOut)
def get_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = get_preferences(db, user.id)
    db.commit()
    return PreferencesOut.model_validate(p, from_attributes=True)


@router.patch("/me/preferences", response_model=PreferencesOut)
def update_prefs(body: PreferencesUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = get_preferences(db, user.id)
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(p, k, v)
    if "location_consent" in changes:
        p.location_consent_at = datetime.now(UTC) if changes["location_consent"] else None
        record_audit(db, action="consent.location." + ("granted" if changes["location_consent"] else "withdrawn"),
                     entity_type="user", entity_id=user.id, summary="Location consent changed", actor=user)
    if "marketing_opt_in" in changes:
        record_audit(db, action="consent.marketing." + ("granted" if changes["marketing_opt_in"] else "withdrawn"),
                     entity_type="user", entity_id=user.id, summary="Marketing consent changed", actor=user)
    db.commit()
    return PreferencesOut.model_validate(p, from_attributes=True)


class LocationReport(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    simulated: bool = True


@router.post("/me/location")
def report_location(body: LocationReport, db: Session = Depends(get_db), user: User = Depends(require_customer)) -> dict:
    """Evaluate nearby-store offers and list reminders for a consented location report.

    ``simulated`` marks reports from the demo location simulator. Real background geofencing requires
    a native mobile app; this endpoint handles foreground reports only.
    """
    rate_limiter.hit(f"location:{user.id}", 30)
    return geofence_service.report_location(db, user, body.latitude, body.longitude, body.simulated)
