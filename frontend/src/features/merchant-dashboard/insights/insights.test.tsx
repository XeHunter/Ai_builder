import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MerchantStoreProvider } from "@/hooks/use-stores";
import { merchantMe, mockApi, renderWithProviders } from "@/tests/test-utils";

import InsightsPage from "../InsightsPage";
import { buildTrafficGrid, trafficColor } from "./TrafficHeatmap";

describe("traffic grid", () => {
  it("zero-fills a 7 × hours grid spanning the observed hours", () => {
    const g = buildTrafficGrid([
      { dow: 0, hour: 9, transactions: 5 },
      { dow: 6, hour: 11, transactions: 12 },
    ]);
    expect(g.hours).toEqual([9, 10, 11]);
    expect(g.grid).toHaveLength(7);
    expect(g.grid[0]).toEqual([5, 0, 0]);
    expect(g.grid[6]).toEqual([0, 0, 12]);
    expect(g.max).toBe(12);
    expect(trafficColor(0, 12)).toBe("#f6f7f9");
    expect(trafficColor(12, 12)).not.toBe(trafficColor(3, 12));
  });
});

describe("InsightsPage", () => {
  it("renders heatmap, catalog gaps and the privacy note from the API", async () => {
    mockApi([
      { path: "/auth/me", body: merchantMe },
      { path: "/merchant/stores", body: [] },
      {
        path: "/merchant/insights",
        body: {
          window_days: 30,
          traffic_heatmap: [{ dow: 4, hour: 18, transactions: 40 }],
          channel_mix: [{ channel: "pos", transactions: 30 }, { channel: "online", transactions: 10 }],
          basket_size_distribution: [{ items: 1, transactions: 25 }, { items: 2, transactions: 15 }],
          shopping_lists: { total: 4, shared: 1, completed: 2 },
          catalog_gaps: [{ query: "quinoa", count: 3 }],
          most_listed_products: [{ name: "Brown Eggs", count: 2 }],
          privacy_note: "Aggregated and anonymised.",
        },
      },
    ]);
    renderWithProviders(
      <MerchantStoreProvider>
        <InsightsPage />
      </MerchantStoreProvider>,
    );
    expect(await screen.findByText("quinoa")).toBeInTheDocument();
    expect(screen.getByLabelText("Fri 18:00: 40 transactions")).toBeInTheDocument();
    expect(screen.getByText("Aggregated and anonymised.")).toBeInTheDocument();
    expect(screen.getByText("Brown Eggs")).toBeInTheDocument();
  });
});
