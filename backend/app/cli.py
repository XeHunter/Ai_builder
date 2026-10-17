"""Management commands.

    python -m app.cli migrate            # alembic upgrade head
    python -m app.cli seed [--days N]    # load the demo dataset into an empty database
    python -m app.cli reset [--yes]      # drop everything, migrate, seed (demo environments only)
    python -m app.cli run-jobs           # drain queued background jobs once
    python -m app.cli check              # print configuration summary (no secrets)
"""

from __future__ import annotations

import argparse
import sys
import time

from sqlalchemy import inspect, select, text

from app.core.config import BACKEND_DIR, get_settings
from app.core.logging import configure_logging, get_logger

log = get_logger("cli")


def migrate() -> None:
    from alembic.config import Config

    from alembic import command

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(cfg, "head")
    print("Migrations applied.")


def seed(days: int, scale: float, analytics: bool) -> None:
    from app.db.models import Merchant
    from app.db.session import SessionLocal
    from app.seed.demo import DEMO_PASSWORD, seed_demo

    db = SessionLocal()
    try:
        if db.scalars(select(Merchant.id)).first():
            print("Database already contains data; use `python -m app.cli reset --yes` to start over.")
            return
        t0 = time.time()
        summary = seed_demo(db, days=days, scale=scale, run_analytics=analytics)
        db.commit()
        print(f"Seeded demo data in {time.time() - t0:.1f}s: { {k: v for k, v in summary.items() if k != 'analytics'} }")
        print(f"Demo password for all demo accounts: {DEMO_PASSWORD}")
    finally:
        db.close()


def reset(confirm: bool, days: int, scale: float) -> None:
    s = get_settings()
    if s.app_env == "production":
        sys.exit("Refusing to reset a production database.")
    if not confirm:
        sys.exit("This deletes ALL data. Re-run with --yes to confirm.")
    from app.db.base import Base
    from app.db.session import get_engine

    engine = get_engine()
    with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            conn.execute(text("DROP SCHEMA public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
        else:
            Base.metadata.drop_all(conn)
            if "alembic_version" in inspect(conn).get_table_names():
                conn.execute(text("DROP TABLE alembic_version"))
    print("Database cleared.")
    migrate()
    seed(days, scale, True)


def run_jobs() -> None:
    from app.tasks.queue import run_pending

    print(f"Processed {run_pending(1000)} jobs.")


def check() -> None:
    from app.ai.providers import get_ai_provider

    s = get_settings()
    p = get_ai_provider()
    print(f"env={s.app_env} db={'sqlite' if s.is_sqlite else 'postgresql'} redis={'yes' if s.redis_url else 'no'}")
    print(f"ai_provider={p.name} ({p.kind}) embedding_model={p.embedding_model}")
    print(f"weather={s.weather_provider} key={'set' if s.openweather_api_key else 'not set'} email={s.email_provider}")
    print(f"worker_in_process={s.run_worker_in_process} scheduler={s.enable_scheduler}")


def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    sp = sub.add_parser("seed")
    sp.add_argument("--days", type=int, default=120)
    sp.add_argument("--scale", type=float, default=1.0)
    sp.add_argument("--no-analytics", action="store_true")
    rp = sub.add_parser("reset")
    rp.add_argument("--yes", action="store_true")
    rp.add_argument("--days", type=int, default=120)
    rp.add_argument("--scale", type=float, default=1.0)
    sub.add_parser("run-jobs")
    sub.add_parser("check")
    a = ap.parse_args()
    if a.cmd == "migrate":
        migrate()
    elif a.cmd == "seed":
        seed(a.days, a.scale, not a.no_analytics)
    elif a.cmd == "reset":
        reset(a.yes, a.days, a.scale)
    elif a.cmd == "run-jobs":
        run_jobs()
    elif a.cmd == "check":
        check()


if __name__ == "__main__":
    main()
