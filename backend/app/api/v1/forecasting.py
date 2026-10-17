"""Demand forecasting runs and results."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import MerchantContext, get_store_scoped, require_permission, resolve_store_ids
from app.core.exceptions import NotFoundError
from app.db.models import ForecastProductSummary, ForecastResult, ForecastRun, Store
from app.db.session import get_db
from app.services import forecasting_service
from app.services.sales_stats import daily_sales_frame
from app.tasks.queue import enqueue

router = APIRouter(prefix="/merchant/forecasts", tags=["forecasting"])


class RunCreate(BaseModel):
    store_id: uuid.UUID
    horizon_days: int = Field(default=14, ge=1, le=60)
    history_days: int = Field(default=120, ge=35, le=730)
    model: str | None = Field(default=None, pattern="^(seasonal_naive|weather_ridge)$")


def _run_out(db: Session, r: ForecastRun) -> dict:
    store = db.get(Store, r.store_id)
    return {"id": str(r.id), "store_id": str(r.store_id), "store_code": store.code, "status": r.status,
            "model_name": r.model_name, "horizon_days": r.horizon_days, "history_days": r.history_days,
            "backtest_days": r.backtest_days, "metrics": r.metrics or {}, "weather_source": r.weather_source,
            "error": r.error, "params": r.params or {}, "created_at": r.created_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


@router.post("", status_code=status.HTTP_202_ACCEPTED)
def create(body: RunCreate, ctx: MerchantContext = Depends(require_permission("forecast.run")),
           db: Session = Depends(get_db)) -> dict:
    """Queue a forecast run (background job). Poll GET /merchant/forecasts/{id} for the result."""
    store = get_store_scoped(db, ctx, body.store_id)
    run = forecasting_service.create_run(db, merchant_id=ctx.merchant_id, store_id=store.id,
                                         horizon_days=body.horizon_days, history_days=body.history_days,
                                         actor_id=ctx.user.id, params={"model": body.model} if body.model else {})
    job = enqueue(db, "forecast_run", {"run_id": str(run.id)}, merchant_id=ctx.merchant_id, created_by_id=ctx.user.id,
                  max_attempts=1)
    run.job_id = job.id
    db.commit()
    db.refresh(run)
    return {**_run_out(db, run), "job_id": str(job.id)}


@router.get("")
def list_runs(store_id: uuid.UUID | None = None, ctx: MerchantContext = Depends(require_permission("forecast.read")),
              db: Session = Depends(get_db)) -> list[dict]:
    store_ids = resolve_store_ids(db, ctx, store_id)
    rows = db.scalars(select(ForecastRun).where(ForecastRun.store_id.in_(store_ids))
                      .order_by(ForecastRun.created_at.desc()).limit(30)).all()
    return [_run_out(db, r) for r in rows]


def _owned(db: Session, ctx: MerchantContext, run_id: uuid.UUID) -> ForecastRun:
    r = db.get(ForecastRun, run_id)
    if r is None or r.merchant_id != ctx.merchant_id:
        raise NotFoundError("Forecast run not found")
    get_store_scoped(db, ctx, r.store_id)
    return r


@router.get("/{run_id}")
def get_run(run_id: uuid.UUID, risk: str | None = Query(None, pattern="^(none|low|medium|high)$"),
            ctx: MerchantContext = Depends(require_permission("forecast.read")), db: Session = Depends(get_db)) -> dict:
    r = _owned(db, ctx, run_id)
    stmt = select(ForecastProductSummary).where(ForecastProductSummary.run_id == r.id)
    if risk:
        stmt = stmt.where(ForecastProductSummary.stockout_risk == risk)
    order = {"high": 0, "medium": 1, "low": 2, "none": 3}
    sums = sorted(db.scalars(stmt).all(), key=lambda s: (order[s.stockout_risk], -(s.horizon_total or 0)))
    return {**_run_out(db, r), "products": [{
        "product_id": str(s.product_id), "name": s.product.name, "sku": s.product.sku, "model_used": s.model_used,
        "horizon_total": s.horizon_total, "avg_daily_history": s.avg_daily_history, "current_stock": s.current_stock,
        "days_of_cover": s.days_of_cover, "stockout_date": s.stockout_date.isoformat() if s.stockout_date else None,
        "stockout_risk": s.stockout_risk, "overstock": s.overstock, "recommended_reorder_qty": s.recommended_reorder_qty,
        "mae": s.mae, "rmse": s.rmse, "baseline_mae": s.baseline_mae, "explanation": s.explanation,
        "drivers": s.drivers} for s in sums]}


@router.get("/{run_id}/products/{product_id}")
def product_series(run_id: uuid.UUID, product_id: uuid.UUID, history_days: int = Query(56, ge=7, le=365),
                   ctx: MerchantContext = Depends(require_permission("forecast.read")), db: Session = Depends(get_db)) -> dict:
    """Observed daily sales (actuals) and the forecast with its interval, kept as separate series."""
    r = _owned(db, ctx, run_id)
    summ = db.scalars(select(ForecastProductSummary).where(ForecastProductSummary.run_id == r.id,
                                                           ForecastProductSummary.product_id == product_id)).first()
    if summ is None:
        raise NotFoundError("Product not in this forecast run")
    end = (r.started_at or datetime.now(UTC)).date() - timedelta(days=1)
    start = end - timedelta(days=history_days - 1)
    frame = daily_sales_frame(db, r.store_id, start, end, [product_id])
    from app.services import weather_service

    store = db.get(Store, r.store_id)
    weather = weather_service.weather_frame(db, store, start, end + timedelta(days=r.horizon_days + 1))
    actual = [{"date": d.isoformat(), "units": float(u), "precipitation_mm": weather[d].precipitation_mm if d in weather else None}
              for d, u in zip(frame["date"], frame["units"], strict=True)] if len(frame) else []
    fc = db.scalars(select(ForecastResult).where(ForecastResult.run_id == r.id, ForecastResult.product_id == product_id)
                    .order_by(ForecastResult.date)).all()
    return {"product_id": str(product_id), "name": summ.product.name, "actual": actual,
            "forecast": [{"date": f.date.isoformat(), "predicted": f.predicted, "lower": f.lower, "upper": f.upper,
                          "precipitation_mm": weather[f.date].precipitation_mm if f.date in weather else None,
                          "weather_source": weather[f.date].source if f.date in weather else None} for f in fc],
            "summary": {"model_used": summ.model_used, "mae": summ.mae, "rmse": summ.rmse, "baseline_mae": summ.baseline_mae,
                        "explanation": summ.explanation, "drivers": summ.drivers, "stockout_risk": summ.stockout_risk,
                        "recommended_reorder_qty": summ.recommended_reorder_qty}}
