"""FastAPI application factory."""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.ai.providers import get_ai_provider
from app.api.router import api_router
from app.core.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging, get_logger, request_id_var
from app.db.session import get_engine

log = get_logger("app")


def _seed_if_empty() -> None:
    """Demo deployments (Cloud Run + in-container SQLite): migrate and load the demo dataset on boot."""
    from sqlalchemy import select

    from app.cli import migrate
    from app.db.models import Merchant
    from app.db.session import SessionLocal

    migrate()
    db = SessionLocal()
    try:
        if db.scalars(select(Merchant.id)).first() is None:
            from app.seed.demo import seed_demo

            t0 = time.time()
            seed_demo(db)
            db.commit()
            log.info("Demo dataset seeded on startup in %.1fs", time.time() - t0)
        from app.services.demo_service import mark_seeded

        mark_seeded()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    s.validate_production()
    s.media_dir.mkdir(parents=True, exist_ok=True)
    if s.seed_on_startup and s.app_env != "test":
        _seed_if_empty()
    worker = None
    if s.run_worker_in_process and s.app_env != "test":
        from app.tasks.worker import Worker

        worker = Worker()
        worker.start_background()
    log.info("OmniPulse API started (env=%s, ai=%s, db=%s)", s.app_env, get_ai_provider().name,
             "sqlite" if s.is_sqlite else "postgresql")
    yield
    if worker:
        worker.stop()


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    app = FastAPI(
        title="OmniPulse AI API",
        version="0.1.0",
        description="Omnichannel retail intelligence platform. All endpoints are under /api/v1. "
                    "Authenticate with POST /api/v1/auth/login (cookie) or a Bearer token.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Merchant-Id", "X-Request-Id"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-Id"] = rid
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        elapsed = (time.perf_counter() - start) * 1000
        if elapsed > 1500:
            log.warning("Slow request %s %s %.0f ms", request.method, request.url.path, elapsed)
        return response

    register_exception_handlers(app)
    app.include_router(api_router)
    s.media_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=str(s.media_dir)), name="media")

    @app.get("/health/live", tags=["health"])
    def live() -> dict:
        return {"status": "ok"}

    @app.get("/health/ready", tags=["health"])
    def ready() -> dict:
        checks: dict = {}
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
            checks["database"] = "ok"
        except Exception as exc:  # pragma: no cover
            checks["database"] = f"error: {exc.__class__.__name__}"
        if s.redis_url:
            try:
                import redis

                redis.Redis.from_url(s.redis_url, socket_timeout=0.5).ping()
                checks["redis"] = "ok"
            except Exception as exc:  # pragma: no cover
                checks["redis"] = f"unavailable: {exc.__class__.__name__}"
        else:
            checks["redis"] = "not_configured"
        p = get_ai_provider()
        checks["ai_provider"] = f"{p.name} ({p.kind})"
        checks["status"] = "ok" if checks["database"] == "ok" else "degraded"
        return checks

    return app


app = create_app()
