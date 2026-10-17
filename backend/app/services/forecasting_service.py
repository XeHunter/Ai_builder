"""Demand-forecast runs: data preparation, per-product model selection, stockout risk and reorders.

Pipeline (job ``forecast_run``):
1. Aggregate daily units per product from ``transaction_items`` (zero-filled) for ``history_days``.
2. Attach weather (observed history + forecast horizon) and calendar features.
3. For each product: backtest candidate models, pick the lower-MAE model, forecast the horizon.
4. Compare cumulative forecast with sellable stock: stockout date, days of cover, risk band,
   overstock flag and a reorder quantity with safety stock.
5. Persist results and summaries; notify staff about high stockout risks (deduplicated).
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, date, datetime, timedelta

import numpy as np
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.analytics.forecasting.calendar import is_holiday
from app.analytics.forecasting.models import SeriesInput, forecast_product
from app.core.exceptions import NotFoundError
from app.db.models import (
    ForecastProductSummary,
    ForecastResult,
    ForecastRun,
    InventoryItem,
    Product,
    Store,
)
from app.services import catalog_service, weather_service
from app.services.notification_service import notify_merchant_staff
from app.services.sales_stats import daily_sales_frame

LEAD_TIME_DAYS = 2
SERVICE_Z = 1.65


def _exog(dates: list[date], weather: dict) -> np.ndarray:
    rows = []
    for d in dates:
        w = weather.get(d)
        p = w.precipitation_mm if w else 0.0
        rows.append([p, 1.0 if p >= 5 else 0.0, w.temp_max_c if w else 31.0, 1.0 if is_holiday(d) else 0.0])
    return np.asarray(rows, dtype=float)


def run_forecast(db: Session, run: ForecastRun) -> ForecastRun:
    store = db.get(Store, run.store_id)
    if store is None:
        raise NotFoundError("Store not found")
    run.status, run.started_at, run.error = "running", datetime.now(UTC), None
    db.commit()
    today = datetime.now(UTC).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=run.history_days - 1)
    weather_service.ensure_history(db, store, start, end)
    source = weather_service.refresh_forecast(db, store, days=max(run.horizon_days, 7))
    weather = weather_service.weather_frame(db, store, start, today + timedelta(days=run.horizon_days))
    run.weather_source = source

    items = db.scalars(select(InventoryItem).where(InventoryItem.store_id == store.id)).all()
    product_ids = [i.product_id for i in items]
    if run.params.get("product_ids"):
        wanted = {uuid.UUID(p) for p in run.params["product_ids"]}
        product_ids = [p for p in product_ids if p in wanted]
    frame = daily_sales_frame(db, store.id, start, end, product_ids)
    hist_dates = [start + timedelta(days=i) for i in range(run.history_days)]
    fut_dates = [today + timedelta(days=i) for i in range(run.horizon_days)]
    hist_exog, fut_exog = _exog(hist_dates, weather), _exog(fut_dates, weather)
    stock = catalog_service.stock_snapshot(db, store.id, product_ids)
    products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_(product_ids)))}
    by_item = {i.product_id: i for i in items}

    db.execute(delete(ForecastResult).where(ForecastResult.run_id == run.id))
    db.execute(delete(ForecastProductSummary).where(ForecastProductSummary.run_id == run.id))
    grouped = {pid: g.sort_values("date")["units"].to_numpy() for pid, g in frame.groupby("product_id")} if len(frame) else {}
    agg = {"products": 0, "model_wins": {}, "mae": {}, "baseline_mae_total": 0.0, "chosen_mae_total": 0.0,
           "high_risk": 0, "medium_risk": 0}
    high_risk_names = []
    for pid in product_ids:
        y = grouped.get(pid, np.zeros(run.history_days))
        if len(y) != run.history_days:
            y = np.zeros(run.history_days)
        s = SeriesInput(y.astype(float), hist_dates, hist_exog, fut_dates, fut_exog)
        pf = forecast_product(s, run.backtest_days, run.params.get("model"))
        out = pf.chosen
        for d, m, lo, hi in zip(fut_dates, out.mean, out.lower, out.upper, strict=True):
            db.add(ForecastResult(run_id=run.id, product_id=pid, date=d, predicted=round(float(m), 3),
                                  lower=round(float(lo), 3), upper=round(float(hi), 3)))
        qty = int(stock.get(pid, {}).get("qty", 0))
        cum = np.cumsum(out.mean)
        idx = int(np.argmax(cum > qty)) if qty < cum[-1] else None
        stockout_date = fut_dates[idx] if idx is not None else None
        avg_hist = float(y[-28:].mean())
        daily_fc = float(out.mean.mean())
        cover = (qty / daily_fc) if daily_fc > 0 else None
        product = products[pid]
        # Fresh goods are replenished daily, so only a stockout today is "high" risk for them.
        high_cutoff = 0 if product.is_perishable else LEAD_TIME_DAYS
        if stockout_date is None:
            risk = "none"
        elif idx <= high_cutoff:
            risk = "high"
        elif idx <= 7:
            risk = "medium"
        else:
            risk = "low"
        overstock = bool(cover is not None and (cover > 60 or (product.is_perishable and cover > 10)) and qty > 10)
        safety = SERVICE_Z * out.residual_std * math.sqrt(LEAD_TIME_DAYS)
        horizon_need = float(cum[-1]) + safety
        reorder = max(0, int(math.ceil(horizon_need - qty))) if risk != "none" else 0
        item = by_item.get(pid)
        if reorder and item and item.reorder_quantity:
            reorder = int(math.ceil(reorder / item.reorder_quantity) * item.reorder_quantity)
        chosen_bt = pf.backtests.get(out.model, {})
        base_bt = pf.backtests.get("seasonal_naive", {})
        drivers, explanation = _explain(product, out, pf, qty, stockout_date, risk, fut_dates, fut_exog, source)
        db.add(ForecastProductSummary(
            run_id=run.id, product_id=pid, model_used=out.model, horizon_total=round(float(cum[-1]), 2),
            avg_daily_history=round(avg_hist, 3), current_stock=qty,
            days_of_cover=None if cover is None else round(cover, 1), stockout_date=stockout_date, stockout_risk=risk,
            overstock=overstock, recommended_reorder_qty=reorder, mae=chosen_bt.get("mae"), rmse=chosen_bt.get("rmse"),
            baseline_mae=base_bt.get("mae"), explanation=explanation, drivers=drivers))
        agg["products"] += 1
        agg["model_wins"][out.model] = agg["model_wins"].get(out.model, 0) + 1
        for m, bt in pf.backtests.items():
            agg["mae"].setdefault(m, []).append(bt["mae"])
        if base_bt:
            agg["baseline_mae_total"] += base_bt["mae"]
            agg["chosen_mae_total"] += chosen_bt.get("mae", base_bt["mae"])
        if risk == "high":
            agg["high_risk"] += 1
            high_risk_names.append(product.name)
        elif risk == "medium":
            agg["medium_risk"] += 1
    run.metrics = {
        "products": agg["products"],
        "model_wins": agg["model_wins"],
        "mean_mae_by_model": {m: round(float(np.mean(v)), 3) for m, v in agg["mae"].items()},
        "products_backtested_by_model": {m: len(v) for m, v in agg["mae"].items()},
        "selected_vs_baseline_mae": {"baseline": round(agg["baseline_mae_total"], 2),
                                     "selected": round(agg["chosen_mae_total"], 2)},
        "high_risk": agg["high_risk"], "medium_risk": agg["medium_risk"],
    }
    run.status, run.finished_at = "succeeded", datetime.now(UTC)
    if high_risk_names:
        notify_merchant_staff(db, store.merchant_id, "inventory.read", notification_type="stockout_alert",
                              title=f"{len(high_risk_names)} products at high stockout risk at {store.name}",
                              body=", ".join(high_risk_names[:6]) + ("…" if len(high_risk_names) > 6 else ""),
                              idempotency_key=f"stockout:{run.id}", link=f"/merchant/forecasting?run={run.id}")
    db.commit()
    return run


def _explain(product: Product, out, pf, qty: int, stockout_date: date | None, risk: str, fut_dates: list[date],
             fut_exog: np.ndarray, weather_source: str) -> tuple[list[dict], str]:
    drivers: list[dict] = []
    parts: list[str] = []
    total = float(out.mean.sum())
    parts.append(f"Forecast {total:.0f} units over {len(fut_dates)} days ({out.model.replace('_', ' ')}).")
    re_ = pf.rain_effect
    rainy = [(d, p) for d, p in zip(fut_dates, fut_exog[:, 0], strict=True) if p >= 5]
    coef = (out.extras.get("coefficients") or {}).get("rain_flag", 0) + 5 * (out.extras.get("coefficients") or {}).get("precip_mm", 0)
    if re_ and re_["ratio"] and re_["ratio"] >= 1.3 and out.model == "weather_ridge" and coef > 0 and rainy:
        label = "simulated" if weather_source == "simulated" else weather_source
        days_txt = ", ".join(d.strftime("%a %d %b") for d, _ in rainy[:3])
        parts.append(
            f"Rain is forecast on {days_txt} ({label} weather). Historically this product sold "
            f"{re_['mean_rain']:.1f}/day on {re_['rain_days']} rainy days vs {re_['mean_dry']:.1f}/day on dry days "
            f"— an association in past sales, not proof that rain causes the increase.")
        drivers.append({"driver": "rain", "evidence": re_, "forecast_rain_days": len(rainy), "weather_source": weather_source})
    if stockout_date:
        parts.append(f"Current sellable stock ({qty}) runs out around {stockout_date:%a %d %b}; risk {risk}.")
    else:
        parts.append(f"Current sellable stock ({qty}) covers the horizon.")
    bts = pf.backtests
    if "seasonal_naive" in bts and out.model in bts and out.model != "seasonal_naive":
        parts.append(f"Backtest MAE {bts[out.model]['mae']:.2f} vs baseline {bts['seasonal_naive']['mae']:.2f}.")
    drivers.append({"driver": "model", "model": out.model, "backtests": {k: {kk: vv for kk, vv in v.items()
                                                                            if kk in ('mae', 'rmse', 'wape')}
                                                                        for k, v in bts.items()}})
    return drivers, " ".join(parts)


def create_run(db: Session, *, merchant_id: uuid.UUID, store_id: uuid.UUID, horizon_days: int, history_days: int,
               actor_id: uuid.UUID | None, params: dict | None = None) -> ForecastRun:
    run = ForecastRun(merchant_id=merchant_id, store_id=store_id, status="queued", model_name="auto_select",
                      horizon_days=horizon_days, history_days=history_days, params=params or {},
                      created_by_id=actor_id)
    db.add(run)
    db.commit()
    return run


def latest_run(db: Session, store_id: uuid.UUID) -> ForecastRun | None:
    return db.scalars(select(ForecastRun).where(ForecastRun.store_id == store_id, ForecastRun.status == "succeeded")
                      .order_by(ForecastRun.finished_at.desc())).first()
