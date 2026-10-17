"""Shared sales aggregates computed from transaction records."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import SalesTransaction, TransactionItem


def daily_velocity(db: Session, store_id: uuid.UUID, product_ids: list[uuid.UUID] | None = None,
                   days: int = 14) -> dict[uuid.UUID, float]:
    """Average units sold per day over the trailing window (net of nothing; returns are separate)."""
    since = datetime.now(UTC) - timedelta(days=days)
    stmt = (
        select(TransactionItem.product_id, func.sum(TransactionItem.quantity))
        .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
        .where(SalesTransaction.store_id == store_id, SalesTransaction.transaction_type == "sale",
               SalesTransaction.occurred_at >= since)
        .group_by(TransactionItem.product_id)
    )
    if product_ids is not None:
        stmt = stmt.where(TransactionItem.product_id.in_(product_ids))
    return {pid: float(q or 0) / days for pid, q in db.execute(stmt).all()}


def daily_sales_frame(db: Session, store_id: uuid.UUID, start: date, end: date,
                      product_ids: list[uuid.UUID] | None = None) -> pd.DataFrame:
    """Units sold per (product, day) with zero-filled gaps. Columns: product_id, date, units."""
    start_dt = datetime(start.year, start.month, start.day, tzinfo=UTC)
    end_dt = datetime(end.year, end.month, end.day, tzinfo=UTC) + timedelta(days=1)
    stmt = (
        select(TransactionItem.product_id, SalesTransaction.occurred_at, TransactionItem.quantity)
        .join(SalesTransaction, SalesTransaction.id == TransactionItem.transaction_id)
        .where(SalesTransaction.store_id == store_id, SalesTransaction.transaction_type == "sale",
               SalesTransaction.occurred_at >= start_dt, SalesTransaction.occurred_at < end_dt)
    )
    if product_ids is not None:
        stmt = stmt.where(TransactionItem.product_id.in_(product_ids))
    rows = db.execute(stmt).all()
    days = pd.date_range(start, end, freq="D").date
    if not rows:
        return pd.DataFrame(columns=["product_id", "date", "units"])
    df = pd.DataFrame(rows, columns=["product_id", "occurred_at", "units"])
    df["date"] = pd.to_datetime(df["occurred_at"], utc=True).dt.date
    agg = df.groupby(["product_id", "date"], as_index=False)["units"].sum()
    pids = product_ids if product_ids is not None else agg["product_id"].unique().tolist()
    full = pd.MultiIndex.from_product([pids, days], names=["product_id", "date"]).to_frame(index=False)
    out = full.merge(agg, on=["product_id", "date"], how="left").fillna({"units": 0})
    out["units"] = out["units"].astype(float)
    return out
