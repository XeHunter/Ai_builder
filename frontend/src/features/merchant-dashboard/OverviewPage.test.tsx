import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { callsTo, renderMerchant } from "./components/test-helpers";
import OverviewPage from "./OverviewPage";
import { validateSettingsJson } from "./IntegrationsPage";

const overview = {
  is_demo_data: true,
  window_days: 30,
  kpis: {
    total_products: 77, total_stock_units: 16557, low_stock_products: 23, out_of_stock_products: 2, expiring_batches_3d: 28,
    stockout_risk_high: 7, stockout_risk_medium: 49, active_promotions: 2, pending_price_recommendations: 4,
    pending_merchandising_recommendations: 14, flagged_transactions: 17, open_store_tasks: 1, net_revenue: 125760,
    transactions: 9585, net_revenue_previous_period: 110908, revenue_change_pct: 13.4,
  },
  sales_trend: [{ date: "2026-10-01", revenue: 1000, transactions: 10, returns: 0 }],
  category_revenue: [{ category: "Dairy", revenue: 5000 }],
  top_products: [{ product_id: "p1", name: "Amul Taaza Toned Milk 1 L", units: 120, revenue: 8160 }],
  alerts: [{ kind: "pricing", severity: "warning", title: "Price publication failed: Butter Croissant", link: "/merchant/pricing?change=pc1" }],
};

describe("OverviewPage", () => {
  it("renders KPIs, change vs previous period, alerts and top products from the API", async () => {
    const { fetchSpy } = renderMerchant(<OverviewPage />, { routes: [{ path: "/merchant/overview", body: overview }] });

    expect(await screen.findByText("Net revenue")).toBeInTheDocument();
    expect(screen.getByText(/\+13.4% vs previous 30 days/)).toBeInTheDocument();
    const expiring = screen.getByText("Expiring ≤ 3 days").closest("button")!;
    expect(within(expiring).getByText("28")).toBeInTheDocument();
    expect(screen.getByText("23 / 2")).toBeInTheDocument();
    expect(screen.getByText("Demo data")).toBeInTheDocument();
    const alert = screen.getByRole("link", { name: /Price publication failed/ });
    expect(alert).toHaveAttribute("href", "/merchant/pricing?change=pc1");
    expect(screen.getByText("Amul Taaza Toned Milk 1 L")).toBeInTheDocument();

    const call = callsTo(fetchSpy, "GET", "/merchant/overview")[0];
    expect(String(call[0])).toContain("days=30");
  });

  it("shows an inline error with retry when the overview fails", async () => {
    renderMerchant(<OverviewPage />, { routes: [{ path: "/merchant/overview", status: 500, body: { error: { code: "boom", message: "Database unavailable" } } }] });
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("validateSettingsJson", () => {
  it("accepts JSON objects and rejects arrays, invalid JSON and secrets", () => {
    expect(validateSettingsJson('{"fail_skus": ["BKY-002"]}')).toBeNull();
    expect(validateSettingsJson("")).toBeNull();
    expect(validateSettingsJson("[1,2]")).toMatch(/JSON object/);
    expect(validateSettingsJson("{oops")).toMatch(/valid JSON/);
    expect(validateSettingsJson('{"api_key": "x"}')).toMatch(/environment variables/);
  });
});
