"""Forecast runs/results, product-affinity runs/rules and merchandising recommendations."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, Timestamps, UTCDateTime, UUIDPk


class ForecastRun(UUIDPk, Timestamps, Base):
    __tablename__ = "forecast_runs"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|succeeded|failed
    model_name: Mapped[str] = mapped_column(String(48))
    horizon_days: Mapped[int] = mapped_column(Integer)
    history_days: Mapped[int] = mapped_column(Integer)
    backtest_days: Mapped[int] = mapped_column(Integer, default=14)
    params: Mapped[dict] = mapped_column(default=dict)
    metrics: Mapped[dict] = mapped_column(default=dict)
    weather_source: Mapped[str | None] = mapped_column(String(24))
    error: Mapped[str | None] = mapped_column(Text)
    job_id: Mapped[uuid.UUID | None] = mapped_column()
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class ForecastResult(UUIDPk, Base):
    __tablename__ = "forecast_results"
    __table_args__ = (Index("ix_forecast_results_run_product", "run_id", "product_id"),)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forecast_runs.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    date: Mapped[date] = mapped_column(Date)
    predicted: Mapped[float] = mapped_column(Float)
    lower: Mapped[float] = mapped_column(Float)
    upper: Mapped[float] = mapped_column(Float)


class ForecastProductSummary(UUIDPk, Base):
    __tablename__ = "forecast_product_summaries"
    __table_args__ = (Index("ix_forecast_summ_run_product", "run_id", "product_id"),)
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("forecast_runs.id", ondelete="CASCADE"))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    model_used: Mapped[str] = mapped_column(String(48))
    horizon_total: Mapped[float] = mapped_column(Float)
    avg_daily_history: Mapped[float] = mapped_column(Float)
    current_stock: Mapped[int] = mapped_column(Integer)
    days_of_cover: Mapped[float | None] = mapped_column(Float)
    stockout_date: Mapped[date | None] = mapped_column(Date)
    stockout_risk: Mapped[str] = mapped_column(String(8))  # none|low|medium|high
    overstock: Mapped[bool] = mapped_column(Boolean, default=False)
    recommended_reorder_qty: Mapped[int] = mapped_column(Integer, default=0)
    mae: Mapped[float | None] = mapped_column(Float)
    rmse: Mapped[float | None] = mapped_column(Float)
    baseline_mae: Mapped[float | None] = mapped_column(Float)
    explanation: Mapped[str] = mapped_column(Text)
    drivers: Mapped[list] = mapped_column(default=list)

    product = relationship("Product", lazy="joined")


class AffinityRun(UUIDPk, Timestamps, Base):
    __tablename__ = "affinity_runs"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(16), default="queued")
    window_days: Mapped[int] = mapped_column(Integer, default=90)
    min_support: Mapped[float] = mapped_column(Float)
    min_confidence: Mapped[float] = mapped_column(Float)
    min_pair_count: Mapped[int] = mapped_column(Integer)
    transactions_analyzed: Mapped[int] = mapped_column(Integer, default=0)
    rules_found: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class AffinityRule(UUIDPk, Base):
    __tablename__ = "affinity_rules"
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("affinity_runs.id", ondelete="CASCADE"), index=True)
    antecedent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    consequent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    pair_count: Mapped[int] = mapped_column(Integer)
    support: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    lift: Mapped[float] = mapped_column(Float)
    antecedent_support: Mapped[float] = mapped_column(Float)
    consequent_support: Mapped[float] = mapped_column(Float)

    antecedent = relationship("Product", foreign_keys=[antecedent_id], lazy="joined")
    consequent = relationship("Product", foreign_keys=[consequent_id], lazy="joined")


class CategoryAffinity(UUIDPk, Base):
    __tablename__ = "category_affinities"
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("affinity_runs.id", ondelete="CASCADE"), index=True)
    category_a_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product_categories.id", ondelete="CASCADE"))
    category_b_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product_categories.id", ondelete="CASCADE"))
    pair_count: Mapped[int] = mapped_column(Integer)
    support: Mapped[float] = mapped_column(Float)
    lift: Mapped[float] = mapped_column(Float)


class MerchandisingRecommendation(UUIDPk, Timestamps, Base):
    __tablename__ = "merchandising_recommendations"
    merchant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("merchants.id", ondelete="CASCADE"), index=True)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), index=True)
    layout_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("store_layouts.id", ondelete="SET NULL"))
    # adjacency_test|endcap_test|eye_level_test|safety_relocation
    rec_type: Mapped[str] = mapped_column(String(32))
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    related_product_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    current_location_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("shelf_locations.id", ondelete="SET NULL"))
    proposed_location_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("shelf_locations.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String(200))
    rationale: Mapped[str] = mapped_column(Text)
    evidence: Mapped[dict] = mapped_column(default=dict)
    evidence_quality: Mapped[str] = mapped_column(String(8))  # low|medium|high
    expected_metric: Mapped[str] = mapped_column(String(255))
    implementation_steps: Mapped[list] = mapped_column(default=list)
    ab_test_plan: Mapped[dict] = mapped_column(default=dict)
    # proposed|accepted|rejected|implemented|completed
    status: Mapped[str] = mapped_column(String(16), default="proposed", index=True)
    implemented_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    outcome: Mapped[dict] = mapped_column(default=dict)
    affinity_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("affinity_runs.id", ondelete="SET NULL"))
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    review_note: Mapped[str | None] = mapped_column(Text)

    product = relationship("Product", foreign_keys=[product_id], lazy="joined")
    related_product = relationship("Product", foreign_keys=[related_product_id], lazy="joined")
    current_location = relationship("ShelfLocation", foreign_keys=[current_location_id], lazy="joined")
    proposed_location = relationship("ShelfLocation", foreign_keys=[proposed_location_id], lazy="joined")
