"""Demand forecasting models and evaluation (pure NumPy / scikit-learn, no database access).

Models
* ``seasonal_naive`` - deterministic baseline: mean of the last 4 same-weekday observations.
* ``weather_ridge`` - scikit-learn Ridge regression on weekday dummies, trend, precipitation,
  rain flag, max temperature and holiday flag. Used only when there is enough history.

Selection: each product is backtested on its final ``backtest_days`` (fit on the earlier part,
forecast the hold-out using the *observed* weather of those days); the model with the lower MAE is
refit on the full history and used for the horizon. Both MAEs are reported so the improvement over
the baseline is measurable. Note: backtests use observed weather, so live accuracy also depends on
weather-forecast accuracy.

Prediction intervals are approximate 80% bands from the residual standard deviation (±1.28σ),
clipped at zero. They assume roughly normal, homoscedastic errors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date

import numpy as np
from sklearn.linear_model import Ridge

Z80 = 1.2816
MIN_HISTORY_FOR_RIDGE = 42
MIN_MEAN_FOR_RIDGE = 0.4


@dataclass
class SeriesInput:
    history: np.ndarray  # units per day
    hist_dates: list[date]
    hist_exog: np.ndarray  # (N, 4): precip_mm, rain_flag, temp_max, holiday
    future_dates: list[date]
    future_exog: np.ndarray  # (H, 4)


@dataclass
class ForecastOutput:
    model: str
    mean: np.ndarray
    lower: np.ndarray
    upper: np.ndarray
    residual_std: float
    extras: dict = field(default_factory=dict)


def _dow(dates: list[date]) -> np.ndarray:
    return np.array([d.weekday() for d in dates])


def seasonal_naive(s: SeriesInput) -> ForecastOutput:
    y = s.history
    dows = _dow(s.hist_dates)
    fut = _dow(s.future_dates)
    overall = float(y[-28:].mean()) if len(y) else 0.0
    mean = []
    for d in fut:
        vals = y[dows == d][-4:]
        mean.append(float(vals.mean()) if len(vals) else overall)
    mean_arr = np.asarray(mean)
    # in-sample one-step residuals of the same rule over the last 28 days
    res = []
    for i in range(max(28, len(y) - 28), len(y)):
        prev = y[:i][dows[:i] == dows[i]][-4:]
        if len(prev):
            res.append(y[i] - prev.mean())
    sd = float(np.std(res)) if res else float(np.std(y)) if len(y) else 0.0
    return ForecastOutput("seasonal_naive", mean_arr, np.clip(mean_arr - Z80 * sd, 0, None), mean_arr + Z80 * sd, sd)


def _design(dates: list[date], exog: np.ndarray, t0: int, n_ref: int) -> np.ndarray:
    dows = _dow(dates)
    onehot = np.eye(7)[dows]
    trend = (np.arange(len(dates)) + t0) / max(n_ref, 1)
    return np.column_stack([onehot, trend, exog])


def weather_ridge(s: SeriesInput, alpha: float = 1.0) -> ForecastOutput:
    n = len(s.history)
    X = _design(s.hist_dates, s.hist_exog, 0, n)
    model = Ridge(alpha=alpha)
    model.fit(X, s.history)
    fitted = model.predict(X)
    sd = float(np.std(s.history - fitted))
    Xf = _design(s.future_dates, s.future_exog, n, n)
    mean = np.clip(model.predict(Xf), 0, None)
    coefs = dict(zip(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "trend", "precip_mm", "rain_flag",
                      "temp_max", "holiday"], model.coef_.tolist(), strict=True))
    return ForecastOutput("weather_ridge", mean, np.clip(mean - Z80 * sd, 0, None), mean + Z80 * sd, sd,
                          {"coefficients": coefs})


MODELS = {"seasonal_naive": seasonal_naive, "weather_ridge": weather_ridge}


def ridge_eligible(y: np.ndarray) -> bool:
    return len(y) >= MIN_HISTORY_FOR_RIDGE and float(y.mean()) >= MIN_MEAN_FOR_RIDGE


def metrics(actual: np.ndarray, pred: np.ndarray) -> dict:
    err = actual - pred
    mae = float(np.mean(np.abs(err)))
    rmse = float(math.sqrt(np.mean(err**2)))
    denom = float(np.sum(np.abs(actual)))
    wape = float(np.sum(np.abs(err)) / denom) if denom > 0 else None
    return {"mae": round(mae, 3), "rmse": round(rmse, 3), "wape": None if wape is None else round(wape, 3)}


def backtest(s: SeriesInput, model: str, k: int) -> dict | None:
    n = len(s.history)
    if n <= k + 14:
        return None
    train = SeriesInput(s.history[: n - k], s.hist_dates[: n - k], s.hist_exog[: n - k],
                        s.hist_dates[n - k :], s.hist_exog[n - k :])
    if model == "weather_ridge" and not ridge_eligible(train.history):
        return None
    out = MODELS[model](train)
    m = metrics(s.history[n - k :], out.mean)
    m["actual"] = s.history[n - k :].tolist()
    m["predicted"] = [round(float(v), 2) for v in out.mean]
    return m


@dataclass
class ProductForecast:
    chosen: ForecastOutput
    backtests: dict[str, dict]
    rain_effect: dict | None


def forecast_product(s: SeriesInput, backtest_days: int = 14, force_model: str | None = None) -> ProductForecast:
    candidates = ["seasonal_naive"] + (["weather_ridge"] if ridge_eligible(s.history) else [])
    if force_model:
        candidates = [force_model] if force_model in candidates else ["seasonal_naive"]
    bts = {m: bt for m in candidates if (bt := backtest(s, m, backtest_days)) is not None}
    if bts:
        best = min(bts, key=lambda m: (bts[m]["mae"], m != "seasonal_naive"))
    else:
        best = candidates[0]
    out = MODELS[best](s)
    return ProductForecast(out, bts, rain_effect(s))


def rain_effect(s: SeriesInput, threshold_mm: float = 5.0) -> dict | None:
    """Observed association between rain days and sales in the history (descriptive, not causal)."""
    rain = s.hist_exog[:, 0] >= threshold_mm
    n_rain, n_dry = int(rain.sum()), int((~rain).sum())
    if n_rain < 5 or n_dry < 5:
        return None
    mr, md = float(s.history[rain].mean()), float(s.history[~rain].mean())
    return {"rain_days": n_rain, "dry_days": n_dry, "mean_rain": round(mr, 2), "mean_dry": round(md, 2),
            "ratio": round(mr / md, 2) if md > 0 else None}
