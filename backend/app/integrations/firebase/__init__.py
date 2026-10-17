"""Firebase / Firestore boundary.

PostgreSQL (or SQLite) stays the source of truth. Firestore is a *real-time delivery* layer that
browsers subscribe to directly, which is what lets the SPA run on Firebase Hosting + Cloud Run
(Hosting cannot proxy WebSockets):

* ``shoppingLists/{listId}``                  - ``members`` (Firebase uids) used by security rules
* ``shoppingLists/{listId}/events/{seq}``     - every list event, same shape as the WebSocket ``event``
* ``merchants/{merchantId}/feed/{autoId}``    - merchant live feed (orders, low stock, publications)

Firebase uids are our user UUIDs; the API mints custom tokens carrying ``merchant_id`` for staff.
Writes happen on a single background thread (ordered, never blocking a request). When Firebase is
disabled every call is a no-op, so local development and the test-suite need no credentials.
"""

from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)


class FirebaseBridge:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._app = None
        self._db = None
        self._failed = False
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="firestore")

    @property
    def enabled(self) -> bool:
        return get_settings().firebase_enabled and not self._failed

    def available(self) -> bool:
        """Enabled *and* initialised (credentials and project resolved)."""
        return self._init()

    def _init(self) -> bool:
        if not self.enabled:
            return False
        if self._db is not None:
            return True
        with self._lock:
            if self._db is not None:
                return True
            try:
                import firebase_admin
                from firebase_admin import firestore

                s = get_settings()
                opts = {"projectId": s.firebase_project_id} if s.firebase_project_id else None
                try:
                    self._app = firebase_admin.get_app()
                except ValueError:
                    self._app = firebase_admin.initialize_app(options=opts)
                self._db = firestore.client(self._app)
                log.info("Firebase bridge ready (project=%s)", self._app.project_id)
                return True
            except Exception as exc:  # pragma: no cover - environment dependent
                log.error("Firebase disabled: initialisation failed (%s)", exc)
                self._failed = True
                return False

    # ------------------------------------------------------------------ auth
    def custom_token(self, user_id: uuid.UUID, claims: dict[str, Any]) -> str | None:
        if not self._init():
            return None
        from firebase_admin import auth

        token = auth.create_custom_token(str(user_id), claims, app=self._app)
        return token.decode() if isinstance(token, bytes) else token

    # ------------------------------------------------------------------ writes
    def _submit(self, fn, *args) -> None:
        if not self._init():
            return

        def run() -> None:
            try:
                fn(*args)
            except Exception as exc:  # pragma: no cover - network dependent
                log.warning("Firestore write failed: %s", exc)

        self._executor.submit(run)

    def list_event(self, list_id: uuid.UUID, message: dict) -> None:
        """Mirror a hub message for a shared list (``event`` or ``list_deleted``)."""
        self._submit(self._write_list_event, list_id, message)

    def _write_list_event(self, list_id: uuid.UUID, message: dict) -> None:
        from sqlalchemy import select

        from app.db.models import ListMembership
        from app.db.session import SessionLocal

        doc = self._db.collection("shoppingLists").document(str(list_id))
        if message.get("type") == "list_deleted":
            doc.set({"deleted": True, "updatedAt": datetime.now(UTC)}, merge=True)
            return
        with SessionLocal() as db:
            member_ids = [str(u) for u in db.scalars(select(ListMembership.user_id).where(ListMembership.list_id == list_id))]
        ev = message.get("event")
        state: dict = {"members": member_ids, "updatedAt": datetime.now(UTC)}
        if ev:
            state["version"] = ev["seq"]
        doc.set(state, merge=True)
        if ev:
            doc.collection("events").document(f"{ev['seq']:010d}").set(ev)

    def ensure_list(self, list_id: uuid.UUID) -> bool:
        """Synchronously write the list's member set so a new subscriber passes the security rules."""
        if not self._init():
            return False
        self._executor.submit(self._write_list_event, list_id, {"type": "sync"}).result(timeout=10)
        return True

    def merchant_feed(self, merchant_id: uuid.UUID, entry: dict) -> None:
        """Append to the merchant's live operations feed (orders, low stock, price publications...)."""
        payload = {**entry, "createdAt": datetime.now(UTC)}
        self._submit(self._write_feed, str(merchant_id), payload)

    def _write_feed(self, merchant_id: str, payload: dict) -> None:
        self._db.collection("merchants").document(merchant_id).collection("feed").add(payload)

    def flush(self, timeout: float = 5.0) -> None:
        """Wait for queued writes (tests / shutdown)."""
        self._executor.submit(lambda: None).result(timeout=timeout)


firebase = FirebaseBridge()
