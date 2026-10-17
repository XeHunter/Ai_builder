"""Weather records for stores: historical (for model features) and forecasts (for planning).

Records are persisted in ``weather_records`` with their ``source`` so the UI can label simulated data.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.models import IntegrationConfig, Store, WeatherRecord
from app.integrations.weather.providers import (
    DayWeather,
    OpenWeatherMapProvider,
    SimulatedWeatherProvider,
    WeatherUnavailable,
)

log = get_logger(__name__)


def _simulated(db: Session, store: Store) -> SimulatedWeatherProvider:
    cfg = db.scalars(select(IntegrationConfig).where(IntegrationConfig.merchant_id == store.merchant_id,
                                                     IntegrationConfig.kind == "weather")).first()
    overrides = ((cfg.settings or {}).get("forecast_overrides", {}) if cfg else {}).get(store.code, {})
    return SimulatedWeatherProvider(overrides)


def _upsert(db: Session, store: Store, days: list[DayWeather], is_forecast: bool) -> None:
    existing = {
        r.date: r for r in db.scalars(select(WeatherRecord).where(
            WeatherRecord.store_id == store.id, WeatherRecord.is_forecast.is_(is_forecast),
            WeatherRecord.date.in_([d.date for d in days])))
    }
    now = datetime.now(UTC)
    for d in days:
        r = existing.get(d.date)
        if r is None:
            db.add(WeatherRecord(store_id=store.id, date=d.date, temp_max_c=d.temp_max_c, temp_min_c=d.temp_min_c,
                                 precipitation_mm=d.precipitation_mm, condition=d.condition, is_forecast=is_forecast,
                                 source=d.source, fetched_at=now))
        else:
            r.temp_max_c, r.temp_min_c, r.precipitation_mm = d.temp_max_c, d.temp_min_c, d.precipitation_mm
            r.condition, r.source, r.fetched_at = d.condition, d.source, now


def ensure_history(db: Session, store: Store, start: date, end: date) -> None:
    have = set(db.scalars(select(WeatherRecord.date).where(WeatherRecord.store_id == store.id,
                                                           WeatherRecord.is_forecast.is_(False),
                                                           WeatherRecord.date >= start, WeatherRecord.date <= end)))
    missing = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    missing = [d for d in missing if d not in have]
    if missing:
        sim = _simulated(db, store)
        _upsert(db, store, [sim.day(store.latitude, store.longitude, d) for d in missing], False)
        db.flush()


def refresh_forecast(db: Session, store: Store, days: int = 7, start: date | None = None) -> str:
    """Fetch the forecast from the configured provider; fall back to simulated data. Returns source used."""
    start = start or datetime.now(UTC).date()
    s = get_settings()
    result: list[DayWeather] | None = None
    if s.weather_provider == "openweathermap" and s.openweather_api_key:
        try:
            result = OpenWeatherMapProvider(s.openweather_api_key).forecast(store.latitude, store.longitude, start, days)
        except WeatherUnavailable as exc:
            log.warning("Weather provider unavailable for %s (%s); using simulated forecast", store.code, exc)
    if result is None:
        result = _simulated(db, store).forecast(store.latitude, store.longitude, start, days)
    _upsert(db, store, result, True)
    db.flush()
    return result[0].source if result else "simulated"


def weather_frame(db: Session, store: Store, start: date, end: date) -> dict[date, WeatherRecord]:
    """Observed weather for past dates and forecast weather for future dates."""
    today = datetime.now(UTC).date()
    rows = db.scalars(select(WeatherRecord).where(WeatherRecord.store_id == store.id,
                                                  WeatherRecord.date >= start, WeatherRecord.date <= end)).all()
    out: dict[date, WeatherRecord] = {}
    for r in rows:
        prefer_forecast = r.date >= today
        if r.date not in out or (r.is_forecast == prefer_forecast):
            out[r.date] = r
    return out


def forecast_view(db: Session, store: Store, days: int = 7) -> list[dict]:
    today = datetime.now(UTC).date()
    rows = db.scalars(select(WeatherRecord).where(WeatherRecord.store_id == store.id, WeatherRecord.is_forecast.is_(True),
                                                  WeatherRecord.date >= today,
                                                  WeatherRecord.date < today + timedelta(days=days))
                      .order_by(WeatherRecord.date)).all()
    return [{"date": r.date.isoformat(), "temp_max_c": r.temp_max_c, "temp_min_c": r.temp_min_c,
             "precipitation_mm": r.precipitation_mm, "condition": r.condition, "source": r.source} for r in rows]
