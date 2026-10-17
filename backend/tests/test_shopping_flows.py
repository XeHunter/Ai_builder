"""Customer journeys: catalog search, list parsing, list operations, routing and shared shopping."""

from pathlib import Path

import pytest

from app.core.config import REPO_DIR
from tests.conftest import login

DEMO_TEXT = "Milk, eggs, bread, chocolate, diapers, detergent, and coffee."


def test_catalog_search_and_synonyms(client, customer, ids):
    r = client.get(f"/api/v1/stores/{ids['AND01']}/products", params={"q": "nappies"}, headers=customer)
    assert r.status_code == 200
    names = [p["name"] for p in r.json()["items"]]
    assert any("Diapers" in n for n in names[:3])
    r = client.get(f"/api/v1/stores/{ids['AND01']}/products", params={"q": "ELE-003"}, headers=customer)
    assert r.json()["items"][0]["sku"] == "ELE-003"
    card = r.json()["items"][0]
    assert card["location"]["shelf_code"].startswith("A6") and card["price"] > 0


def test_product_detail_has_curated_complements(client, customer, ids):
    r = client.get(f"/api/v1/stores/{ids['AND01']}/products/{ids['p']['ELE-001']}", headers=customer)
    assert r.status_code == 200
    comps = [c["sku"] for c in r.json()["complementary"]]
    assert "ELE-003" in comps


def test_parse_demo_shopping_list(client, customer, ids):
    r = client.post("/api/v1/shopping-lists/parse", json={"store_id": ids["AND01"], "text": DEMO_TEXT}, headers=customer)
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["raw_text"].lower() for i in items] == ["milk", "eggs", "bread", "chocolate", "diapers", "detergent", "coffee"]
    assert all(i["product_id"] for i in items)
    milk = items[0]
    assert "milk" in milk["display_name"].lower() and len(milk["candidates"]) > 1


def test_parse_handles_quantities_duplicates_and_unknowns(client, customer, ids):
    r = client.post("/api/v1/shopping-lists/parse", headers=customer,
                    json={"store_id": ids["AND01"], "text": "2 kg onions\nmilk, milk\nquinoa, 1 dozen eggs"})
    body = r.json()
    by = {i["raw_text"].lower(): i for i in body["items"]}
    assert by["onions"]["quantity"] == 2 and by["onions"]["unit"] == "kg"
    assert by["eggs"]["quantity"] == 12
    assert body["duplicates_merged"] and by["milk"]["quantity"] == 2
    assert "quinoa" in body["unresolved"] and by["quinoa"]["status"] == "unresolved"


@pytest.fixture(scope="module")
def demo_list(client, customer, ids):
    parsed = client.post("/api/v1/shopping-lists/parse", json={"store_id": ids["AND01"], "text": DEMO_TEXT + " quinoa"},
                         headers=customer).json()
    items = [{"raw_text": i["raw_text"], "product_id": i["product_id"], "quantity": i["quantity"]} for i in parsed["items"]]
    r = client.post("/api/v1/shopping-lists", json={"name": "Test list", "store_id": ids["AND01"], "items": items},
                    headers=customer)
    assert r.status_code == 201
    return r.json()


def test_list_groups_by_aisle_and_tracks_progress(demo_list):
    labels = [g["label"] for g in demo_list["groups"]]
    assert any(label.startswith("Aisle") for label in labels)
    assert "Needs a product match" in labels
    assert demo_list["progress"]["total"] == 8 and demo_list["progress"]["unresolved"] == 1


def test_route_is_optimised_and_skips_unresolved(client, customer, demo_list):
    r = client.post(f"/api/v1/shopping-lists/{demo_list['id']}/route", json={}, headers=customer)
    assert r.status_code == 200
    route = r.json()
    picked = [i["name"] for s in route["stops"] for i in s["items"]]
    assert len(picked) == 7
    assert route["total_distance_m"] <= route["unoptimized_distance_m"]
    assert route["algorithm"] == "held_karp_exact"
    assert any(u["reason"] == "no product match" for u in route["unrouted"])
    assert route["steps"][0]["type"] == "start" and route["steps"][-1]["type"] == "finish"
    assert route["path"][0]["code"] == "ENT"


def test_item_operations_versioning_and_route_recalculation(client, customer, demo_list):
    lid = demo_list["id"]
    item = next(i for i in demo_list["items"] if i["status"] == "pending")
    r = client.patch(f"/api/v1/shopping-lists/{lid}/items/{item['id']}", json={"status": "collected"}, headers=customer)
    assert r.status_code == 200 and r.json()["item"]["status"] == "collected"
    # collecting twice is idempotent (conflict-free)
    r2 = client.patch(f"/api/v1/shopping-lists/{lid}/items/{item['id']}", json={"status": "collected"}, headers=customer)
    assert r2.status_code == 200 and r2.json()["event"]["payload"].get("noop")
    # stale version -> 409 with the current item
    r3 = client.patch(f"/api/v1/shopping-lists/{lid}/items/{item['id']}", json={"quantity": 3, "expected_version": 1},
                      headers=customer)
    assert r3.status_code == 409 and r3.json()["error"]["details"]["current"]["id"] == item["id"]
    route = client.post(f"/api/v1/shopping-lists/{lid}/route", json={}, headers=customer).json()
    assert item["id"] not in [i["item_id"] for s in route["stops"] for i in s["items"]]
    # add merges duplicates of an uncollected product
    added = client.post(f"/api/v1/shopping-lists/{lid}/items", json={"raw_text": "detergent"}, headers=customer).json()
    assert added["event"]["type"] == "item_updated" and added["event"]["payload"]["merged_duplicate"]
    events = client.get(f"/api/v1/shopping-lists/{lid}/events", params={"since": 0}, headers=customer).json()
    assert [e["seq"] for e in events] == sorted(e["seq"] for e in events)


def test_shared_list_invitations_and_permissions(client, customer, customer2, demo_list):
    lid = demo_list["id"]
    assert client.get(f"/api/v1/shopping-lists/{lid}", headers=customer2).status_code == 404
    inv = client.post(f"/api/v1/shopping-lists/{lid}/invitations", json={"role": "viewer", "max_uses": 1}, headers=customer)
    assert inv.status_code == 201 and inv.json()["qr_svg"].startswith("<svg") and "/invite/" in inv.json()["url"]
    token = inv.json()["token"]
    assert client.get(f"/api/v1/invitations/{token}", headers=customer2).json()["role"] == "viewer"
    assert client.post(f"/api/v1/invitations/{token}/accept", headers=customer2).status_code == 200
    item = demo_list["items"][1]
    denied = client.patch(f"/api/v1/shopping-lists/{lid}/items/{item['id']}", json={"status": "collected"}, headers=customer2)
    assert denied.status_code == 403
    # exhausted and revoked invitations
    other = login(client, "shopper01@demo.omnipulse.ai")
    assert client.post(f"/api/v1/invitations/{token}/accept", headers=other).json()["error"]["code"] == "invitation_exhausted"
    inv2 = client.post(f"/api/v1/shopping-lists/{lid}/invitations", json={"role": "editor"}, headers=customer).json()
    client.delete(f"/api/v1/shopping-lists/{lid}/invitations/{inv2['id']}", headers=customer)
    assert client.post(f"/api/v1/invitations/{inv2['token']}/accept", headers=other).json()["error"]["code"] == "invitation_revoked"


def test_websocket_sync_between_two_members(client, customer, customer2, ids):
    lst = client.post("/api/v1/shopping-lists", json={"name": "WS list", "store_id": ids["AND01"],
                                                       "items": [{"raw_text": "milk"}, {"raw_text": "bread"}]},
                      headers=customer).json()
    token = client.post(f"/api/v1/shopping-lists/{lst['id']}/invitations", json={"role": "editor"}, headers=customer).json()["token"]
    client.post(f"/api/v1/invitations/{token}/accept", headers=customer2)
    t1 = customer["Authorization"].split()[1]
    t2 = customer2["Authorization"].split()[1]
    url = f"/api/v1/ws/shopping-lists/{lst['id']}"
    with client.websocket_connect(f"{url}?token={t1}") as a, client.websocket_connect(f"{url}?token={t2}") as b:
        assert a.receive_json()["type"] == "snapshot"
        snap_b = b.receive_json()
        assert snap_b["type"] == "snapshot"
        item_id = snap_b["list"]["items"][0]["id"]
        _drain_presence(a), _drain_presence(b)
        b.send_json({"type": "op", "op": "collect", "item_id": item_id, "client_event_id": "c1"})
        ack = _next(b, "ack")
        assert ack["client_event_id"] == "c1"
        ev = _next(a, "event")
        assert ev["event"]["type"] == "item_collected" and ev["event"]["item_id"] == item_id
        last_seq = ev["event"]["seq"]
        b.send_json({"type": "op", "op": "update_item", "item_id": item_id, "quantity": 2, "expected_version": 999,
                     "client_event_id": "c2"})
        err = _next(b, "error")
        assert err["code"] == "conflict"
        # idempotent retry of the same client_event_id does not create a new event
        b.send_json({"type": "op", "op": "collect", "item_id": item_id, "client_event_id": "c1"})
        assert _next(b, "ack")["seq"] == ack["seq"]
    # REST change while disconnected, then reconnect with last_seq -> catch-up events
    client.post(f"/api/v1/shopping-lists/{lst['id']}/items", json={"raw_text": "coffee"}, headers=customer)
    with client.websocket_connect(f"{url}?token={t2}&last_seq={last_seq}") as b2:
        msg = b2.receive_json()
        assert msg["type"] == "events" and any(e["type"] == "item_added" for e in msg["events"])


def test_websocket_rejects_non_members(client, ids, customer):
    lst = client.post("/api/v1/shopping-lists", json={"name": "Private", "store_id": ids["AND01"], "items": []},
                      headers=customer).json()
    stranger = login(client, "shopper02@demo.omnipulse.ai")["Authorization"].split()[1]
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/ws/shopping-lists/{lst['id']}?token={stranger}") as ws:
            ws.receive_json()


def _next(ws, kind: str) -> dict:
    for _ in range(10):
        m = ws.receive_json()
        if m["type"] == kind:
            return m
    raise AssertionError(f"no {kind} message")


def _drain_presence(ws) -> None:
    pass


# ----------------------------------------------------------------------------- assistant & visual search


def test_assistant_budget_breakfast(client, customer, ids):
    r = client.post("/api/v1/assistant/chat", headers=customer,
                    json={"store_id": ids["AND01"], "message": "I need breakfast items for two people under ₹500."})
    body = r.json()
    assert r.status_code == 200 and body["intent"]["intent"] == "budget_basket"
    assert body["basket"]["total"] <= 500 and body["basket"]["within_budget"]
    assert body["products"] and all(p["in_stock"] for p in body["products"])
    assert body["grounding"]["validated"] and body["provider"]["name"] == "demo"


def test_assistant_locates_product(client, customer, ids):
    body = client.post("/api/v1/assistant/chat", headers=customer,
                       json={"store_id": ids["AND01"], "message": "Where can I find milk?"}).json()
    assert body["intent"]["intent"] == "locate_product"
    assert body["directions"] and body["directions"][0]["aisle_code"] == "D"


def test_assistant_compatible_accessory(client, customer, ids):
    body = client.post("/api/v1/assistant/chat", headers=customer,
                       json={"store_id": ids["AND01"], "message": "Which compatible memory card goes with this camera?",
                             "context_product_id": ids["p"]["ELE-001"]}).json()
    assert body["intent"]["intent"] == "complementary"
    assert body["complementary"][0]["sku"] == "ELE-003"
    assert body["complementary"][0]["source"] == "merchant_relation"


def test_assistant_clarifies_vague_requests(client, customer, ids):
    body = client.post("/api/v1/assistant/chat", headers=customer,
                       json={"store_id": ids["AND01"], "message": "Find a product similar to this one."}).json()
    assert body["intent"]["intent"] == "clarify" and body["clarifying_question"]


def test_grounding_rejects_unverified_amounts():
    from app.ai.recommendations.assistant import _validate_reply

    facts = {"products": [{"id": "p1", "price": 68.0, "promotion": None, "markdown": None}], "complementary": []}
    assert _validate_reply("Milk costs ₹68.", ["p1"], facts) == []
    assert _validate_reply("Milk costs ₹12.", ["p1"], facts)
    assert _validate_reply("ok", ["ghost"], facts)


def test_grounding_allows_shopper_amounts_and_greeting_examples():
    from app.ai.recommendations.assistant import _validate_reply
    from app.ai.schemas import ShoppingIntent

    facts = {"products": [], "complementary": []}
    greeting = ShoppingIntent(intent="greeting")
    assert _validate_reply('Try "breakfast for two under ₹500"', [], facts, user_message="hi", intent=greeting) == []
    budget = ShoppingIntent(intent="budget_basket", budget=500)
    assert _validate_reply("Here is a basket under ₹500.", [], facts, user_message="snacks under ₹500", intent=budget) == []
    assert _validate_reply("Chips are ₹999.", [], facts, user_message="snacks under ₹500", intent=budget)


def test_greeting_reply_is_marked_verified(client, customer, ids):
    r = client.post("/api/v1/assistant/chat", headers=customer, json={"store_id": ids["AND01"], "message": "hi"})
    assert r.status_code == 200, r.text
    assert r.json()["grounding"] == {"validated": True, "issues": []}


def test_visual_search_matches_query_photo(client, customer, ids):
    photo = REPO_DIR / "data" / "sample" / "query_images" / "photo_sea-001.jpg"
    with Path(photo).open("rb") as f:
        r = client.post("/api/v1/visual-search", data={"store_id": ids["AND01"]},
                        files={"image": ("photo.jpg", f, "image/jpeg")}, headers=customer)
    assert r.status_code == 200
    body = r.json()
    assert body["matches"][0]["sku"] == "SEA-001"
    assert body["method"] == "colour_layout_similarity"


def test_visual_search_rejects_invalid_files(client, customer, ids):
    r = client.post("/api/v1/visual-search", data={"store_id": ids["AND01"]},
                    files={"image": ("x.jpg", b"not an image", "image/jpeg")}, headers=customer)
    assert r.status_code == 422
    r = client.post("/api/v1/visual-search", data={"store_id": ids["AND01"]},
                    files={"image": ("x.gif", b"GIF89a....", "image/gif")}, headers=customer)
    assert r.status_code == 422


def test_milk_prefers_milk_over_dairy_milk_chocolate(client, customer, ids):
    r = client.post("/api/v1/shopping-lists/parse", json={"store_id": ids["AND01"], "text": "milk"}, headers=customer).json()
    assert "Chocolate" not in r["items"][0]["display_name"]
    body = client.post("/api/v1/assistant/chat", headers=customer,
                       json={"store_id": ids["AND01"], "message": "breakfast for two under 500 rupees"}).json()
    milk = [p for p in body["products"] if p.get("slot") == "milk"]
    assert milk and "Chocolate" not in milk[0]["name"]


def test_explicit_choices_keep_candidates_and_skip_match(client, customer, ids):
    lst = client.post("/api/v1/shopping-lists", headers=customer, json={
        "name": "Explicit", "store_id": ids["AND01"],
        "items": [{"raw_text": "milk", "product_id": ids["p"]["MLK-002"]}, {"raw_text": "milk powder", "skip_match": True}]}).json()
    chosen, kept = lst["items"]
    assert chosen["product_id"] == ids["p"]["MLK-002"] and len(chosen["candidates"]) > 1
    assert kept["status"] == "unresolved" and kept["product_id"] is None
    summary = next(s for s in client.get("/api/v1/shopping-lists", headers=customer).json() if s["id"] == lst["id"])
    assert summary["store_id"] == ids["AND01"]


def test_visual_search_caption_beats_lookalike_colours(client, customer, ids, monkeypatch):
    """A product the vision model names must outrank a product that only has similar colours."""
    from app.ai.schemas import ImageDescription
    from app.ai.visual_search import service as vs

    class FakeVision:
        supports_vision = True

        def describe_image(self, data, content_type):
            return ImageDescription(caption="A Cadbury chocolate bar in green packaging", keywords=["cadbury", "chocolate"])

    monkeypatch.setattr(vs, "get_ai_provider", lambda: FakeVision())
    for photo, expected in (("photo_cho-001.jpg", "CHO-001"), ("photo_sea-001.jpg", None)):
        with (REPO_DIR / "data" / "sample" / "query_images" / photo).open("rb") as f:
            r = client.post("/api/v1/visual-search", data={"store_id": ids["AND01"]},
                            files={"image": (photo, f, "image/jpeg")}, headers=customer)
        assert r.status_code == 200, r.text
        if expected:
            assert r.json()["matches"][0]["sku"] == expected
