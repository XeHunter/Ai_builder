"""Background job handlers. Each receives a session and the JobRun; the return value is stored as the result."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.embeddings.service import reindex_products
from app.ai.visual_search.service import reindex_images
from app.db.models import AffinityRun, ForecastRun, ImportJob, JobRun, Store, User
from app.services import (
    cross_selling_service,
    expiry_service,
    forecasting_service,
    fraud_service,
    inventory_service,
    merchandising_service,
    pricing_service,
)
from app.tasks.queue import job_handler


def _actor(db: Session, job: JobRun) -> User | None:
    return db.get(User, job.created_by_id) if job.created_by_id else None


@job_handler("inventory_import_commit")
def _import(db: Session, job: JobRun) -> dict:
    imp = db.get(ImportJob, uuid.UUID(job.payload["import_id"]))
    imp = inventory_service.commit_import(db, imp, _actor(db, job))
    # new stock may change expiry exposure immediately
    expiry_service.evaluate_merchant(db, imp.merchant_id)
    return {"import_id": str(imp.id), "status": imp.status, "summary": imp.summary}


@job_handler("expiry_reevaluation")
def _expiry(db: Session, job: JobRun) -> dict:
    return expiry_service.evaluate_merchant(db, job.merchant_id, _actor(db, job))


@job_handler("forecast_run")
def _forecast(db: Session, job: JobRun) -> dict:
    run = db.get(ForecastRun, uuid.UUID(job.payload["run_id"]))
    try:
        run = forecasting_service.run_forecast(db, run)
    except Exception as exc:
        db.rollback()
        run = db.get(ForecastRun, run.id)
        run.status, run.error = "failed", str(exc)[:2000]
        db.commit()
        raise
    return {"run_id": str(run.id), "status": run.status, "metrics": run.metrics}


def _forecast_all(db: Session, job: JobRun, horizon: int | None = None) -> dict:
    settings = pricing_service.merchant_settings(db, job.merchant_id)
    out = []
    for store in db.scalars(select(Store).where(Store.merchant_id == job.merchant_id, Store.is_active.is_(True))):
        run = forecasting_service.create_run(db, merchant_id=job.merchant_id, store_id=store.id,
                                             horizon_days=horizon or settings.forecast_horizon_days, history_days=120,
                                             actor_id=None, params={"scheduled": True})
        run.job_id = job.id
        forecasting_service.run_forecast(db, run)
        out.append({"store": store.code, "run_id": str(run.id), "high_risk": run.metrics.get("high_risk")})
    return {"runs": out}


@job_handler("forecast_refresh")
def _forecast_refresh(db: Session, job: JobRun) -> dict:
    return _forecast_all(db, job)


@job_handler("stockout_risk_refresh")
def _stockout(db: Session, job: JobRun) -> dict:
    return _forecast_all(db, job, horizon=7)


@job_handler("affinity_run")
def _affinity(db: Session, job: JobRun) -> dict:
    run = db.get(AffinityRun, uuid.UUID(job.payload["run_id"]))
    run = cross_selling_service.run_affinity(db, run)
    return {"run_id": str(run.id), "status": run.status, "rules": run.rules_found, "error": run.error}


@job_handler("analytics_refresh")
def _analytics(db: Session, job: JobRun) -> dict:
    run = AffinityRun(merchant_id=job.merchant_id, store_id=None, window_days=90, min_support=0.005,
                      min_confidence=0.1, min_pair_count=20)
    db.add(run)
    db.commit()
    cross_selling_service.run_affinity(db, run)
    recs = 0
    for store in db.scalars(select(Store).where(Store.merchant_id == job.merchant_id)):
        recs += len(merchandising_service.generate(db, store))
    return {"affinity_run": str(run.id), "rules": run.rules_found, "merchandising_recommendations": recs}


@job_handler("promotion_lifecycle")
def _promos(db: Session, job: JobRun) -> dict:
    res = pricing_service.promotion_lifecycle(db, job.merchant_id)
    db.commit()
    return res


@job_handler("fraud_scan")
def _fraud(db: Session, job: JobRun) -> dict:
    return fraud_service.scan(db, job.merchant_id, days=int(job.payload.get("days", 30)))


@job_handler("embedding_reindex")
def _reindex(db: Session, job: JobRun) -> dict:
    res = reindex_products(db, job.merchant_id, force=bool(job.payload.get("force")))
    res["images"] = reindex_images(db, job.merchant_id)
    return res
