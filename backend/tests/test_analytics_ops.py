"""Forecasting, affinity, merchandising/layout, fraud, notifications/geofence, dashboard, jobs, migrations."""

import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, inspect, select

from app.db.models import InventoryItem, Product, Store
from app.tasks import queue


def test_forecast_run_job_and_results(client, admin, ids):
    r = client.post("/api/v1/merchant/forecasts", json={"store_id": ids["AND01"], "horizon_days": 7}, headers=admin)
    assert r.status_code == 202
    run = client.get(f"/api/v1/merchant/forecasts/{r.json()['id']}", headers=admin).json()
    assert run["status"] == "succeeded" and run["weather_source"] == "simulated"
    assert set(run["metrics"]["mean_mae_by_model"]) >= {"seasonal_naive"}
    risk_order = [p["stockout_risk"] for p in run["products"]]
    order = {"high": 0, "medium": 1, "low": 2, "none": 3}
    assert risk_order == sorted(risk_order, key=order.get)
    p = next(x for x in run["products"] if x["sku"] == "SEA-001")
    series = client.get(f"/api/v1/merchant/forecasts/{run['id']}/products/{p['product_id']}", headers=admin).json()
    assert len(series["forecast"]) == 7 and series["actual"]
    assert all(f["lower"] <= f["predicted"] <= f["upper"] for f in series["forecast"])
    assert p["mae"] is not None and p["baseline_mae"] is not None


def test_affinity_run_rules_heatmap_and_graph(client, admin, ids):
    r = client.post("/api/v1/merchant/affinity/runs", json={"store_id": ids["AND01"], "min_pair_count": 8, "min_support": 0.002}, headers=admin)
    run = client.get(f"/api/v1/merchant/affinity/runs/{r.json()['id']}", headers=admin).json()
    assert run["status"] == "succeeded" and run["transactions_analyzed"] >= 200
    pairs = {(x["antecedent"], x["consequent"]) for x in run["rules"]}
    assert any("Camera" in a and "Memory Card" in c for a, c in pairs)
    for x in run["rules"]:
        assert x["lift"] == pytest.approx(x["confidence"] / x["consequent_support"], rel=0.02)
    heat = client.get(f"/api/v1/merchant/affinity/runs/{run['id']}/heatmap", headers=admin).json()
    n = len(heat["categories"])
    assert n > 3 and all(heat["lift"][i][j] == heat["lift"][j][i] for i in range(n) for j in range(n))
    graph = client.get(f"/api/v1/merchant/affinity/runs/{run['id']}/graph", headers=admin).json()
    assert graph["edges"] and {e["source"] for e in graph["edges"]} <= {nd["id"] for nd in graph["nodes"]}


def test_affinity_insufficient_data_fails_cleanly(client, other_admin):
    r = client.post("/api/v1/merchant/affinity/runs", json={"window_days": 7, "min_pair_count": 5}, headers=other_admin).json()
    run = client.get(f"/api/v1/merchant/affinity/runs/{r['id']}", headers=other_admin).json()
    assert run["status"] in ("succeeded", "failed")
    if run["status"] == "failed":
        assert "baskets analysed" in run["error"]


def test_merchandising_recommendations_and_planogram(client, admin, ids):
    recs = client.get("/api/v1/merchant/merchandising/recommendations", params={"store_id": ids["AND01"]}, headers=admin).json()
    types = {r["rec_type"] for r in recs}
    assert "safety_relocation" in types and "adjacency_test" in types
    adj = next(r for r in recs if r["rec_type"] == "adjacency_test")
    assert adj["evidence"]["lift"] > 1 and adj["ab_test_plan"]["baskets_needed_per_arm"] > 0
    assert "hypothesis" in adj["rationale"]
    safety = next(r for r in recs if r["rec_type"] == "safety_relocation")
    assert safety["proposed_location"]["level"] <= 2
    applied = client.post(f"/api/v1/merchant/merchandising/recommendations/{safety['id']}/apply-to-draft", headers=admin)
    assert applied.status_code == 200
    draft_id = applied.json()["draft_layout_id"]
    diff = client.get(f"/api/v1/merchant/layouts/{draft_id}/diff", headers=admin).json()
    assert any(c["name"].startswith("Aashirvaad") for c in diff["changes"])
    # constraints: heavy item above 100 cm is blocked; chilled product needs a chiller
    blocked = client.post(f"/api/v1/merchant/layouts/{draft_id}/placements", headers=admin,
                          json={"product_id": ids["p"]["STP-001"], "shelf_code": "A3-L-3-5"})
    assert blocked.status_code == 422 and blocked.json()["error"]["details"]["violations"][0]["code"] == "unsafe_height"
    cold = client.post(f"/api/v1/merchant/layouts/{draft_id}/placements", headers=admin,
                       json={"product_id": ids["p"]["MLK-001"], "shelf_code": "A2-L-4-3"})
    assert cold.json()["error"]["details"]["violations"][0]["code"] == "needs_refrigeration"
    # fixtures: endcap can't be dropped onto a walkway, but can move within free floor
    detail = client.get(f"/api/v1/merchant/layouts/{draft_id}", headers=admin).json()
    clr = next(f for f in detail["fixtures"] if f["code"] == "CLR")
    assert client.patch(f"/api/v1/merchant/layouts/{draft_id}/fixtures/{clr['id']}", json={"x": 10, "y": 21.5}, headers=admin).status_code == 422
    assert client.patch(f"/api/v1/merchant/layouts/{draft_id}/fixtures/{clr['id']}", json={"x": 13.0, "y": 25.0}, headers=admin).status_code == 200
    # active layout cannot be edited, only drafts
    active = next(lay for lay in client.get(f"/api/v1/merchant/stores/{ids['AND01']}/layouts", headers=admin).json() if lay["status"] == "active")
    assert client.post(f"/api/v1/merchant/layouts/{active['id']}/placements", headers=admin,
                       json={"product_id": ids["p"]["SNK-001"], "shelf_code": "A2-R-1-4"}).status_code == 422
    pub = client.post(f"/api/v1/merchant/layouts/{draft_id}/publish", headers=admin).json()
    assert pub["status"] == "active"
    # customer navigation uses the new layout location
    cust = client.post("/api/v1/auth/login", json={"email": "rohan@demo.omnipulse.ai", "password": "Demo@12345"}).json()
    client.cookies.clear()
    card = client.get(f"/api/v1/stores/{ids['AND01']}/products/{ids['p']['STP-002']}",
                      headers={"Authorization": f"Bearer {cust['access_token']}"}).json()["product"]
    assert card["location"]["level"] <= 2
    implemented = client.post(f"/api/v1/merchant/merchandising/recommendations/{safety['id']}/review",
                              json={"status": "implemented"}, headers=admin).json()
    assert implemented["status"] == "implemented"
    out = client.get(f"/api/v1/merchant/merchandising/recommendations/{safety['id']}", headers=admin).json()
    assert out["live_outcome"]["method"] == "observational_before_after"


def test_fraud_queue_investigation_and_evaluation(client, admin, ids):
    q = client.get("/api/v1/merchant/fraud/alerts", params={"status": "open"}, headers=admin).json()
    codes = {s["code"] for a in q["items"] for s in a["signals"]}
    assert {"duplicate_receipt", "receipt_mismatch", "checkout_discrepancy", "refund_frequency"} <= codes
    dup = next(a for a in q["items"] if any(s["code"] == "duplicate_receipt" for s in a["signals"]))
    detail = client.get(f"/api/v1/merchant/fraud/alerts/{dup['id']}", headers=admin).json()
    assert detail["original_transaction"] and "human review" in detail["guidance"]
    assert client.post(f"/api/v1/merchant/fraud/alerts/{dup['id']}/close", json={"outcome": "confirmed_fraud", "note": "x"},
                       headers=admin).status_code == 422
    client.post(f"/api/v1/merchant/fraud/alerts/{dup['id']}/notes", json={"note": "Checked both refunds at the desk."}, headers=admin)
    closed = client.post(f"/api/v1/merchant/fraud/alerts/{dup['id']}/close",
                         json={"outcome": "confirmed_fraud", "note": "Second refund of the same receipt confirmed."}, headers=admin).json()
    assert closed["status"] == "closed" and len(closed["investigation"]["notes"]) == 2
    ev = client.get("/api/v1/merchant/fraud/evaluation", headers=admin).json()
    assert ev["recall"] and ev["recall"] >= 0.8 and ev["precision"] >= 0.5 and ev["reviewed_alerts"] == 1


def test_fraud_ingestion_scores_new_transaction(client, admin, ids):
    r = client.post("/api/v1/merchant/fraud/transactions", headers=admin, json={
        "store_id": ids["AND01"], "channel": "self_checkout", "transaction_type": "sale",
        "items": [{"product_id": ids["p"]["CHO-004"], "quantity": 1, "detected_quantity": 4},
                  {"product_id": ids["p"]["ELE-004"], "quantity": 1, "detected_quantity": 3}]})
    assert r.status_code == 201
    alert = r.json()["alert"]
    assert alert and any(s["code"] == "checkout_discrepancy" for s in alert["signals"])


def test_notifications_and_geofence_consent(client, customer, ids, db):
    st = db.get(Store, uuid.UUID(ids["AND01"]))
    near = {"latitude": st.latitude + 0.002, "longitude": st.longitude, "simulated": True}
    client.patch("/api/v1/me/preferences", json={"location_consent": False}, headers=customer)
    assert client.post("/api/v1/me/location", json=near, headers=customer).status_code == 403
    client.patch("/api/v1/me/preferences", json={"location_consent": True, "marketing_opt_in": True}, headers=customer)
    client.post("/api/v1/me/location", json={"latitude": 28.6, "longitude": 77.2, "simulated": True}, headers=customer)
    res = client.post("/api/v1/me/location", json=near, headers=customer).json()
    entered = next(x for x in res["results"] if x["store"] == st.name)
    offer = next(a for a in entered["actions"] if a["type"] == "offer")
    assert offer["coupon"].startswith("OP-") and offer["notification"] == "created"
    again = client.post("/api/v1/me/location", json=near, headers=customer).json()
    assert next(x for x in again["results"] if x["store"] == st.name)["event"] == "still_inside"
    notes = client.get("/api/v1/notifications", headers=customer).json()
    assert notes["unread"] >= 1 and any(n["type"] == "nearby_offer" for n in notes["items"])
    assert client.post("/api/v1/notifications/read-all", headers=customer).json()["updated"] >= 1


def test_dashboard_metrics_match_database(client, admin, db, ids):
    o = client.get("/api/v1/merchant/overview", params={"store_id": ids["AND01"], "days": 30}, headers=admin).json()
    k = o["kpis"]
    expected_units = db.scalar(select(func.sum(InventoryItem.quantity_on_hand)).where(InventoryItem.store_id == uuid.UUID(ids["AND01"])))
    assert k["total_stock_units"] == expected_units
    assert k["total_products"] == db.scalar(select(func.count(Product.id)).where(Product.merchant_id == uuid.UUID(ids["fm"]), Product.status == "active"))
    assert o["is_demo_data"] is True and o["sales_trend"] and k["transactions"] > 0
    assert sum(d["transactions"] for d in o["sales_trend"]) <= k["transactions"]
    ins = client.get("/api/v1/merchant/insights", headers=admin).json()
    assert ins["traffic_heatmap"] and any(g["query"] == "quinoa" for g in ins["catalog_gaps"])


def test_job_queue_dedupe_and_failure(db, monkeypatch):
    j1 = queue.enqueue(db, "promotion_lifecycle", {}, dedupe_key="test-dedupe")
    j2 = queue.enqueue(db, "promotion_lifecycle", {}, dedupe_key="test-dedupe")
    assert j1.id == j2.id and j1.status == "succeeded"

    @queue.job_handler("always_fails")
    def _boom(db_, job):
        raise RuntimeError("boom")

    j = queue.enqueue(db, "always_fails", {})
    db.refresh(j)
    assert j.status == "failed" and "boom" in j.error


def test_scheduler_is_idempotent(db_url, monkeypatch):
    from app.tasks import worker

    monkeypatch.setattr(worker, "SCHEDULE", {"promotion_lifecycle": 3600})
    first = worker.schedule_due_jobs()
    second = worker.schedule_due_jobs()
    assert first >= 1 and second == 0


def test_health_endpoints(client):
    assert client.get("/health/live").json()["status"] == "ok"
    ready = client.get("/health/ready").json()
    assert ready["database"] == "ok" and ready["ai_provider"].startswith("demo")


def test_alembic_migrations_match_models(tmp_path: Path):
    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.migration import MigrationContext

    from alembic import command
    from app.core.config import BACKEND_DIR
    from app.db.base import Base

    url = f"sqlite:///{(tmp_path / 'mig.db').as_posix()}"
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "head")
    engine = create_engine(url)
    with engine.connect() as conn:
        assert "products" in inspect(conn).get_table_names()
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == [], diff
    command.downgrade(cfg, "base")
    with engine.connect() as conn:
        assert "products" not in inspect(conn).get_table_names()


