"""Nightly demo reset endpoint (kept in its own module: it rebuilds this module's database)."""

from sqlalchemy import func, select

from app.db.models import Merchant, SalesTransaction

API = "/api/v1"


def test_demo_reset_is_disabled_without_a_token(client):
    assert client.post(f"{API}/demo/reset", headers={"X-Reset-Token": "anything"}).status_code == 404


def test_demo_reset_rebuilds_the_demo(client, admin, db, monkeypatch):
    from app.core.config import get_settings
    from app.services import demo_service

    monkeypatch.setattr(get_settings(), "demo_reset_token", "s3cret-token")
    monkeypatch.setattr(demo_service, "SEED_KWARGS", {"days": 30, "scale": 0.2, "run_analytics": False})

    # something a judge did during the day
    assert client.post(f"{API}/merchant/channels/simulate", headers=admin,
                       json={"store_id": _store(client, admin)}).status_code == 201
    assert client.post(f"{API}/demo/reset", headers={"X-Reset-Token": "wrong"}).status_code == 403

    r = client.post(f"{API}/demo/reset", headers={"X-Reset-Token": "s3cret-token"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "reset" and r.json()["merchants"] == 2

    db.expire_all()
    assert db.scalar(select(func.count(Merchant.id))) == 2
    assert db.scalar(select(func.count(SalesTransaction.id))) > 100
    # the old session was wiped with the data; demo sign-in works on the fresh dataset
    assert client.post(f"{API}/auth/demo-login", json={"persona": "owner"}).status_code == 200


def _store(client, headers) -> str:
    return client.get(f"{API}/merchant/stores", headers=headers).json()[0]["id"]
