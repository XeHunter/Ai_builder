"""Merchant journeys: import, inventory ledger, expiry markdowns, pricing workflow, promotions."""

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select

from app.db.models import AuditEvent, InventoryBatch, InventoryItem, StockAdjustment, StoreTask
from app.services.inventory_service import sample_import_csv


def _upload(client, headers, content: str, key: str | None = None, name: str = "import.csv"):
    h = dict(headers)
    if key:
        h["Idempotency-Key"] = key
    return client.post("/api/v1/merchant/inventory/imports", headers=h, files={"file": (name, content.encode(), "text/csv")})


def test_import_validation_preview_and_commit(client, admin, db, ids):
    r = _upload(client, admin, sample_import_csv(date.today()), key="sample-1")
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "validated" and job["total_rows"] == 13
    assert job["valid_rows"] == 6 and job["error_rows"] == 7
    errors = client.get(f"/api/v1/merchant/inventory/imports/{job['id']}/rows", params={"only": "errors"}, headers=admin).json()
    messages = {(e["field"], e["message"].split(" ")[0]) for row in errors["items"] for e in row["errors"]}
    assert ("stock_quantity", "cannot") in messages
    assert ("expiry_date", "expected") in messages
    assert ("store_id", "unknown") in messages
    assert ("price", "only") in messages
    assert ("min_allowed_price", "cannot") in messages
    assert any("duplicate" in e["message"] for row in errors["items"] for e in row["errors"])
    warnings = client.get(f"/api/v1/merchant/inventory/imports/{job['id']}/rows", params={"only": "warnings"}, headers=admin).json()
    assert any("not found in the active layout" in w["message"] for row in warnings["items"] for w in row["warnings"])
    # idempotent upload
    assert _upload(client, admin, sample_import_csv(date.today()), key="sample-1").json()["id"] == job["id"]

    commit = client.post(f"/api/v1/merchant/inventory/imports/{job['id']}/commit", headers=admin)
    assert commit.status_code == 202
    done = client.get(f"/api/v1/merchant/inventory/imports/{job['id']}", headers=admin).json()
    assert done["status"] == "completed"
    assert done["summary"]["products_created"] == 1 and done["summary"]["batches_created"] >= 3
    # committing again is a no-op
    assert client.post(f"/api/v1/merchant/inventory/imports/{job['id']}/commit", headers=admin).json()["job_id"] is None

    # inventory invariant: on-hand equals sum of batches, for every item
    for item in db.scalars(select(InventoryItem)):
        total = db.scalar(select(func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0))
                          .where(InventoryBatch.inventory_item_id == item.id))
        assert item.quantity_on_hand == total
    # new product visible in the inventory dashboard with its shelf location
    rows = client.get("/api/v1/merchant/inventory", params={"q": "masala chai"}, headers=admin).json()["items"]
    assert rows and rows[0]["shelf_code"] == "A1-R-4-2" and rows[0]["quantity_on_hand"] == 36
    # stock count import set PRC-003 to an absolute 55 units (not additive)
    rows = client.get("/api/v1/merchant/inventory", params={"q": "PRC-003", "store_id": ids["AND01"]}, headers=admin).json()["items"]
    assert rows[0]["quantity_on_hand"] == 55
    assert db.scalar(select(func.count(StockAdjustment.id)).where(StockAdjustment.reference == f"import:{job['id']}")) >= 4


def test_import_rejects_bad_files(client, admin):
    assert _upload(client, admin, "a,b\n1,2\n").status_code == 422
    assert _upload(client, admin, "product_id,store_id,stock_quantity\n", name="x.csv").status_code == 422
    r = client.post("/api/v1/merchant/inventory/imports", headers=admin, files={"file": ("x.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 422
    assert client.get("/api/v1/merchant/inventory/imports/template", headers=admin).text.startswith("product_id,")


def test_xlsx_import(client, admin):
    import io

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["product_id", "store_id", "stock_quantity"])
    ws.append(["PRC-004", "AND01", 33])
    buf = io.BytesIO()
    wb.save(buf)
    r = client.post("/api/v1/merchant/inventory/imports", headers=admin,
                    files={"file": ("stock.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 201 and r.json()["valid_rows"] == 1


def test_stock_adjustment_fefo_and_audit(client, admin, db, ids):
    rows = client.get("/api/v1/merchant/inventory", params={"q": "MLK-002", "store_id": ids["AND01"]}, headers=admin).json()["items"]
    item_id = rows[0]["id"]
    before = client.get(f"/api/v1/merchant/inventory/items/{item_id}", headers=admin).json()
    oldest = min((b for b in before["batches"] if b["quantity_remaining"] > 0), key=lambda b: b["expiry_date"])
    r = client.post(f"/api/v1/merchant/inventory/items/{item_id}/adjust", headers=admin,
                    json={"delta": -2, "reason": "damage", "note": "torn cartons"})
    assert r.status_code == 200
    after = r.json()
    assert after["quantity_on_hand"] == before["quantity_on_hand"] - 2
    b_after = next(b for b in after["batches"] if b["id"] == oldest["id"])
    assert b_after["quantity_remaining"] == oldest["quantity_remaining"] - 2
    assert after["adjustments"][0]["reason"] == "damage"
    too_much = client.post(f"/api/v1/merchant/inventory/items/{item_id}/adjust", headers=admin,
                           json={"delta": -100000, "reason": "damage"})
    assert too_much.status_code == 422
    assert db.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.action == "inventory.adjust")) >= 1


def test_expiry_markdown_recommendation_and_approval(client, admin, db, ids):
    batches = client.get("/api/v1/merchant/expiry/batches", params={"store_id": ids["AND01"], "days": 3}, headers=admin).json()
    milk = next(b for b in batches if b["batch_code"] == "MLK-002-B1")
    assert milk["hours_to_sell_by"] <= 48 and milk["price_change"] is not None
    pc_id = milk["price_change"]["id"]
    pc = client.get(f"/api/v1/merchant/pricing/changes/{pc_id}", headers=admin).json()
    assert pc["status"] == "RECOMMENDED" and pc["proposed_price"] >= pc["floor_price"]
    assert 0 < pc["discount_pct"] <= 30 and pc["evidence"]["method"] == "heuristic_markdown_rule"
    assert pc["clearance_instruction"]
    approved = client.post(f"/api/v1/merchant/pricing/changes/{pc_id}/approve", json={"note": "ok"}, headers=admin).json()
    assert approved["status"] == "PUBLISHED" and approved["publish_reference"].startswith("SIM-ESL-")
    assert [e["to"] for e in approved["events"]] == ["RECOMMENDED", "PENDING_APPROVAL", "APPROVED", "PUBLISHED"]
    batch = db.get(InventoryBatch, __import__("uuid").UUID(approved["batch_id"]))
    db.refresh(batch)
    assert float(batch.markdown_price) == approved["proposed_price"] and batch.in_clearance
    tasks = db.scalars(select(StoreTask).where(StoreTask.related_entity_id == pc_id)).all()
    assert {t.task_type for t in tasks} == {"relabel_price", "move_to_clearance"}
    # the customer catalog now shows the short-dated markdown
    cust = client.post("/api/v1/auth/login", json={"email": "priya@demo.omnipulse.ai", "password": "Demo@12345"}).json()
    client.cookies.clear()
    h = {"Authorization": f"Bearer {cust['access_token']}"}
    card = client.get(f"/api/v1/stores/{ids['AND01']}/products/{ids['p']['MLK-002']}", headers=h).json()["product"]
    assert card["markdown"]["price"] == approved["proposed_price"]
    # invalid transitions are rejected
    assert client.post(f"/api/v1/merchant/pricing/changes/{pc_id}/reject", json={}, headers=admin).status_code == 422
    audit = client.get("/api/v1/merchant/audit-events", params={"entity_id": pc_id}, headers=admin).json()
    assert {"pricing.price_change.published", "pricing.price_change.approved"} <= {e["action"] for e in audit["items"]}


def test_manual_price_change_guardrails_and_publish_failure(client, admin, ids):
    below = client.post("/api/v1/merchant/pricing/changes", headers=admin,
                        json={"store_id": ids["AND01"], "product_id": ids["p"]["TEA-001"], "new_price": 100, "reason": "too low"})
    assert below.status_code == 422 and below.json()["error"]["details"]["violations"]
    client.put("/api/v1/merchant/integrations/pricing_publisher", headers=admin,
               json={"mode": "simulated", "settings": {"fail_skus": ["TEA-002"]}})
    pc = client.post("/api/v1/merchant/pricing/changes", headers=admin,
                     json={"store_id": ids["AND01"], "product_id": ids["p"]["TEA-002"], "new_price": 170, "reason": "align"}).json()
    failed = client.post(f"/api/v1/merchant/pricing/changes/{pc['id']}/approve", json={}, headers=admin).json()
    assert failed["status"] == "FAILED" and "rejected SKU" in failed["failure_reason"]
    client.put("/api/v1/merchant/integrations/pricing_publisher", headers=admin, json={"mode": "simulated", "settings": {"fail_skus": []}})
    ok = client.post(f"/api/v1/merchant/pricing/changes/{pc['id']}/publish", headers=admin).json()
    assert ok["status"] == "PUBLISHED"
    assert client.put("/api/v1/merchant/integrations/weather", headers=admin,
                      json={"mode": "live", "settings": {"api_key": "x"}}).status_code == 422


def test_store_manager_approval_scope(client, manager, ids):
    r = client.get("/api/v1/merchant/pricing/changes", params={"store_id": ids["BAN01"]}, headers=manager)
    assert r.status_code == 403


def test_auto_publish_policy(client, admin, ids, db):
    client.patch("/api/v1/merchant/pricing/policy", headers=admin, json={"auto_publish_markdowns": True, "auto_publish_max_pct": 30})
    res = client.post("/api/v1/merchant/expiry/evaluate", params={"store_id": ids["BAN01"]}, headers=admin).json()
    statuses = [r for r in res["results"] if r.get("price_change_id")]
    for r in statuses:
        pc = client.get(f"/api/v1/merchant/pricing/changes/{r['price_change_id']}", headers=admin).json()
        assert pc["status"] == "PUBLISHED" and pc["approved_by"] == "policy"
    client.patch("/api/v1/merchant/pricing/policy", headers=admin, json={"auto_publish_markdowns": False})


def test_promotion_lifecycle_coupons_and_guardrails(client, admin, customer, ids):
    now = datetime.now(UTC)
    bad = client.post("/api/v1/merchant/promotions", headers=admin, json={
        "name": "Too deep", "product_ids": [ids["p"]["MLK-001"]], "promo_type": "percent_off", "discount_value": 45,
        "starts_at": now.isoformat(), "ends_at": (now + timedelta(days=2)).isoformat()})
    assert bad.status_code == 422 and bad.json()["error"]["details"]["products"][0]["problems"]
    sim = client.post("/api/v1/merchant/promotions/simulate", headers=admin, json={
        "name": "Sim", "product_ids": [ids["p"]["SEA-001"]], "promo_type": "percent_off", "discount_value": 10,
        "starts_at": now.isoformat(), "ends_at": (now + timedelta(days=3)).isoformat()}).json()
    assert sim["valid"] and sim["lines"][0]["breakeven_volume_increase_pct"] > 0
    p = client.post("/api/v1/merchant/promotions", headers=admin, json={
        "name": "Rainy essentials", "product_ids": [ids["p"]["SEA-001"], ids["p"]["SEA-003"]], "promo_type": "percent_off",
        "discount_value": 10, "starts_at": (now - timedelta(minutes=1)).isoformat(),
        "ends_at": (now + timedelta(days=3)).isoformat(), "usage_limit": 1, "store_id": ids["AND01"]}).json()
    assert p["status"] == "draft"
    for action, expected in (("submit", "pending_approval"), ("approve", "active")):
        p = client.post(f"/api/v1/merchant/promotions/{p['id']}/actions", json={"action": action}, headers=admin).json()
        assert p["status"] == expected
    card = client.get(f"/api/v1/stores/{ids['AND01']}/products/{ids['p']['SEA-001']}", headers=customer).json()["product"]
    assert card["promotion"]["price"] < card["price"]
    claim = client.post(f"/api/v1/offers/{p['id']}/claim", headers=customer).json()
    assert claim["new"] and client.post(f"/api/v1/offers/{p['id']}/claim", headers=customer).json()["new"] is False
    redeem = client.post("/api/v1/merchant/coupons/redeem", json={"code": claim["code"]}, headers=admin)
    assert redeem.status_code == 200
    assert client.post("/api/v1/merchant/coupons/redeem", json={"code": claim["code"]}, headers=admin).status_code == 409
    perf = client.get(f"/api/v1/merchant/promotions/{p['id']}", headers=admin).json()["performance"]
    assert perf["redemptions"] == 1 and perf["method"] == "observational_before_after"


def test_weather_opportunities_are_evidence_based(client, admin, ids):
    r = client.get("/api/v1/merchant/pricing/weather-opportunities", params={"store_id": ids["AND01"]}, headers=admin).json()
    assert r["weather_source"] == "simulated" and r["rain_days"]
    umbrella = next(c for c in r["candidates"] if c["sku"] == "SEA-001")
    assert umbrella["checks"]["rain_forecast"] and umbrella["promo_price"] >= umbrella["floor_price"]
    assert "evidence" in umbrella and umbrella["evidence"]["rain_days_observed"] >= 0
