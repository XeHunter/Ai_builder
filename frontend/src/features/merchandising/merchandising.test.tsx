import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MerchantStoreProvider } from "@/hooks/use-stores";
import { merchantMe, mockApi, renderWithProviders } from "@/tests/test-utils";
import type { Layout } from "@/types/api";

import LayoutPage, { moveFixtureLocally } from "./LayoutPage";
import { RecommendationCard } from "./RecommendationCard";
import { actionsForStatus } from "./recommendation-utils";
import type { Recommendation } from "./types";

const store = { id: "s1", code: "AND01", name: "FreshMart Andheri", city: "Mumbai", latitude: 0, longitude: 0, geofence_radius_m: 100, timezone: "Asia/Kolkata" };

const layout: Layout = {
  id: "L2", store_id: "s1", name: "Main floor (proposal v2)", version: 2, status: "draft", width_m: 20, height_m: 10,
  based_on_layout_id: "L1", published_at: null,
  fixtures: [
    { id: "f1", code: "A3-L", kind: "aisle_shelf", label: "Aisle 3 left", aisle_code: "A3", x: 2, y: 2, width: 1, height: 6, levels: 2, is_chilled: false, is_movable: false },
    { id: "f2", code: "E1", kind: "endcap", label: "Endcap 1", aisle_code: null, x: 10, y: 2, width: 2, height: 1, levels: 1, is_chilled: false, is_movable: true },
  ],
  shelves: [
    { id: "sh1", code: "A3-L-2-1", fixture_id: "f1", aisle_code: "A3", section: 2, level: 1, height_cm: 20, x: 2.5, y: 4, capacity_facings: 6, is_clearance: false, access_node: null, products: [] },
    { id: "sh2", code: "A3-L-2-4", fixture_id: "f1", aisle_code: "A3", section: 2, level: 4, height_cm: 140, x: 2.5, y: 4, capacity_facings: 6, is_clearance: false, access_node: null, products: [] },
    { id: "sh3", code: "E1-1-1", fixture_id: "f2", aisle_code: null, section: 1, level: 1, height_cm: 40, x: 11, y: 2.5, capacity_facings: 4, is_clearance: false, access_node: null, products: [] },
  ],
  nodes: [],
  edges: [],
};

describe("moveFixtureLocally", () => {
  it("moves the fixture and shifts its shelves by the same delta", () => {
    const next = moveFixtureLocally(layout, "f2", { x: 12, y: 5 });
    expect(next.fixtures.find((f) => f.id === "f2")).toMatchObject({ x: 12, y: 5 });
    expect(next.shelves.find((s) => s.id === "sh3")).toMatchObject({ x: 13, y: 5.5 });
    expect(next.shelves.find((s) => s.id === "sh1")).toMatchObject({ x: 2.5, y: 4 });
  });
});

describe("LayoutPage", () => {
  it("shows hard-constraint violations when a placement is rejected", async () => {
    const spy = mockApi([
      { path: "/auth/me", body: merchantMe },
      { path: "/merchant/stores", body: [store] },
      { path: "/merchant/stores/s1/layouts", body: [
        { id: "L2", name: layout.name, version: 2, status: "draft", published_at: null, created_at: "2026-10-16T10:00:00Z" },
        { id: "L1", name: "Main floor v1", version: 1, status: "active", published_at: null, created_at: "2026-10-01T10:00:00Z" },
      ] },
      { path: "/merchant/layouts/L2", body: layout },
      { path: "/merchant/layouts/L2/diff", body: { base_layout_id: "L1", layout_id: "L2", changes: [] } },
      { path: "/merchant/products", body: { items: [{ id: "p1", sku: "ATA-5", name: "Atta 5 kg", category_name: "Staples", brand: null, unit: "5 kg", price: 300, is_perishable: false, is_child_product: false, weight_kg: 5, total_stock: 10, status: "active" }], total: 1, page: 1, page_size: 20 } },
      {
        method: "POST", path: "/merchant/layouts/L2/placements", status: 422,
        body: { error: { code: "business_rule_violation", message: "Placement violates merchandising constraints", details: { violations: [
          { severity: "block", code: "unsafe_height", message: "Items of 5.0 kg must not be placed above 100 cm." },
        ] } } },
      },
    ]);
    renderWithProviders(
      <MerchantStoreProvider>
        <LayoutPage />
      </MerchantStoreProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Shelf section A3-L-2" }));
    await user.click(await screen.findByRole("button", { name: /Atta 5 kg/ }));
    await user.click(screen.getByRole("button", { name: "Place Atta 5 kg on A3-L-2-4" }));
    expect(await screen.findByText("Items of 5.0 kg must not be placed above 100 cm.")).toBeInTheDocument();
    expect(screen.getByText("Unsafe height")).toBeInTheDocument();
    expect(screen.getByText("Cannot place on A3-L-2-4")).toBeInTheDocument();
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ product_id: "p1", shelf_code: "A3-L-2-4", facings: 1 });
  });
});

describe("recommendation actions", () => {
  const all = { canManage: true, canWriteLayout: true, hasProposedLocation: true };
  it("follows the review workflow per status", () => {
    expect(actionsForStatus("proposed", all)).toEqual(["accept", "apply", "reject"]);
    expect(actionsForStatus("accepted", all)).toEqual(["apply", "implement", "reject"]);
    expect(actionsForStatus("implemented", all)).toEqual(["complete"]);
    expect(actionsForStatus("completed", all)).toEqual([]);
    expect(actionsForStatus("rejected", all)).toEqual([]);
  });
  it("respects permissions and missing locations", () => {
    expect(actionsForStatus("proposed", { ...all, canManage: false })).toEqual(["apply"]);
    expect(actionsForStatus("proposed", { ...all, hasProposedLocation: false })).toEqual(["accept", "reject"]);
  });

  const rec: Recommendation = {
    id: "rec1", store_id: "s1", rec_type: "adjacency_test", title: "Test a secondary placement of Dahi near Peas",
    product_id: "p1", product: "Dahi", related_product_id: "p2", related_product: "Peas",
    current_location: { id: "x", code: "D-4-2", level: 2, fixture: "Dairy chillers", x: 1, y: 1 },
    proposed_location: { id: "y", code: "Z-2-3", level: 3, fixture: "Frozen", x: 5, y: 5 },
    rationale: "41% of baskets with Peas also contain Dahi.", evidence: { lift: 7.44, pair_count: 227, confidence: 0.41 },
    evidence_quality: "high", expected_metric: "Attach rate", implementation_steps: ["Add 1-2 facings at Z-2-3."],
    ab_test_plan: { design: "Alternate weeks", primary_metric: "attach_rate", baseline_rate: 0.41, minimum_detectable_change: 0.1, baskets_needed_per_arm: 369, estimated_duration_weeks: 12, stop_rule: "Run for the planned duration." },
    status: "proposed", review_note: null, implemented_at: null, outcome: {}, created_at: "2026-10-16T10:00:00Z",
  };

  it("renders evidence and status-appropriate buttons", async () => {
    mockApi([
      { path: "/auth/me", body: merchantMe },
      { path: "/merchant/merchandising/recommendations/rec2", body: { ...rec, id: "rec2", status: "implemented", live_outcome: {
        before: { baskets: 100, attach_rate: 0.3 }, after: { baskets: 80, attach_rate: 0.35 }, window_days: 28, method: "observational_before_after", caveat: "No randomised control.",
      } } },
    ]);
    renderWithProviders(
      <>
        <RecommendationCard rec={rec} showMap={false} />
        <RecommendationCard rec={{ ...rec, id: "rec2", status: "implemented", implemented_at: "2026-10-01T00:00:00Z" }} showMap={false} />
      </>,
    );
    expect(await screen.findAllByText("7.44×")).toHaveLength(2);
    expect(await screen.findByRole("button", { name: /^Accept$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply to draft layout/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Mark completed/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Mark implemented/ })).not.toBeInTheDocument();
    expect(await screen.findByText("35.0%")).toBeInTheDocument();
    expect(screen.getByText("Observational")).toBeInTheDocument();
  });
});
