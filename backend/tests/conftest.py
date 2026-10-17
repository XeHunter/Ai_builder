"""Test fixtures.

A compact demo dataset is seeded once per session into a template SQLite file; each test module
gets its own copy so modules cannot interfere with each other. Set TEST_DATABASE_URL to a
PostgreSQL URL to run the suite against PostgreSQL instead (slower: reseeded per module).
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="omnipulse-tests-"))
os.environ.update({
    "APP_ENV": "test",
    "JOBS_EAGER": "true",
    "RUN_WORKER_IN_PROCESS": "false",
    "ENABLE_SCHEDULER": "false",
    "AI_PROVIDER": "demo",
    "WEATHER_PROVIDER": "simulated",
    "LOGIN_RATE_LIMIT_PER_MINUTE": "1000",
    "MEDIA_DIR": str(_TMP / "media"),
    "LOG_LEVEL": "WARNING",
    "DATABASE_URL": f"sqlite:///{(_TMP / 'unused.db').as_posix()}",
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.ai.providers import get_ai_provider  # noqa: E402
from app.core.rate_limit import rate_limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.models import Merchant, Product, Store, User  # noqa: E402
from app.db.session import SessionLocal, configure_engine  # noqa: E402
from app.services import catalog_service  # noqa: E402

PASSWORD = "Demo@12345"
TEMPLATE = _TMP / "template.db"
PG_URL = os.environ.get("TEST_DATABASE_URL")


def _seed_into(url: str) -> None:
    from app.seed.demo import seed_demo

    engine = configure_engine(url)
    if engine.dialect.name == "postgresql":
        from sqlalchemy import text

        with engine.begin() as c:
            c.execute(text("DROP SCHEMA public CASCADE"))
            c.execute(text("CREATE SCHEMA public"))
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        seed_demo(db, days=45, scale=0.35, with_images=True, run_analytics=True)
        db.commit()
    finally:
        db.close()


@pytest.fixture(scope="session")
def template_db() -> Path:
    if not PG_URL:
        _seed_into(f"sqlite:///{TEMPLATE.as_posix()}")
        configure_engine(f"sqlite:///{(_TMP / 'unused.db').as_posix()}").dispose()
    return TEMPLATE


@pytest.fixture(scope="module")
def db_url(template_db: Path, request) -> str:
    if PG_URL:
        _seed_into(PG_URL)
        return PG_URL
    path = _TMP / f"{request.module.__name__.split('.')[-1]}.db"
    shutil.copy(template_db, path)
    url = f"sqlite:///{path.as_posix()}"
    configure_engine(url)
    return url


@pytest.fixture(scope="module")
def client(db_url: str):
    from app.main import create_app

    catalog_service._index_cache.clear()
    get_ai_provider.cache_clear()
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture()
def db(db_url: str):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    rate_limiter.reset()
    yield


def login(client: TestClient, email: str, password: str = PASSWORD) -> dict:
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    client.cookies.clear()  # tests authenticate explicitly with the bearer header
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def customer(client) -> dict:
    return login(client, "priya@demo.omnipulse.ai")


@pytest.fixture(scope="module")
def customer2(client) -> dict:
    return login(client, "rohan@demo.omnipulse.ai")


@pytest.fixture(scope="module")
def admin(client) -> dict:
    return login(client, "admin@freshmart.demo")


@pytest.fixture(scope="module")
def manager(client) -> dict:
    return login(client, "manager.andheri@freshmart.demo")


@pytest.fixture(scope="module")
def analyst(client) -> dict:
    return login(client, "analyst@freshmart.demo")


@pytest.fixture(scope="module")
def other_admin(client) -> dict:
    return login(client, "admin@urbanbasket.demo")


@pytest.fixture(scope="module")
def ids(db_url: str) -> dict:
    s = SessionLocal()
    try:
        stores = {st.code: st for st in s.scalars(select(Store))}
        fm = s.scalars(select(Merchant).where(Merchant.slug == "freshmart")).first()
        ub = s.scalars(select(Merchant).where(Merchant.slug == "urbanbasket")).first()
        prods = {p.sku: str(p.id) for p in s.scalars(select(Product).where(Product.merchant_id == fm.id))}
        ub_prods = {p.sku: str(p.id) for p in s.scalars(select(Product).where(Product.merchant_id == ub.id))}
        users = {u.email: str(u.id) for u in s.scalars(select(User))}
        return {"AND01": str(stores["AND01"].id), "BAN01": str(stores["BAN01"].id), "KOR01": str(stores["KOR01"].id),
                "fm": str(fm.id), "ub": str(ub.id), "p": prods, "ub_p": ub_prods, "users": users}
    finally:
        s.close()
