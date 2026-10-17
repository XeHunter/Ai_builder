/** Types for /merchant/forecasts (backend/app/api/v1/forecasting.py). */

export type Risk = "high" | "medium" | "low" | "none";
export type ModelName = "seasonal_naive" | "weather_ridge" | string;

export interface ForecastMetrics {
  products?: number;
  model_wins?: Record<string, number>;
  mean_mae_by_model?: Record<string, number>;
  products_backtested_by_model?: Record<string, number>;
  selected_vs_baseline_mae?: { baseline: number; selected: number };
  high_risk?: number;
  medium_risk?: number;
}

export interface ForecastRun {
  id: string;
  store_id: string;
  store_code: string;
  status: "queued" | "running" | "succeeded" | "failed";
  model_name: string;
  horizon_days: number;
  history_days: number;
  backtest_days: number;
  metrics: ForecastMetrics;
  weather_source: string | null;
  error: string | null;
  params: { model?: string; scheduled?: boolean; [k: string]: unknown };
  created_at: string;
  finished_at: string | null;
  job_id?: string;
}

export interface Driver {
  driver: "model" | "rain" | string;
  model?: string;
  backtests?: Record<string, { mae: number; rmse: number; wape: number | null }>;
  evidence?: { rain_days: number; dry_days: number; mean_rain: number; mean_dry: number; ratio: number | null };
  forecast_rain_days?: number;
  weather_source?: string;
}

export interface ProductSummary {
  product_id: string;
  name: string;
  sku: string;
  model_used: ModelName;
  horizon_total: number;
  avg_daily_history: number;
  current_stock: number;
  days_of_cover: number | null;
  stockout_date: string | null;
  stockout_risk: Risk;
  overstock: boolean;
  recommended_reorder_qty: number;
  mae: number | null;
  rmse: number | null;
  baseline_mae: number | null;
  explanation: string;
  drivers: Driver[];
}

export interface ForecastRunDetail extends ForecastRun {
  products: ProductSummary[];
}

export interface ProductSeries {
  product_id: string;
  name: string;
  actual: { date: string; units: number; precipitation_mm: number | null }[];
  forecast: { date: string; predicted: number; lower: number; upper: number; precipitation_mm: number | null; weather_source: string | null }[];
  summary: {
    model_used: ModelName;
    mae: number | null;
    rmse: number | null;
    baseline_mae: number | null;
    explanation: string;
    drivers: Driver[];
    stockout_risk: Risk;
    recommended_reorder_qty: number;
  };
}

export const MODEL_LABEL: Record<string, string> = {
  seasonal_naive: "Seasonal naive",
  weather_ridge: "Weather ridge",
};

export const RISK_ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2, none: 3 };
