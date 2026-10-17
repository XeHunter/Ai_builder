import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { bodyOf, callsTo, meWith, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";
import type { MockRoute } from "@/tests/test-utils";

import { PolicyCard } from "./components/RulesPolicyTab";
import { priceChangeActions } from "./components/PriceChangeDrawer";
import { promotionActions } from "./components/PromotionsTab";
import { promotionSchema, PromotionForm } from "./components/PromotionFormDialog";
import PricingPage from "./PricingPage";
import type { PriceChange } from "./types";

const all = (_: string) => true;

const pc: PriceChange = {
  id: "pc1", store_id: "s1", store_code: "AND01", product_id: "p1", product: "Butter Croissant (2 pc)", sku: "BKY-002", batch_id: "b1", batch_code: "BKY-002-B1",
  source: "expiry_markdown", status: "PENDING_APPROVAL", current_price: 90, proposed_price: 67.5, discount_pct: 25, floor_price: 65, unit_cost: 60, projected_margin_pct: 11.11,
  quantity_affected: 18, reason: "18 units left with 30 h to sell-by.",
  evidence: { method: "heuristic_markdown_rule", assumption: "price elasticity 2.0", hours_to_sell_by: 29.7, daily_velocity_14d: 2.79, expected_units_no_action: 3.4, expected_units_with_action: 5.2, expected_leftover_units: 12.8, tier_cap_pct: 30, floor_price: 65, unit_cost: 60, reasons: ["Discount limited to 25% by the price floor."] },
  clearance_instruction: "Move batch BKY-002-B1 to the clearance bin (CLR-1-1).", publish_reference: null, failure_reason: null, requested_by: "system", approved_by: null,
  created_at: "2026-10-16T12:00:00Z", approved_at: null, published_at: null, effective_until: null,
  events: [{ from: null, to: "RECOMMENDED", actor: "system", note: "created", at: "2026-10-16T12:00:00Z" }, { from: "RECOMMENDED", to: "PENDING_APPROVAL", actor: "Anita", note: null, at: "2026-10-16T12:10:00Z" }],
};
const emptyPage = { items: [], total: 0, page: 1, page_size: 20 };

describe("priceChangeActions", () => {
  it("maps workflow state and permissions to the available actions", () => {
    expect(priceChangeActions("RECOMMENDED", all)).toEqual(["submit", "approve_publish", "approve", "reject", "cancel"]);
    expect(priceChangeActions("PENDING_APPROVAL", all)).toEqual(["approve_publish", "approve", "reject", "cancel"]);
    expect(priceChangeActions("APPROVED", all)).toEqual(["publish", "cancel"]);
    expect(priceChangeActions("FAILED", all)).toEqual(["publish", "cancel"]);
    expect(priceChangeActions("PUBLISHED", all)).toEqual([]);
    expect(priceChangeActions("REJECTED", all)).toEqual([]);
    // Approver without publish permission cannot "approve & publish".
    expect(priceChangeActions("PENDING_APPROVAL", (p) => p !== "pricing.publish")).toEqual(["approve", "reject", "cancel"]);
    // Read-only analyst gets nothing.
    expect(priceChangeActions("RECOMMENDED", (p) => p === "pricing.read")).toEqual([]);
  });

  it("respects promotion states", () => {
    expect(promotionActions("draft", all)).toEqual(["submit", "cancel"]);
    expect(promotionActions("pending_approval", all)).toEqual(["approve", "reject", "cancel"]);
    expect(promotionActions("active", all)).toEqual(["pause", "end"]);
    expect(promotionActions("paused", all)).toEqual(["resume", "end", "cancel"]);
    expect(promotionActions("ended", all)).toEqual([]);
    expect(promotionActions("pending_approval", (p) => p !== "pricing.approve")).toEqual(["cancel"]);
  });
});

describe("Price change drawer", () => {
  it("opens from ?change=, shows evidence and approves & publishes", async () => {
    const user = userEvent.setup();
    const published = { ...pc, status: "PUBLISHED", publish_reference: "SIM-ESL-ABC123", published_at: "2026-10-16T12:30:00Z" };
    const detail: MockRoute = { path: "/merchant/pricing/changes/pc1", body: pc };
    const { fetchSpy } = renderMerchant(<PricingPage />, {
      route: "/merchant/pricing?change=pc1",
      routes: [{ path: "/merchant/pricing/changes", body: emptyPage }, detail, { method: "POST", path: "/merchant/pricing/changes/pc1/approve", body: published }],
    });
    const drawer = await screen.findByRole("dialog", { name: "Butter Croissant (2 pc)" });
    expect(await within(drawer).findByText("Expected leftover units")).toBeInTheDocument();
    expect(within(drawer).getByText("12.8")).toBeInTheDocument();
    expect(within(drawer).getByText(/clearance bin \(CLR-1-1\)/)).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /Submit for approval/ })).not.toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Approve only" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Reject/ })).toBeInTheDocument();

    detail.body = published; // the server now reports the published state on refetch
    await user.click(within(drawer).getByRole("button", { name: /Approve & publish/ }));
    await waitFor(() => expect(callsTo(fetchSpy, "POST", "/merchant/pricing/changes/pc1/approve")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchSpy, "POST", "/merchant/pricing/changes/pc1/approve")[0])).toEqual({ note: null, publish: true });
    expect(await within(drawer).findByText("SIM-ESL-ABC123")).toBeInTheDocument();
  });

  it("shows guardrail violations returned by the server", async () => {
    const user = userEvent.setup();
    renderMerchant(<PricingPage />, {
      route: "/merchant/pricing?change=pc1",
      routes: [
        { path: "/merchant/pricing/changes", body: emptyPage },
        { path: "/merchant/pricing/changes/pc1", body: pc },
        { method: "POST", path: "/merchant/pricing/changes/pc1/approve", status: 422, body: { error: { code: "business_rule", message: "Cannot approve: guardrail check failed", details: { violations: ["The batch has no remaining stock."] } } } },
      ],
    });
    const drawer = await screen.findByRole("dialog", { name: "Butter Croissant (2 pc)" });
    await user.click(await within(drawer).findByRole("button", { name: "Approve only" }));
    expect(await within(drawer).findByText("The batch has no remaining stock.")).toBeInTheDocument();
  });
});

describe("promotion form validation", () => {
  it("rejects an end before the start and an empty product list", () => {
    const r = promotionSchema.safeParse({
      name: "Rainy day", description: "", store_id: "", products: [], promo_type: "percent_off", discount_value: 10,
      starts_at: "2026-10-20T10:00", ends_at: "2026-10-19T10:00", per_customer_limit: 1,
    });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(msgs).toContain("products: Add at least one product");
    expect(msgs).toContain("ends_at: End must be after the start");
  });

  it("rejects percentages of 100 or more", () => {
    const r = promotionSchema.safeParse({
      name: "Too much", store_id: "", products: [{ id: "p1", name: "x" }], promo_type: "percent_off", discount_value: 100,
      starts_at: "2026-10-20T10:00", ends_at: "2026-10-21T10:00", per_customer_limit: 1,
    });
    expect(r.success).toBe(false);
  });

  it("shows field errors in the form and does not submit", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<PromotionForm onCancel={() => undefined} onCreated={() => undefined} />);
    await user.type(screen.getByLabelText("Name"), "Weekend");
    await user.clear(screen.getByLabelText("Ends"));
    await user.type(screen.getByLabelText("Ends"), "2020-01-01T10:00");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Add at least one product")).toBeInTheDocument();
    expect(screen.getByText("End must be after the start")).toBeInTheDocument();
    expect(callsTo(fetchSpy, "POST", "/merchant/promotions")).toHaveLength(0);
  });
});

describe("PolicyCard", () => {
  const policy = {
    auto_publish_markdowns: false, auto_publish_max_pct: 15, max_markdown_pct: 50, min_margin_pct: 0, expiry_warning_days: 3, expiry_critical_hours: 48,
    sell_by_buffer_hours: 0, low_stock_threshold_days: 3, forecast_horizon_days: 14, fraud_alert_threshold: 50, default_geofence_radius_m: 1000,
    notification_cooldown_minutes: 240, clearance_location_code: "CLR-1-1",
  };

  it("is read-only without settings.manage", async () => {
    renderMerchant(<PolicyCard />, { me: meWith((p) => p.filter((x) => x !== "settings.manage")), routes: [{ path: "/merchant/pricing/policy", body: policy }] });
    const input = await screen.findByLabelText("Maximum markdown (%)");
    await waitFor(() => expect(input).toHaveValue(50));
    expect(input).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Auto-publish small markdowns" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
    expect(screen.getByText(/requires the settings.manage permission/)).toBeInTheDocument();
  });

  it("saves only the changed fields with settings.manage", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<PolicyCard />, {
      routes: [{ path: "/merchant/pricing/policy", body: policy }, { method: "PATCH", path: "/merchant/pricing/policy", body: { ...policy, max_markdown_pct: 40 } }],
    });
    const input = await screen.findByLabelText("Maximum markdown (%)");
    await waitFor(() => expect(input).toHaveValue(50));
    await waitFor(() => expect(input).toBeEnabled());
    await user.clear(input);
    await user.type(input, "40");
    await user.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(callsTo(fetchSpy, "PATCH", "/merchant/pricing/policy")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchSpy, "PATCH", "/merchant/pricing/policy")[0])).toEqual({ max_markdown_pct: 40 });
  });
});
