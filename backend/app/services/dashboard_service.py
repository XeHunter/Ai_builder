"""Merchant overview metrics and customer shopping insights, computed live from database records."""

from __future__ import annotations

import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.db.models import (
    ExpiryAlert,
    ForecastProductSummary,
    ForecastRun,
    FraudAlert,
    InventoryBatch,
    InventoryItem,
    MerchandisingRecommendation,
    Merchant,
    PriceChange,
    Product,
    ProductCategory,
    Promotion,
    SalesTransaction,
    ShoppingList,
    ShoppingListItem,
    Store,
    StoreTask,
    TransactionItem,
)


def overview(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID], days: int) -> dict:
    now = datetime.now(UTC)
    today = now.date()
    since = now - timedelta(days=days)
    prev_since = since - timedelta(days=days)
    merchant = db.get(Merchant, merchant_id)

    total_products = db.scalar(select(func.count(Product.id)).where(Product.merchant_id == merchant_id,
                                                                    Product.status == "active")) or 0
    inv = db.execute(select(func.coalesce(func.sum(InventoryItem.quantity_on_hand), 0),
                            func.sum(case((InventoryItem.quantity_on_hand <= InventoryItem.reorder_point, 1), else_=0)),
                            func.sum(case((InventoryItem.quantity_on_hand <= 0, 1), else_=0)))
                     .where(InventoryItem.store_id.in_(store_ids))).one()
    expiring = db.scalar(select(func.count(InventoryBatch.id)).where(
        InventoryBatch.store_id.in_(store_ids), InventoryBatch.quantity_remaining > 0,
        InventoryBatch.status.in_(("active", "markdown", "clearance")), InventoryBatch.expiry_date.is_not(None),
        InventoryBatch.expiry_date >= today, InventoryBatch.expiry_date <= today + timedelta(days=3))) or 0
    risk_counts = {"high": 0, "medium": 0}
    for sid in store_ids:
        run = db.scalars(select(ForecastRun).where(ForecastRun.store_id == sid, ForecastRun.status == "succeeded")
                         .order_by(ForecastRun.finished_at.desc())).first()
        if run:
            for lvl, n in db.execute(select(ForecastProductSummary.stockout_risk, func.count())
                                     .where(ForecastProductSummary.run_id == run.id,
                                            ForecastProductSummary.stockout_risk.in_(("high", "medium")))
                                     .group_by(ForecastProductSummary.stockout_risk)).all():
                risk_counts[lvl] += n
    active_promos = db.scalar(select(func.count(Promotion.id)).where(
        Promotion.merchant_id == merchant_id, Promotion.status == "active", Promotion.is_simulation.is_(False),
        (Promotion.store_id.is_(None)) | (Promotion.store_id.in_(store_ids)))) or 0
    pending_prices = db.scalar(select(func.count(PriceChange.id)).where(
        PriceChange.merchant_id == merchant_id, PriceChange.store_id.in_(store_ids),
        PriceChange.status.in_(("RECOMMENDED", "PENDING_APPROVAL")))) or 0
    pending_merch = db.scalar(select(func.count(MerchandisingRecommendation.id)).where(
        MerchandisingRecommendation.merchant_id == merchant_id, MerchandisingRecommendation.store_id.in_(store_ids),
        MerchandisingRecommendation.status == "proposed")) or 0
    flagged = db.scalar(select(func.count(FraudAlert.id)).where(
        FraudAlert.merchant_id == merchant_id, FraudAlert.status.in_(("open", "in_review", "escalated")),
        (FraudAlert.store_id.is_(None)) | (FraudAlert.store_id.in_(store_ids)))) or 0
    open_tasks = db.scalar(select(func.count(StoreTask.id)).where(StoreTask.store_id.in_(store_ids),
                                                                  StoreTask.status == "open")) or 0

    def revenue(a: datetime, b: datetime) -> tuple[float, int]:
        r = db.execute(select(func.coalesce(func.sum(case((SalesTransaction.transaction_type == "sale", SalesTransaction.total),
                                                          else_=-SalesTransaction.total)), 0), func.count(SalesTransaction.id))
                       .where(SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= a,
                              SalesTransaction.occurred_at < b)).one()
        return float(r[0] or 0), int(r[1] or 0)

    rev, txn_count = revenue(since, now)
    prev_rev, _ = revenue(prev_since, since)
    day_col = func.date(SalesTransaction.occurred_at)
    trend_rows = db.execute(select(day_col, func.sum(case((SalesTransaction.transaction_type == "sale", SalesTransaction.total),
                                                          else_=0)),
                                   func.sum(case((SalesTransaction.transaction_type == "sale", 1), else_=0)),
                                   func.sum(case((SalesTransaction.transaction_type == "return", SalesTransaction.total), else_=0)))
                            .where(SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since)
                            .group_by(day_col).order_by(day_col)).all()
    trend = [{"date": str(d), "revenue": round(float(r or 0), 2), "transactions": int(t or 0),
              "returns": round(float(rt or 0), 2)} for d, r, t, rt in trend_rows]
    cat_rows = db.execute(select(ProductCategory.name, func.sum(TransactionItem.line_total))
                          .join(Product, Product.id == TransactionItem.product_id)
                          .join(ProductCategory, ProductCategory.id == Product.category_id)
                          .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
                          .where(SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since,
                                 SalesTransaction.transaction_type == "sale")
                          .group_by(ProductCategory.name).order_by(func.sum(TransactionItem.line_total).desc())).all()
    top_rows = db.execute(select(Product.id, Product.name, func.sum(TransactionItem.quantity), func.sum(TransactionItem.line_total))
                          .join(Product, Product.id == TransactionItem.product_id)
                          .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
                          .where(SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since,
                                 SalesTransaction.transaction_type == "sale")
                          .group_by(Product.id, Product.name).order_by(func.sum(TransactionItem.line_total).desc()).limit(8)).all()

    alerts = []
    for a in db.scalars(select(ExpiryAlert).where(ExpiryAlert.store_id.in_(store_ids), ExpiryAlert.status == "open",
                                                  ExpiryAlert.severity.in_(("critical", "expired")))
                        .order_by(ExpiryAlert.hours_to_expiry).limit(5)):
        alerts.append({"kind": "expiry", "severity": a.severity, "title": a.message, "link": "/merchant/expiry"})
    for f in db.scalars(select(FraudAlert).where(FraudAlert.merchant_id == merchant_id, FraudAlert.status == "open",
                                                 FraudAlert.risk_level == "high").order_by(FraudAlert.risk_score.desc()).limit(3)):
        alerts.append({"kind": "fraud", "severity": "high", "title": f"Review {f.subject_ref}: {f.summary[:90]}",
                       "link": f"/merchant/fraud?alert={f.id}"})
    for pc in db.scalars(select(PriceChange).where(PriceChange.merchant_id == merchant_id, PriceChange.status == "FAILED").limit(3)):
        alerts.append({"kind": "pricing", "severity": "warning",
                       "title": f"Price publication failed: {pc.product.name} ({pc.failure_reason})",
                       "link": f"/merchant/pricing?change={pc.id}"})
    if risk_counts["high"]:
        alerts.append({"kind": "stockout", "severity": "warning",
                       "title": f"{risk_counts['high']} products at high stockout risk", "link": "/merchant/forecasting"})

    return {
        "is_demo_data": bool(merchant.is_demo),
        "window_days": days,
        "kpis": {
            "total_products": int(total_products), "total_stock_units": int(inv[0] or 0),
            "low_stock_products": int(inv[1] or 0), "out_of_stock_products": int(inv[2] or 0),
            "expiring_batches_3d": int(expiring), "stockout_risk_high": risk_counts["high"],
            "stockout_risk_medium": risk_counts["medium"], "active_promotions": int(active_promos),
            "pending_price_recommendations": int(pending_prices), "pending_merchandising_recommendations": int(pending_merch),
            "flagged_transactions": int(flagged), "open_store_tasks": int(open_tasks),
            "net_revenue": round(rev, 2), "transactions": txn_count,
            "net_revenue_previous_period": round(prev_rev, 2),
            "revenue_change_pct": round((rev - prev_rev) / prev_rev * 100, 1) if prev_rev else None,
        },
        "sales_trend": trend,
        "category_revenue": [{"category": c, "revenue": round(float(v or 0), 2)} for c, v in cat_rows],
        "top_products": [{"product_id": str(i), "name": n, "units": int(q or 0), "revenue": round(float(r or 0), 2)}
                         for i, n, q, r in top_rows],
        "alerts": alerts,
    }


def customer_insights(db: Session, merchant_id: uuid.UUID, store_ids: list[uuid.UUID], days: int) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)
    dow_rows = db.execute(select(SalesTransaction.occurred_at).where(
        SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since,
        SalesTransaction.transaction_type == "sale")).scalars().all()
    stores = {s.id: s for s in db.scalars(select(Store).where(Store.id.in_(store_ids)))}
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(next(iter(stores.values())).timezone) if stores else UTC
    heat = Counter()
    for ts in dow_rows:
        local = ts.astimezone(tz)
        heat[(local.weekday(), local.hour)] += 1
    channel = db.execute(select(SalesTransaction.channel, func.count()).where(
        SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since,
        SalesTransaction.transaction_type == "sale").group_by(SalesTransaction.channel)).all()
    basket = db.execute(select(SalesTransaction.item_count, func.count()).where(
        SalesTransaction.store_id.in_(store_ids), SalesTransaction.occurred_at >= since,
        SalesTransaction.transaction_type == "sale").group_by(SalesTransaction.item_count)
        .order_by(SalesTransaction.item_count)).all()
    lists = db.scalars(select(ShoppingList).where(ShoppingList.store_id.in_(store_ids))).all()
    list_ids = [sl.id for sl in lists]
    unresolved = Counter()
    added = Counter()
    if list_ids:
        for it in db.scalars(select(ShoppingListItem).where(ShoppingListItem.list_id.in_(list_ids))):
            if it.status == "unresolved":
                unresolved[it.raw_text.lower()] += 1
            elif it.product_id:
                added[it.display_name] += 1
    return {
        "window_days": days,
        "traffic_heatmap": [{"dow": d, "hour": h, "transactions": n} for (d, h), n in sorted(heat.items())],
        "channel_mix": [{"channel": c, "transactions": int(n)} for c, n in channel],
        "basket_size_distribution": [{"items": int(i), "transactions": int(n)} for i, n in basket],
        "shopping_lists": {"total": len(lists), "shared": sum(1 for sl in lists if sl.is_shared),
                           "completed": sum(1 for sl in lists if sl.status == "completed")},
        "catalog_gaps": [{"query": q, "count": n} for q, n in unresolved.most_common(10)],
        "most_listed_products": [{"name": q, "count": n} for q, n in added.most_common(10)],
        "privacy_note": "Aggregated and anonymised; individual shopper behaviour is not shown.",
    }
