"""Notification creation with consent, preference, cooldown and idempotency controls."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.db.models import MerchantMembership, Notification, NotificationPreference, User
from app.integrations.notifications.adapters import get_adapter

log = get_logger(__name__)

# Types that are marketing/proximity messages: require opt-in and respect the cooldown.
MARKETING_TYPES = {"nearby_offer", "promotion", "shopping_reminder"}


def get_preferences(db: Session, user_id: uuid.UUID) -> NotificationPreference:
    pref = db.get(NotificationPreference, user_id)
    if pref is None:
        pref = NotificationPreference(user_id=user_id)
        db.add(pref)
        db.flush()
    return pref


def notify(
    db: Session,
    *,
    user_id: uuid.UUID,
    notification_type: str,
    title: str,
    body: str,
    idempotency_key: str,
    link: str | None = None,
    data: dict | None = None,
    merchant_id: uuid.UUID | None = None,
) -> tuple[Notification | None, str]:
    """Create an in-app notification (and fan out to opted-in external channels).

    Returns (notification, outcome) where outcome is created|duplicate|opted_out|cooldown.
    Does not commit; the caller's transaction owns the write.
    """
    existing = db.scalars(select(Notification).where(Notification.idempotency_key == idempotency_key)).first()
    if existing:
        return existing, "duplicate"
    pref = get_preferences(db, user_id)
    if not pref.in_app_enabled:
        return None, "opted_out"
    if notification_type in MARKETING_TYPES:
        if not pref.marketing_opt_in:
            return None, "opted_out"
        since = datetime.now(UTC) - timedelta(minutes=pref.cooldown_minutes)
        recent = db.scalar(
            select(func.count(Notification.id)).where(
                Notification.user_id == user_id,
                Notification.notification_type == notification_type,
                Notification.created_at >= since,
            )
        )
        if recent:
            return None, "cooldown"
    n = Notification(user_id=user_id, merchant_id=merchant_id, notification_type=notification_type, title=title,
                     body=body, link=link, data=data or {}, idempotency_key=idempotency_key)
    try:
        with db.begin_nested():
            db.add(n)
    except IntegrityError:
        return db.scalars(select(Notification).where(Notification.idempotency_key == idempotency_key)).first(), "duplicate"

    user = db.get(User, user_id)
    for channel, enabled in (("email", pref.email_enabled), ("sms", pref.sms_enabled), ("push", pref.push_enabled)):
        if enabled and user is not None:
            try:
                get_adapter(channel).send(user.email if channel == "email" else str(user.id), title, body)
            except Exception as exc:  # external channel failure never blocks the in-app notification
                log.warning("Channel %s delivery failed: %s", channel, exc)
    return n, "created"


def notify_merchant_staff(
    db: Session,
    merchant_id: uuid.UUID,
    permission: str,
    *,
    notification_type: str,
    title: str,
    body: str,
    idempotency_key: str,
    link: str | None = None,
    data: dict | None = None,
) -> int:
    members = db.scalars(
        select(MerchantMembership).where(MerchantMembership.merchant_id == merchant_id,
                                         MerchantMembership.is_active.is_(True))
    ).all()
    count = 0
    for m in members:
        if permission not in {p.code for p in m.role.permissions}:
            continue
        _, outcome = notify(db, user_id=m.user_id, notification_type=notification_type, title=title, body=body,
                            idempotency_key=f"{idempotency_key}:{m.user_id}", link=link, data=data,
                            merchant_id=merchant_id)
        count += outcome == "created"
    return count
