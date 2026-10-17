"""Append-only audit log for security- and business-relevant actions."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.logging import request_id_var
from app.db.models import AuditEvent, User


def record_audit(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: str | uuid.UUID | None,
    summary: str,
    actor: User | None = None,
    merchant_id: uuid.UUID | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> AuditEvent:
    """Add an audit event to the current transaction (committed together with the change it describes)."""
    event = AuditEvent(
        merchant_id=merchant_id,
        actor_id=actor.id if actor else None,
        actor_label=f"{actor.full_name} <{actor.email}>" if actor else "system",
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id else None,
        summary=summary,
        before=_jsonable(before),
        after=_jsonable(after),
        request_id=request_id_var.get(),
        ip_address=ip_address,
    )
    db.add(event)
    return event


def _jsonable(d: dict[str, Any] | None) -> dict[str, Any] | None:
    if d is None:
        return None
    out: dict[str, Any] = {}
    for k, v in d.items():
        if isinstance(v, (str, int, float, bool)) or v is None:
            out[k] = v
        elif isinstance(v, (list, dict)):
            out[k] = v
        else:
            out[k] = str(v)
    return out
