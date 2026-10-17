"""AI operations brief for store owners: verified facts in, prioritised actions out (Gemini when configured).

The facts are computed here from the database; the model only prioritises and phrases them, and its
output is rejected (template fallback) if it cites unknown facts or writes numbers that are not in them.
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai.providers import get_ai_provider
from app.db.models import (
    ExpiryAlert,
    FraudAlert,
    InventoryItem,
    PriceChange,
    Product,
    Store,
)
from app.services import channel_service, dashboard_service

_CACHE: dict[tuple, tuple[float, dict]] = {}
CACHE_SECONDS = 300


def gather_facts(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID]) -> dict:
    ov = dashboard_service.overview(db, merchant_id, store_ids, days=7)
    k = ov["kpis"]
    today = channel_service.channel_stats(db, merchant_id, days=1)
    facts: list[dict] = []

    def fact(kind: str, priority: str, title: str, text: str, action: str, link: str) -> None:
        facts.append({"id": f"F{len(facts) + 1}", "kind": kind, "priority": priority, "title": title, "text": text,
                      "action": action, "link": link})

    for a in db.scalars(select(ExpiryAlert).where(ExpiryAlert.store_id.in_(store_ids), ExpiryAlert.status == "open",
                                                  ExpiryAlert.severity.in_(("critical", "expired")))
                        .order_by(ExpiryAlert.hours_to_expiry).limit(3)):
        expired = a.severity == "expired"
        fact("expiry", "high", f"{'Write off' if expired else 'Clear'} {a.product.name if a.product else 'short-dated stock'}",
             a.message,
             "Record the write-off and check the shelf is clear." if expired
             else "Approve the markdown recommendation or move the batch to the clearance bin.", "/merchant/expiry")
    low = db.execute(select(Product.name, InventoryItem.quantity_on_hand, InventoryItem.reorder_point,
                            InventoryItem.reorder_quantity, Store.code)
                     .join(Product, Product.id == InventoryItem.product_id).join(Store, Store.id == InventoryItem.store_id)
                     .where(InventoryItem.store_id.in_(store_ids), InventoryItem.quantity_on_hand <= InventoryItem.reorder_point)
                     .order_by(InventoryItem.quantity_on_hand).limit(3)).all()
    for name, qty, rp, rq, code in low:
        fact("low_stock", "high" if qty == 0 else "medium", f"Reorder {name}",
             f"{name} at {code}: {qty} on hand, reorder point {rp}.",
             f"Raise a purchase order for about {rq} units.", "/merchant/inventory")
    if k["stockout_risk_high"]:
        fact("forecast", "medium", "Stockout risk this week",
             f"{k['stockout_risk_high']} products are at high stockout risk in the latest demand forecast.",
             "Check the forecast's reorder suggestions before the weekend.", "/merchant/forecasting")
    pending = db.scalar(select(func.count(PriceChange.id)).where(
        PriceChange.merchant_id == merchant_id, PriceChange.store_id.in_(store_ids),
        PriceChange.status.in_(("RECOMMENDED", "PENDING_APPROVAL")))) or 0
    if pending:
        fact("pricing", "medium", "Price changes waiting for you",
             f"{pending} price recommendations are waiting for approval.",
             "Review and approve them so shelf labels and the online store update.", "/merchant/pricing")
    high_fraud = db.scalar(select(func.count(FraudAlert.id)).where(
        FraudAlert.merchant_id == merchant_id, FraudAlert.status == "open", FraudAlert.risk_level == "high")) or 0
    if high_fraud:
        fact("fraud", "medium", "High-risk transactions to review",
             f"{high_fraud} high-risk transactions are open in the fraud review queue.",
             "Assign them for investigation; the queue never acts automatically.", "/merchant/fraud")
    if k["pending_merchandising_recommendations"]:
        fact("merchandising", "low", "Merchandising tests proposed",
             f"{k['pending_merchandising_recommendations']} shelf-placement experiments are proposed.",
             "Pick one to trial as an A/B test.", "/merchant/merchandising")
    online = today.get("online", {}).get("orders", 0)
    instore = sum(v["orders"] for ch, v in today.items() if ch != "online")
    fact("channels", "low", "Today's channel mix",
         f"{instore} in-store bills and {online} online orders so far today.",
         "Keep an eye on online stock for fast movers.", "/merchant/channels")
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "kpis": {"orders_today": instore + online, "online_orders_today": online,
                 "revenue_7d": k["net_revenue"], "revenue_change_pct": k["revenue_change_pct"],
                 "low_stock_products": k["low_stock_products"], "expiring_batches_3d": k["expiring_batches_3d"]},
        "facts": facts,
    }


def operations_brief(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID], refresh: bool = False) -> dict:
    key = (merchant_id, tuple(sorted(store_ids)))
    hit = _CACHE.get(key)
    if hit and not refresh and time.time() - hit[0] < CACHE_SECONDS:
        return {**hit[1], "cached": True}
    facts = gather_facts(db, merchant_id, store_ids)
    provider = get_ai_provider()
    brief = provider.operations_brief(facts)
    by_id = {f["id"]: f for f in facts["facts"]}
    out = {
        "headline": brief.headline,
        "actions": [{**a.model_dump(), "link": next((by_id[i]["link"] for i in a.fact_ids if i in by_id), None),
                     "evidence": [by_id[i]["text"] for i in a.fact_ids if i in by_id]} for a in brief.actions],
        "facts": facts,
        "provider": provider.name,
        "model": getattr(provider, "chat_model", "") or None,
        "fell_back": bool(getattr(provider, "last_call_fell_back", False)) or provider.kind == "deterministic",
        "generated_at": facts["generated_at"],
        "cached": False,
    }
    _CACHE[key] = (time.time(), out)
    return out


def clear_cache() -> None:
    _CACHE.clear()

