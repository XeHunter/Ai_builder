"""Nightly demo reset: wipe the demo database and reseed it with dates relative to today.

The demo dataset is date-relative (batches expiring in 48 h, a rain forecast for the next two days,
recent sales), so a long-running demo instance drifts out of date. A scheduler calls
``POST /api/v1/demo/reset`` with a shared secret to rebuild it. Only allowed for demo deployments
(``DEMO_MODE`` and ``DEMO_RESET_TOKEN`` both set).
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import inspect, text

from app.core.config import BACKEND_DIR
from app.core.exceptions import ConflictError
from app.core.logging import get_logger

log = get_logger(__name__)
_lock = threading.Lock()
# Seed size for a reset; the test-suite lowers it.
SEED_KWARGS: dict = {}
IST = ZoneInfo("Asia/Kolkata")
_seeded_on: date | None = None


def today_ist() -> date:
    return datetime.now(IST).date()


def mark_seeded() -> None:
    """Record that the demo data was (re)built today, e.g. by the startup seed of a fresh instance."""
    global _seeded_on
    _seeded_on = today_ist()


def reset_demo_data(force: bool = False) -> dict:
    """Rebuild the demo data. Skipped when it was already built today (a freshly started instance has
    just seeded it), unless ``force``; this keeps a cold start + reset inside the request timeout."""
    if not force and _seeded_on == today_ist():
        return {"status": "already_fresh", "seeded_on": _seeded_on.isoformat()}
    if not _lock.acquire(blocking=False):
        raise ConflictError("A demo reset is already running")
    try:
        from alembic.config import Config

        from alembic import command
        from app.db.base import Base
        from app.db.session import SessionLocal, get_engine
        from app.seed.demo import seed_demo

        t0 = time.time()
        engine = get_engine()
        with engine.begin() as conn:
            if engine.dialect.name == "postgresql":
                conn.execute(text("DROP SCHEMA public CASCADE"))
                conn.execute(text("CREATE SCHEMA public"))
            else:
                Base.metadata.drop_all(conn)
                if "alembic_version" in inspect(conn).get_table_names():
                    conn.execute(text("DROP TABLE alembic_version"))
        cfg = Config(str(BACKEND_DIR / "alembic.ini"))
        cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
        cfg.attributes["database_url"] = engine.url.render_as_string(hide_password=False)
        command.upgrade(cfg, "head")

        db = SessionLocal()
        try:
            summary = seed_demo(db, **SEED_KWARGS)
            db.commit()
        finally:
            db.close()
        _clear_caches()
        mark_seeded()
        took = round(time.time() - t0, 1)
        log.info("Demo data reset in %.1fs", took)
        return {"status": "reset", "seconds": took,
                **{k: v for k, v in summary.items() if k in ("merchants", "stores", "products", "transactions")}}
    finally:
        _lock.release()


def _clear_caches() -> None:
    from app.services import brief_service, catalog_service

    catalog_service._index_cache.clear()
    brief_service.clear_cache()
