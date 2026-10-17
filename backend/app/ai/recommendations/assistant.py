"""Conversational shopping concierge.

Flow: provider.extract_intent (LLM or rules) -> backend tools (catalog search, stock, prices,
locations, curated relations, basket-analysis rules) -> provider.compose_reply over *verified facts*
-> grounding validation. The model never sees other merchants' data and cannot change any state.

Grounding checks on the composed reply:
* highlighted product ids must exist in the facts;
* every rupee amount in the text must equal a price/total present in the facts;
otherwise the reply is replaced by the deterministic template built from the same facts.
"""

from __future__ import annotations

import math
import re
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai import lexicon
from app.ai.providers import get_ai_provider
from app.ai.providers.demo import DemoProvider
from app.ai.schemas import ShoppingIntent
from app.core.exceptions import NotFoundError
from app.db.models import InventoryItem, Product, Store
from app.services import catalog_service, cross_selling_service

_RUPEE_RE = re.compile(r"₹\s?(\d[\d,]*(?:\.\d+)?)")
SCALE_WITH_PEOPLE = {"milk", "bread", "eggs", "bananas"}


def _carried(db: Session, store: Store) -> set[uuid.UUID]:
    return set(db.scalars(select(InventoryItem.product_id).where(InventoryItem.store_id == store.id)))


def _search_cards(db: Session, store: Store, query: str, limit: int, carried: set[uuid.UUID], min_score: float = 0.3) -> list[dict]:
    hits = [h for h in catalog_service.search(db, store.merchant_id, query, limit=limit, candidate_ids=carried)
            if h.score >= min_score]
    products = catalog_service.load_products(db, [h.product_id for h in hits])
    return catalog_service.product_cards(db, store, products, {h.product_id: h.score for h in hits})


def _basket(db: Session, store: Store, intent: ShoppingIntent, carried: set[uuid.UUID]) -> tuple[list[dict], dict]:
    slots = lexicon.OCCASIONS.get(intent.occasion or "", [])
    people = intent.people or 1
    remaining = intent.budget if intent.budget is not None else math.inf
    chosen, skipped, total = [], [], 0.0
    for slot in slots:
        cards = [c for c in _search_cards(db, store, slot, 6, carried) if c["in_stock"]]
        if not cards:
            skipped.append(slot)
            continue
        top = max(c["score"] or 0 for c in cards)
        viable = [c for c in cards if (c["score"] or 0) >= top - 0.15]
        card = min(viable, key=lambda c: (c["promotion"] or {}).get("price", c["price"]))
        unit_price = (card["promotion"] or {}).get("price", card["price"])
        qty = max(1, math.ceil(people / 2)) if slot in SCALE_WITH_PEOPLE else 1
        cost = unit_price * qty
        if cost > remaining:
            if unit_price <= remaining:
                qty, cost = 1, unit_price
            else:
                skipped.append(slot)
                continue
        remaining -= cost
        total += cost
        chosen.append({**card, "quantity": qty, "line_total": round(cost, 2), "slot": slot})
    summary = {"total": round(total, 2), "budget": intent.budget, "people": intent.people,
               "within_budget": intent.budget is None or total <= intent.budget + 1e-6, "skipped": skipped,
               "occasion": intent.occasion}
    return chosen, summary


def _validate_reply(message: str, highlight: list[str], facts: dict) -> list[str]:
    problems = []
    ids = {p["id"] for p in facts.get("products", [])} | {p["id"] for p in facts.get("complementary", [])}
    for h in highlight:
        if h not in ids:
            problems.append(f"unknown product id {h}")
    allowed: set[float] = set()
    for p in facts.get("products", []) + facts.get("complementary", []):
        allowed.add(round(float(p["price"]), 0))
        if p.get("promotion"):
            allowed.add(round(float(p["promotion"]["price"]), 0))
        if p.get("markdown"):
            allowed.add(round(float(p["markdown"]["price"]), 0))
        if p.get("line_total") is not None:
            allowed.add(round(float(p["line_total"]), 0))
    b = facts.get("basket") or {}
    for k in ("total", "budget"):
        if b.get(k) is not None:
            allowed.add(round(float(b[k]), 0))
    for m in _RUPEE_RE.finditer(message):
        v = round(float(m.group(1).replace(",", "")), 0)
        if v not in allowed:
            problems.append(f"unverified amount ₹{m.group(1)}")
    return problems


def chat(db: Session, store: Store, message: str, context_product_id: uuid.UUID | None = None) -> dict:
    provider = get_ai_provider()
    carried = _carried(db, store)
    ctx_product = None
    if context_product_id:
        ctx_product = db.get(Product, context_product_id)
        if ctx_product is None or ctx_product.merchant_id != store.merchant_id:
            raise NotFoundError("Product not found in this store")
    intent = provider.extract_intent(message, context_product=ctx_product.name if ctx_product else None)
    fell_back = getattr(provider, "last_call_fell_back", False)
    facts: dict = {"store_name": store.name, "products": [], "complementary": [], "unmatched": [], "reference": None}

    def ref_card(name: str | None) -> dict | None:
        if ctx_product is not None:
            return catalog_service.product_cards(db, store, [ctx_product])[0]
        if not name:
            return None
        cards = _search_cards(db, store, name, 1, carried)
        return cards[0] if cards else None

    if intent.intent == "find_products":
        seen: set[str] = set()
        for q in intent.search_queries[:6]:
            cards = _search_cards(db, store, q, 4, carried)
            if intent.max_unit_price is not None:
                cards = [c for c in cards if c["price"] <= intent.max_unit_price]
            if not cards:
                facts["unmatched"].append(q)
            for c in cards[: 3 if len(intent.search_queries) > 1 else 6]:
                if c["id"] not in seen:
                    seen.add(c["id"])
                    facts["products"].append(c)
    elif intent.intent == "budget_basket":
        products, summary = _basket(db, store, intent, carried)
        facts["products"], facts["basket"] = products, summary
    elif intent.intent == "locate_product":
        for q in intent.search_queries[:3]:
            cards = _search_cards(db, store, q, 3, carried)
            if not cards:
                facts["unmatched"].append(q)
            facts["products"].extend(cards[:2])
    elif intent.intent == "complementary":
        ref = ref_card(intent.reference_product)
        facts["reference"] = ref
        if ref:
            comps = cross_selling_service.complements_for(db, store.merchant_id, uuid.UUID(ref["id"]), store.id)
            prods = catalog_service.load_products(db, [c["product_id"] for c in comps])
            cards = catalog_service.product_cards(db, store, prods)
            reasons = {str(c["product_id"]): c for c in comps}
            want = set(lexicon.tokens(" ".join(intent.search_queries)))
            for card in cards:
                meta = reasons[card["id"]]
                card.update(reason=meta["reason"], source=meta["source"])
            if want:
                filtered = [c for c in cards if want & set(lexicon.tokens(c["name"] + " " + " ".join(c["tags"])))]
                cards = filtered or cards
            facts["complementary"] = cards
            facts["products"] = [ref]
        else:
            facts["unmatched"].append(intent.reference_product or "that product")
    elif intent.intent == "similar_product":
        ref = ref_card(intent.reference_product)
        facts["reference"] = ref
        if ref:
            query = f"{ref['name']} {(ref['category'] or {}).get('name', '')}"
            cands = [c for c in _search_cards(db, store, query, 8, carried, 0.2) if c["id"] != ref["id"]]
            same_cat = [c for c in cands if (c["category"] or {}).get("id") == (ref["category"] or {}).get("id")]
            facts["products"] = (same_cat or cands)[:4]
        else:
            facts["unmatched"].append(intent.reference_product or "that product")

    reply = provider.compose_reply(user_message=message, intent=intent, facts=facts)
    fell_back = fell_back or getattr(provider, "last_call_fell_back", False)
    problems = _validate_reply(reply.message, reply.highlight_product_ids, facts)
    grounded = not problems
    if problems:
        reply = DemoProvider().compose_reply(user_message=message, intent=intent, facts=facts)

    directions = [
        {"product_id": p["id"], "name": p["name"], **p["location"]}
        for p in facts["products"] + facts["complementary"] if p.get("location")
    ][:6]
    return {
        "message": reply.message,
        "intent": intent.model_dump(),
        "products": facts["products"],
        "complementary": facts["complementary"],
        "reference": facts["reference"],
        "basket": facts.get("basket"),
        "unmatched": facts["unmatched"],
        "directions": directions,
        "clarifying_question": intent.clarifying_question if intent.intent == "clarify" else None,
        "provider": {"name": provider.name, "kind": provider.kind, "fell_back": fell_back},
        "grounding": {"validated": grounded, "issues": problems},
    }
