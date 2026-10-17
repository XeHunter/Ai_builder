"""Consent-based proximity offers and shopping reminders.

The browser (or the demo location simulator) reports a location only after the shopper granted
location consent in their preferences. Background geofencing while the app is closed requires a
native mobile app with OS geofencing APIs and push notifications - not part of this web build.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import PermissionDeniedError
from app.db.models import GeofenceEvent, Promotion, ShoppingList, Store, User
from app.services import pricing_service
from app.services.notification_service import get_preferences, notify


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def report_location(db: Session, user: User, lat: float, lon: float, simulated: bool) -> dict:
    pref = get_preferences(db, user.id)
    if not pref.location_consent:
        raise PermissionDeniedError("Location consent is required; enable it in your notification preferences")
    stores = db.scalars(select(Store).where(Store.is_active.is_(True))).all()
    now = datetime.now(UTC)
    results = []
    for st in stores:
        d = haversine_m(lat, lon, st.latitude, st.longitude)
        inside = d <= st.geofence_radius_m
        last = db.scalars(select(GeofenceEvent).where(GeofenceEvent.user_id == user.id, GeofenceEvent.store_id == st.id)
                          .order_by(GeofenceEvent.created_at.desc())).first()
        was_inside = last is not None and last.event_type == "enter"
        if inside == was_inside and not (inside and last and now - last.created_at > timedelta(hours=6)):
            if inside:
                results.append({"store": st.name, "distance_m": round(d), "event": "still_inside", "actions": []})
            continue
        ev = GeofenceEvent(user_id=user.id, store_id=st.id, event_type="enter" if inside else "exit", latitude=lat,
                           longitude=lon, distance_m=d, is_simulated=simulated)
        db.add(ev)
        actions: list[dict] = []
        if inside:
            actions += _offers(db, user, st, d, now)
            actions += _list_reminder(db, user, st, now)
        ev.outcome = {"actions": actions}
        results.append({"store": st.name, "distance_m": round(d), "event": ev.event_type, "actions": actions})
    db.commit()
    return {"simulated": simulated, "evaluated_stores": len(stores), "results": results}


def _offers(db: Session, user: User, store: Store, distance: float, now: datetime) -> list[dict]:
    out = []
    promos = db.scalars(select(Promotion).where(
        Promotion.merchant_id == store.merchant_id, Promotion.status == "active", Promotion.is_simulation.is_(False),
        Promotion.geofence_radius_m.is_not(None), Promotion.starts_at <= now, Promotion.ends_at > now,
        (Promotion.store_id.is_(None)) | (Promotion.store_id == store.id))).all()
    for p in promos:
        if distance > p.geofence_radius_m:
            continue
        try:
            coupon, new = pricing_service.issue_coupon(db, p, user.id, via="geofence")
        except Exception as exc:
            out.append({"type": "offer", "promotion": p.name, "outcome": f"not_issued: {exc}"})
            continue
        if not new:
            out.append({"type": "offer", "promotion": p.name, "outcome": "already_issued", "coupon": coupon.code})
            continue
        _, outcome = notify(db, user_id=user.id, notification_type="nearby_offer",
                            title=f"Nearby offer at {store.name}: {p.name}",
                            body=f"{p.description or p.name}. Use code {coupon.code} before {p.ends_at:%d %b %H:%M}.",
                            idempotency_key=f"geo-offer:{p.id}:{user.id}", link="/shop/offers",
                            data={"coupon": coupon.code, "promotion_id": str(p.id)}, merchant_id=store.merchant_id)
        out.append({"type": "offer", "promotion": p.name, "coupon": coupon.code, "notification": outcome})
    return out


def _list_reminder(db: Session, user: User, store: Store, now: datetime) -> list[dict]:
    pref = get_preferences(db, user.id)
    if not pref.abandoned_list_reminders:
        return []
    lists = db.scalars(select(ShoppingList).where(ShoppingList.owner_id == user.id, ShoppingList.store_id == store.id,
                                                  ShoppingList.status == "active")).all()
    out = []
    for sl in lists:
        pending = [i for i in sl.items if i.status == "pending"]
        if not pending or now - sl.updated_at < timedelta(hours=12):
            continue
        _, outcome = notify(db, user_id=user.id, notification_type="shopping_reminder",
                            title=f"You're near {store.name}",
                            body=f"Your list '{sl.name}' still has {len(pending)} items to pick up.",
                            idempotency_key=f"list-reminder:{sl.id}:{now:%Y%m%d}", link=f"/shop/lists/{sl.id}",
                            merchant_id=store.merchant_id)
        out.append({"type": "list_reminder", "list": sl.name, "pending_items": len(pending), "notification": outcome})
    return out
