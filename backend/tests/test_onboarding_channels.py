"""Plug-and-play journeys: demo sign-in, store-owner onboarding, connectors and omnichannel orders."""

import uuid

from sqlalchemy import func, select

from app.db.models import InventoryBatch, InventoryItem, Product, SalesTransaction, ShelfLocation, Store

API = "/api/v1"


def _bearer(r) -> dict:
    assert r.status_code in (200, 201), r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_one_click_demo_login(client):
    assert client.get(f"{API}/auth/demo-personas").json()["enabled"] is True
    r = client.post(f"{API}/auth/demo-login", json={"persona": "customer"})
    assert r.status_code == 200 and r.json()["user"]["email"] == "priya@demo.omnipulse.ai"
    owner = client.post(f"{API}/auth/demo-login", json={"persona": "owner"})
    assert owner.json()["merchant"]["role"] == "merchant_admin"
    assert client.post(f"{API}/auth/demo-login", json={"persona": "root"}).status_code == 422
    client.cookies.clear()


def test_demo_login_can_be_disabled(client, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "demo_login_enabled", False)
    assert client.post(f"{API}/auth/demo-login", json={"persona": "owner"}).status_code == 403


def test_default_layout_spec_matches_seeded_plan(db, ids):
    from app.services.catalog_service import active_layout

    layout = active_layout(db, uuid.UUID(ids["AND01"]))
    assert (layout.width_m, layout.height_m) == (40.0, 30.0)
    codes = set(db.scalars(select(ShelfLocation.code).where(ShelfLocation.layout_id == layout.id)))
    assert len(codes) == 6 * 2 * 4 * 5 + 7 * 4 + 9 + 9 + 5 * 3 + 1
    assert {"A3-L-2-4", "D-2-2", "P-1-1", "Z-3-3", "E5-1-3", "CLR-1-1"} <= codes


def test_new_store_owner_end_to_end(client, db):
    # 1. self-service sign-up
    owner = _bearer(client.post(f"{API}/onboarding/merchant", json={
        "business_name": "Sharma Kirana Mart", "full_name": "Rakesh Sharma", "email": "rakesh@kirana.example",
        "password": "Kirana@2026"}))
    client.cookies.clear()
    st = client.get(f"{API}/merchant/onboarding/status", headers=owner).json()
    assert st["steps"] == {"store": False, "layout": False, "catalog": False, "history": False, "channels": False}

    # 2. store + generated floor plan (preview first, nothing persisted)
    store = client.post(f"{API}/merchant/stores", headers=owner, json={
        "name": "Sharma Kirana Mart - Pune", "address": "FC Road", "city": "Pune", "latitude": 18.52,
        "longitude": 73.84}).json()
    spec = {"aisles": 3, "sections": 3, "levels": 4, "dairy_wall": True, "produce_wall": True, "frozen_wall": False,
            "checkouts": 2}
    prev = client.post(f"{API}/merchant/stores/{store['id']}/layout-preview", headers=owner, json=spec)
    assert prev.status_code == 200, prev.text
    assert prev.json()["stats"]["aisles"] == 3 and not any(s["code"].startswith("Z-") for s in prev.json()["shelves"])
    assert client.get(f"{API}/stores/{store['id']}/floorplan", headers=owner).status_code in (404, 422, 200)
    gen = client.post(f"{API}/merchant/stores/{store['id']}/layout-generate", headers=owner, json=spec).json()
    assert gen["status"] == "active"

    # 3. starter catalog through the normal importer (shelf codes exist in the generated plan)
    csv_text = client.get(f"{API}/merchant/stores/{store['id']}/starter-catalog.csv", params={"limit": 40},
                          headers=owner).text
    job = client.post(f"{API}/merchant/inventory/imports", headers=owner,
                      files={"file": ("catalog.csv", csv_text.encode(), "text/csv")}).json()
    assert job["error_rows"] == 0 and job["valid_rows"] == 40, job
    assert client.post(f"{API}/merchant/inventory/imports/{job['id']}/commit", headers=owner).status_code == 202
    done = client.get(f"{API}/merchant/inventory/imports/{job['id']}", headers=owner).json()
    assert done["status"] == "completed" and done["summary"]["placements_set"] >= 35

    # 4. sales history backfill
    sales_csv = client.get(f"{API}/merchant/stores/{store['id']}/starter-sales.csv", params={"days": 30, "per_day": 20},
                           headers=owner).text
    res = client.post(f"{API}/merchant/channels/sales-history", headers=owner,
                      files={"file": ("sales.csv", sales_csv.encode(), "text/csv")}).json()
    assert res["receipts_imported"] >= 400 and res["error_rows"] == 0, res
    again = client.post(f"{API}/merchant/channels/sales-history", headers=owner,
                        files={"file": ("sales.csv", sales_csv.encode(), "text/csv")}).json()
    assert again["receipts_imported"] == 0 and again["duplicate_receipts_skipped"] == res["receipts_imported"]

    # 5. first analytics run (images, index, forecasts, affinity)
    fin = client.post(f"{API}/merchant/onboarding/finish", headers=owner).json()
    assert fin["images_generated"] == 40
    assert all(j["status"] == "succeeded" for j in fin["jobs"].values()), fin["jobs"]

    # 6. connect a POS with an API key and push a bill
    key = client.post(f"{API}/merchant/channels/keys", headers=owner,
                      json={"name": "Counter 1 billing", "channel": "pos", "provider": "generic"}).json()
    assert key["secret"].startswith("op_live_")
    status = client.get(f"{API}/merchant/onboarding/status", headers=owner).json()
    assert status["complete"] is True, status

    store_row = db.get(Store, uuid.UUID(store["id"]))
    milk = db.scalars(select(Product).where(Product.merchant_id == store_row.merchant_id, Product.sku == "MLK-001")).one()
    item = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store_row.id,
                                                  InventoryItem.product_id == milk.id)).one()
    before = item.quantity_on_hand
    bill = {"external_id": "BILL-1001", "store_code": store["code"], "channel": "pos",
            "items": [{"sku": "mlk-001", "quantity": 2}, {"sku": "MLK-001", "quantity": 1}]}
    r = client.post(f"{API}/ingest/orders", json=bill, headers={"X-Api-Key": key["secret"]})
    assert r.status_code == 201, r.text
    assert r.json()["item_count"] == 3 and r.json()["duplicate"] is False
    db.expire_all()
    assert db.get(InventoryItem, item.id).quantity_on_hand == before - 3
    # webhook retry is idempotent
    assert client.post(f"{API}/ingest/orders", json=bill, headers={"X-Api-Key": key["secret"]}).json()["duplicate"] is True
    db.expire_all()
    assert db.get(InventoryItem, item.id).quantity_on_hand == before - 3

    # catalog feed for an online storefront
    feed = client.get(f"{API}/ingest/catalog", params={"store_code": store["code"]},
                      headers={"X-Api-Key": key["secret"]}).json()
    assert feed["count"] == 40 and any(i["sku"] == "MLK-001" and i["stock"] == before - 3 for i in feed["items"])

    # revoked keys stop working
    assert client.delete(f"{API}/merchant/channels/keys/{key['id']}", headers=owner).status_code == 204
    assert client.post(f"{API}/ingest/orders", json={**bill, "external_id": "BILL-1002"},
                       headers={"X-Api-Key": key["secret"]}).status_code == 401

    # the new store is visible to shoppers with a working route map
    shop = client.get(f"{API}/stores/{store['id']}/floorplan", headers=owner)
    assert shop.status_code == 200


def test_shopify_webhook_and_stock_rules(client, admin, db, ids):
    key = client.post(f"{API}/merchant/channels/keys", headers=admin,
                      json={"name": "Shopify store", "channel": "ecommerce", "provider": "shopify",
                            "store_id": ids["AND01"]}).json()
    hdr = {"X-Api-Key": key["secret"]}
    payload = {"id": 820982911946154508, "order_number": 1042, "created_at": "2026-10-17T10:15:00+05:30",
               "payment_gateway_names": ["razorpay"],
               "line_items": [{"sku": "COF-001", "quantity": 1, "price": "349.00", "title": "Coffee"},
                              {"sku": "BIS-001", "quantity": 2, "price": "30.00", "title": "Biscuits"}]}
    r = client.post(f"{API}/ingest/shopify/orders", json=payload, headers=hdr)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["channel"] == "online" and body["receipt_number"] == "SHOPIFY-1042" and body["total"] == 409.0
    # online orders cannot oversell
    big = {"external_id": "WEB-9", "channel": "online", "items": [{"sku": "ELE-001", "quantity": 999}]}
    r = client.post(f"{API}/ingest/orders", json=big, headers=hdr)
    assert r.status_code == 422 and r.json()["error"]["code"] == "insufficient_stock"
    # unknown SKUs are reported, nothing is recorded
    n = db.scalar(select(func.count(SalesTransaction.id)))
    r = client.post(f"{API}/ingest/orders", json={"items": [{"sku": "NOPE-1", "quantity": 1}]}, headers=hdr)
    assert r.status_code == 404 and db.scalar(select(func.count(SalesTransaction.id))) == n
    # a key can never write into another merchant's store
    assert client.post(f"{API}/ingest/orders", headers=hdr, json={
        "store_code": "KOR01", "items": [{"sku": "MLK-001", "quantity": 1}]}).status_code == 404
    assert client.post(f"{API}/ingest/orders", json={"items": [{"sku": "MLK-001", "quantity": 1}]}).status_code == 401


def test_pos_simulator_consumes_fefo(client, admin, db, ids):
    mlk = ids["p"]["MLK-002"]
    batches = db.scalars(select(InventoryBatch).where(InventoryBatch.store_id == uuid.UUID(ids["AND01"]),
                                                      InventoryBatch.product_id == uuid.UUID(mlk),
                                                      InventoryBatch.quantity_remaining > 0)
                         .order_by(InventoryBatch.expiry_date)).all()
    earliest = batches[0]
    left = earliest.quantity_remaining
    r = client.post(f"{API}/merchant/channels/simulate", headers=admin,
                    json={"store_id": ids["AND01"], "lines": [{"product_id": mlk, "quantity": 2}]})
    assert r.status_code == 201, r.text
    db.expire_all()
    assert db.get(InventoryBatch, earliest.id).quantity_remaining == left - 2
    rnd = client.post(f"{API}/merchant/channels/simulate", headers=admin, json={"store_id": ids["AND01"], "channel": "online"})
    assert rnd.status_code == 201 and rnd.json()["is_simulated"] is True
    recent = client.get(f"{API}/merchant/channels/orders", headers=admin, params={"limit": 5}).json()
    assert recent[0]["receipt_number"] == rnd.json()["receipt_number"]
    ov = client.get(f"{API}/merchant/channels", headers=admin).json()
    assert ov["today"]["online"]["orders"] >= 1 and ov["realtime"] == "polling"
    # store managers may simulate only in their own store
    mgr = client.post(f"{API}/auth/login", json={"email": "manager.andheri@freshmart.demo", "password": "Demo@12345"})
    client.cookies.clear()
    r = client.post(f"{API}/merchant/channels/simulate", headers=_bearer(mgr), json={"store_id": ids["BAN01"]})
    assert r.status_code == 403


def test_click_and_collect_from_shared_list(client, customer, customer2, db):
    lists = client.get(f"{API}/shopping-lists", headers=customer).json()
    shared = next(x for x in lists if x["name"] == "Weekend breakfast")
    detail = client.get(f"{API}/shopping-lists/{shared['id']}", headers=customer).json()
    pending = [i for i in detail["items"] if i["status"] == "pending" and i.get("product_id")]
    r = client.post(f"{API}/shopping-lists/{shared['id']}/order", headers=customer, json={"payment_method": "upi"})
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["channel"] == "online" and order["customer"] == "Priya Sharma" and order["item_count"] >= len(pending)
    after = client.get(f"{API}/shopping-lists/{shared['id']}", headers=customer2).json()
    assert all(i["status"] == "collected" for i in after["items"] if i["id"] in {p["id"] for p in pending})
    assert client.post(f"{API}/shopping-lists/{shared['id']}/order", headers=customer, json={}).status_code == 422
    notes = client.get(f"{API}/notifications", headers=customer).json()
    items = notes["items"] if isinstance(notes, dict) else notes
    assert any(order["receipt_number"] in n["title"] for n in items)


def test_realtime_negotiation_without_firebase(client, customer):
    assert client.get(f"{API}/realtime/config", headers=customer).json() == {"transport": "websocket"}
    assert client.post(f"{API}/realtime/token", headers=customer).status_code == 422


def test_ai_brief_is_grounded(client, admin):
    r = client.get(f"{API}/merchant/ai-brief", headers=admin, params={"refresh": True})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["provider"] == "demo" and b["fell_back"] is True and 1 <= len(b["actions"]) <= 5
    ids = {f["id"] for f in b["facts"]["facts"]}
    assert all(set(a["fact_ids"]) <= ids and a["link"] for a in b["actions"])
    assert client.get(f"{API}/merchant/ai-brief", headers=admin).json()["cached"] is True


def test_llm_brief_rejects_ungrounded_numbers():
    from app.ai.providers.llm_base import brief_is_grounded
    from app.ai.schemas import BriefAction, OperationsBrief

    facts = {"facts": [{"id": "F1", "text": "Milk: 4 on hand, reorder point 10."}]}
    payload = __import__("json").dumps(facts)
    ok = OperationsBrief(headline="x", actions=[BriefAction(title="Reorder milk", detail="Only 4 left", fact_ids=["F1"])])
    bad_num = OperationsBrief(headline="x", actions=[BriefAction(title="Reorder milk", detail="Only 37 left", fact_ids=["F1"])])
    bad_id = OperationsBrief(headline="x", actions=[BriefAction(title="Reorder milk", detail="Low", fact_ids=["F9"])])
    assert brief_is_grounded(ok, facts, payload)
    assert not brief_is_grounded(bad_num, facts, payload)
    assert not brief_is_grounded(bad_id, facts, payload)
