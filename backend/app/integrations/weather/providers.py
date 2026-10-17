"""Weather adapters.

* ``SimulatedWeatherProvider`` (default): deterministic synthetic weather derived from the store's
  coordinates and the date, with a Mumbai-like monsoon season. Optional ``forecast_overrides`` in the
  merchant's ``weather`` integration config inject a labelled demo scenario (e.g. weekend rain).
  Every record it produces has ``source='simulated'``.
* ``OpenWeatherMapProvider``: daily forecast via the One Call 3.0 API (requires OPENWEATHER_API_KEY).
  Failures raise ``WeatherUnavailable``; the weather service then falls back to simulated data and
  labels it as such. Not exercised by the automated tests (no credentials).
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from datetime import date, timedelta

import httpx

MONSOON_RAIN_PROB = {1: 0.03, 2: 0.03, 3: 0.04, 4: 0.06, 5: 0.15, 6: 0.7, 7: 0.85, 8: 0.8, 9: 0.6, 10: 0.3,
                     11: 0.1, 12: 0.04}
BASE_TEMP = {1: 30, 2: 31, 3: 33, 4: 33, 5: 34, 6: 32, 7: 30, 8: 30, 9: 31, 10: 33, 11: 33, 12: 31}


class WeatherUnavailable(RuntimeError):
    pass


@dataclass
class DayWeather:
    date: date
    temp_max_c: float
    temp_min_c: float
    precipitation_mm: float
    condition: str
    source: str


def classify(precip_mm: float) -> str:
    if precip_mm >= 30:
        return "heavy_rain"
    if precip_mm >= 5:
        return "rain"
    if precip_mm >= 0.5:
        return "cloudy"
    return "clear"


def _u(seed: str) -> float:
    return int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big") / 2**64


class SimulatedWeatherProvider:
    name = "simulated"

    def __init__(self, overrides: dict | None = None) -> None:
        self.overrides = overrides or {}

    def day(self, lat: float, lon: float, d: date) -> DayWeather:
        key = f"{lat:.2f}:{lon:.2f}:{d.isoformat()}"
        if d.isoformat() in self.overrides:
            o = self.overrides[d.isoformat()]
            p = float(o.get("precipitation_mm", 0))
            return DayWeather(d, float(o.get("temp_max_c", 29)), float(o.get("temp_min_c", 24)), p,
                              o.get("condition", classify(p)), "simulated")
        rain = _u(key + ":r") < MONSOON_RAIN_PROB[d.month]
        precip = 0.0
        if rain:
            # heavy-tailed rainfall amount: 2-70 mm
            precip = round(2 + 68 * _u(key + ":a") ** 2.2, 1)
        t = BASE_TEMP[d.month] + 2.5 * math.sin(d.timetuple().tm_yday / 7.0) * 0.4 + (_u(key + ":t") - 0.5) * 3
        t -= min(precip / 10, 4)
        return DayWeather(d, round(t, 1), round(t - 6 - _u(key + ":m") * 2, 1), precip, classify(precip), "simulated")

    def history(self, lat: float, lon: float, start: date, end: date) -> list[DayWeather]:
        return [self.day(lat, lon, start + timedelta(days=i)) for i in range((end - start).days + 1)]

    def forecast(self, lat: float, lon: float, start: date, days: int) -> list[DayWeather]:
        return [self.day(lat, lon, start + timedelta(days=i)) for i in range(days)]


class OpenWeatherMapProvider:
    name = "openweathermap"

    def __init__(self, api_key: str, timeout: float = 10.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    def forecast(self, lat: float, lon: float, start: date, days: int) -> list[DayWeather]:
        try:
            r = httpx.get("https://api.openweathermap.org/data/3.0/onecall",
                          params={"lat": lat, "lon": lon, "exclude": "current,minutely,hourly,alerts",
                                  "units": "metric", "appid": self.api_key}, timeout=self.timeout)
            r.raise_for_status()
            out = []
            for d in r.json().get("daily", [])[:days]:
                dt = date.fromtimestamp(d["dt"])
                precip = float(d.get("rain", 0.0))
                out.append(DayWeather(dt, float(d["temp"]["max"]), float(d["temp"]["min"]), precip, classify(precip),
                                      "openweathermap"))
            if not out:
                raise WeatherUnavailable("empty forecast")
            return out
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            raise WeatherUnavailable(str(exc)) from exc
