"""Authentication, role permissions and merchant data isolation."""

from tests.conftest import PASSWORD, login


def test_login_sets_cookie_and_returns_profile(client):
    r = client.post("/api/v1/auth/login", json={"email": "admin@freshmart.demo", "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["account_type"] == "merchant"
    assert body["merchant"]["role"] == "merchant_admin"
    assert "pricing.approve" in body["merchant"]["permissions"]
    assert "op_session" in r.cookies
    me = client.get("/api/v1/auth/me")  # cookie jar carries the httpOnly session cookie
    assert me.status_code == 200 and me.json()["user"]["email"] == "admin@freshmart.demo"
    client.cookies.clear()


def test_wrong_password_is_rejected_with_error_envelope(client):
    r = client.post("/api/v1/auth/login", json={"email": "priya@demo.omnipulse.ai", "password": "nope"})
    assert r.status_code == 401
    err = r.json()["error"]
    assert err["code"] == "invalid_credentials" and err["request_id"]


def test_unauthenticated_requests_are_rejected(client):
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/merchant/overview").status_code == 401


def test_logout_revokes_session(client):
    h = login(client, "rohan@demo.omnipulse.ai")
    assert client.get("/api/v1/auth/me", headers=h).status_code == 200
    assert client.post("/api/v1/auth/logout", headers=h).status_code == 204
    assert client.get("/api/v1/auth/me", headers=h).status_code == 401


def test_register_customer_and_duplicate(client):
    body = {"email": "new.shopper@example.com", "password": "Sup3rSecret!", "full_name": "New Shopper"}
    r = client.post("/api/v1/auth/register", json=body)
    client.cookies.clear()
    assert r.status_code == 201 and r.json()["user"]["account_type"] == "customer"
    assert client.post("/api/v1/auth/register", json=body).status_code == 409
    weak = client.post("/api/v1/auth/register", json={**body, "email": "x@example.com", "password": "short"})
    assert weak.status_code == 422


def test_login_rate_limit(client, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "login_rate_limit_per_minute", 3)
    for _ in range(3):
        client.post("/api/v1/auth/login", json={"email": "ratelimit@example.com", "password": "x"})
    r = client.post("/api/v1/auth/login", json={"email": "ratelimit@example.com", "password": "x"})
    assert r.status_code == 429


def test_customer_cannot_use_merchant_api(client, customer):
    r = client.get("/api/v1/merchant/overview", headers=customer)
    assert r.status_code == 403


def test_merchant_cannot_use_shopper_lists(client, admin):
    assert client.get("/api/v1/shopping-lists", headers=admin).status_code == 403


def test_analyst_is_read_only_for_pricing(client, analyst, ids):
    assert client.get("/api/v1/merchant/pricing/changes", headers=analyst).status_code == 200
    r = client.post("/api/v1/merchant/pricing/changes", headers=analyst,
                    json={"store_id": ids["AND01"], "product_id": ids["p"]["TEA-001"], "new_price": 280, "reason": "test"})
    assert r.status_code == 403


def test_store_manager_is_scoped_to_assigned_store(client, manager, ids):
    assert client.get(f"/api/v1/merchant/inventory?store_id={ids['AND01']}", headers=manager).status_code == 200
    assert client.get(f"/api/v1/merchant/inventory?store_id={ids['BAN01']}", headers=manager).status_code == 403
    rows = client.get("/api/v1/merchant/inventory?page_size=200", headers=manager).json()["items"]
    assert rows and {r["store_code"] for r in rows} == {"AND01"}


def test_tenant_isolation_between_merchants(client, other_admin, admin, ids):
    # UrbanBasket's admin cannot see FreshMart's products, stores or price changes (404, no leak).
    fm_product = ids["p"]["MLK-001"]
    assert client.get(f"/api/v1/merchant/products/{fm_product}", headers=other_admin).status_code == 404
    assert client.get(f"/api/v1/merchant/inventory?store_id={ids['AND01']}", headers=other_admin).status_code == 404
    fm_changes = client.get("/api/v1/merchant/pricing/changes", headers=admin).json()["items"]
    assert fm_changes
    assert client.get(f"/api/v1/merchant/pricing/changes/{fm_changes[0]['id']}", headers=other_admin).status_code == 404
    # ...and its own lists only contain its own data
    ub_products = client.get("/api/v1/merchant/products?page_size=200", headers=other_admin).json()["items"]
    assert ub_products and all(p["id"] in ids["ub_p"].values() for p in ub_products)
    alerts = client.get("/api/v1/merchant/fraud/alerts", headers=other_admin).json()
    assert alerts["total"] == 0
    stores = client.get("/api/v1/merchant/stores", headers=other_admin).json()
    assert [s["code"] for s in stores] == ["KOR01"]


def test_validation_and_not_found_envelopes(client, admin):
    r = client.get("/api/v1/merchant/products/not-a-uuid", headers=admin)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"
    r = client.get("/api/v1/does-not-exist", headers=admin)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
