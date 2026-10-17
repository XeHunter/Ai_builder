import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MerchantStoreProvider } from "@/hooks/use-stores";
import { merchantMe, mockApi, renderWithProviders } from "@/tests/test-utils";

import { buildChartRows } from "./ForecastChart";
import ForecastingPage, { forecastSchema } from "./ForecastingPage";
import type { ProductSummary } from "./types";

const run = {
  id: "r1", store_id: "s1", store_code: "AND01", status: "succeeded", model_name: "auto_select", horizon_days: 14,
  history_days: 120, backtest_days: 14, weather_source: "simulated", error: null, params: {},
  created_at: "2026-10-16T10:00:00Z", finished_at: "2026-10-16T10:00:05Z",
  metrics: {
    products: 3, model_wins: { weather_ridge: 2, seasonal_naive: 1 }, mean_mae_by_model: { seasonal_naive: 3.1, weather_ridge: 2.7 },
    products_backtested_by_model: { seasonal_naive: 3, weather_ridge: 2 }, selected_vs_baseline_mae: { baseline: 10, selected: 8 },
    high_risk: 1, medium_risk: 1,
  },
};

const product = (name: string, risk: ProductSummary["stockout_risk"], total: number): ProductSummary => ({
  product_id: name, name, sku: name.toUpperCase(), model_used: "weather_ridge", horizon_total: total, avg_daily_history: 2,
  current_stock: 10, days_of_cover: 3, stockout_date: risk === "none" ? null : "2026-10-18", stockout_risk: risk, overstock: false,
  recommended_reorder_qty: 20, mae: 1, rmse: 1.2, baseline_mae: 1.4, explanation: "", drivers: [],
});

describe("forecast schema", () => {
  it("enforces the API bounds", () => {
    expect(forecastSchema.safeParse({ store_id: "s1", horizon_days: 61, history_days: 120, model: "" }).success).toBe(false);
    expect(forecastSchema.safeParse({ store_id: "s1", horizon_days: 14, history_days: 30, model: "" }).success).toBe(false);
    expect(forecastSchema.safeParse({ store_id: "s1", horizon_days: 14, history_days: 120, model: "weather_ridge" }).success).toBe(true);
  });
});

describe("buildChartRows", () => {
  it("keeps observed and forecast values in separate columns", () => {
    const rows = buildChartRows({
      product_id: "p", name: "P",
      actual: [{ date: "2026-10-14", units: 4, precipitation_mm: 2 }, { date: "2026-10-15", units: 6, precipitation_mm: 0 }],
      forecast: [{ date: "2026-10-16", predicted: 5, lower: 3, upper: 7, precipitation_mm: 1, weather_source: "simulated" }],
      summary: { model_used: "seasonal_naive", mae: 1, rmse: 1, baseline_mae: 1, explanation: "", drivers: [], stockout_risk: "none", recommended_reorder_qty: 0 },
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(rows[1]).toMatchObject({ observed: 6, forecast: null, band: null });
    expect(rows[2]).toMatchObject({ observed: null, forecast: 5, band: [3, 7], precipitation: 1 });
  });
});

describe("ForecastingPage", () => {
  it("shows run metrics and products in risk order from the API", async () => {
    mockApi([
      { path: "/auth/me", body: merchantMe },
      { path: "/merchant/stores", body: [{ id: "s1", code: "AND01", name: "FreshMart Andheri", city: "Mumbai", latitude: 0, longitude: 0, geofence_radius_m: 100, timezone: "Asia/Kolkata" }] },
      { path: "/merchant/forecasts", body: [run] },
      { path: "/merchant/forecasts/r1", body: { ...run, products: [product("Toor Dal", "high", 170), product("Milk", "medium", 90), product("Rice", "none", 40)] } },
    ]);
    renderWithProviders(
      <MerchantStoreProvider>
        <ForecastingPage />
      </MerchantStoreProvider>,
      { route: "/?run=r1" },
    );
    const rows = await screen.findAllByTestId("forecast-row");
    expect(rows.map((r) => within(r).getAllByRole("button")[0].textContent)).toEqual(["Toor Dal", "Milk", "Rice"]);
    expect(within(rows[0]).getByText("High")).toBeInTheDocument();
    expect(screen.getByText("High stockout risk")).toBeInTheDocument();
    expect(screen.getByText(/vs 10 baseline/)).toBeInTheDocument();
    expect(screen.getByText("Simulated data")).toBeInTheDocument();
  });
});
