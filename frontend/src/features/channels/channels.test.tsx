import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { AiBriefCard } from "@/features/merchant-dashboard/components/AiBriefCard";
import { bodyOf, callsTo, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";
import { signOutFirebase } from "@/lib/firebase";

import ChannelsPage from "./ChannelsPage";
import { LiveOrdersFeed } from "./LiveOrdersFeed";

const brief = {
  headline: "Clear 3 short-dated dairy batches and reorder milk before the evening rush",
  actions: [
    {
      title: "Mark down Amul curd at AND01",
      detail: "Approve the 30% markdown so it sells before expiry.",
      priority: "high",
      fact_ids: ["F1"],
      link: "/merchant/expiry",
      evidence: ["Amul Masti Dahi 400 g batch B-12 expires in 18 h (14 units)."],
    },
    {
      title: "Reorder toned milk",
      detail: "Raise a purchase order for about 120 units.",
      priority: "medium",
      fact_ids: ["F2"],
      link: "/merchant/inventory",
      evidence: ["Amul Taaza Toned Milk 1 L at AND01: 6 on hand, reorder point 40."],
    },
  ],
  provider: "gemini",
  model: "gemini-2.5-flash",
  fell_back: false,
  generated_at: new Date().toISOString(),
  cached: false,
  facts: {
    kpis: { orders_today: 42, online_orders_today: 9, revenue_7d: 125760, revenue_change_pct: 4.2, low_stock_products: 23, expiring_batches_3d: 5 },
    facts: [
      { id: "F1", kind: "expiry", priority: "high", title: "Clear short-dated stock", text: "x", action: "y", link: "/merchant/expiry" },
      { id: "F2", kind: "low_stock", priority: "medium", title: "Reorder", text: "x", action: "y", link: "/merchant/inventory" },
    ],
  },
};

const order = {
  id: "o1",
  receipt_number: "SIM-AND01-0007",
  channel: "pos",
  store_id: "s1",
  store_code: "AND01",
  store_name: "FreshMart Andheri West",
  occurred_at: new Date().toISOString(),
  total: 186,
  item_count: 3,
  payment_method: "upi",
  is_simulated: true,
  customer: null,
  lines: [
    { sku: "MLK-001", name: "Amul Taaza Toned Milk 1 L", quantity: 2, unit_price: 68, line_total: 136 },
    { sku: "BKY-002", name: "Butter Croissant", quantity: 1, unit_price: 50, line_total: 50 },
  ],
};

const overview = {
  connectors: [
    { key: "pos_api", channel: "pos", name: "Any POS / billing software", description: "Push each bill.", auth: "api_key", mode: "live" },
    { key: "pos_simulator", channel: "pos", name: "Built-in POS simulator", description: "Ring up a bill.", auth: "session", mode: "simulated" },
    { key: "shopify", channel: "online", name: "Shopify", description: "Order webhook.", auth: "api_key", mode: "live" },
    { key: "shelf_labels", channel: "pricing", name: "Electronic shelf labels", description: "Price sync.", auth: "none", mode: "simulated" },
  ],
  keys: [
    { id: "k1", name: "Andheri till 1", channel: "pos", provider: "generic", prefix: "op_live_AbCd", store_id: "s1", store_code: "AND01", created_at: "2026-10-01T10:00:00Z", last_used_at: null, usage_count: 12, revoked: false },
  ],
  today: { pos: { orders: 30, revenue: 12000 }, self_checkout: { orders: 3, revenue: 900 }, online: { orders: 9, revenue: 4100 } },
  realtime: "polling",
  endpoints: {
    orders: "https://api.example.com/api/v1/ingest/orders",
    shopify_orders: "https://api.example.com/api/v1/ingest/shopify/orders",
    catalog_feed: "https://api.example.com/api/v1/ingest/catalog",
  },
};

const realtime = { path: "/realtime/config", body: { transport: "websocket" } };

beforeEach(async () => {
  // Reset the cached Firestore session so each test negotiates the transport afresh.
  await signOutFirebase();
});

describe("AiBriefCard", () => {
  it("renders the headline, prioritised actions with evidence and the Gemini badge", async () => {
    const { fetchSpy } = renderMerchant(<AiBriefCard storeId={null} />, { routes: [{ path: "/merchant/ai-brief", body: brief }] });

    expect(await screen.findByText(brief.headline)).toBeInTheDocument();
    expect(screen.getByText("Gemini · gemini-2.5-flash")).toBeInTheDocument();
    expect(screen.queryByText("Deterministic fallback")).not.toBeInTheDocument();
    const actions = screen.getByRole("list", { name: "Recommended actions" });
    expect(within(actions).getByText("Mark down Amul curd at AND01")).toBeInTheDocument();
    expect(within(actions).getByText("High priority")).toBeInTheDocument();
    expect(within(actions).getByText(/batch B-12 expires in 18 h/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reorder toned milk: open" })).toHaveAttribute("href", "/merchant/inventory");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo(fetchSpy, "GET", "/merchant/ai-brief").some(([u]) => String(u).includes("refresh=true"))).toBe(true));
  });

  it("labels a deterministic fallback instead of a model badge", async () => {
    renderMerchant(<AiBriefCard storeId={null} />, { routes: [{ path: "/merchant/ai-brief", body: { ...brief, fell_back: true } }] });
    expect(await screen.findByText("Deterministic fallback")).toBeInTheDocument();
    expect(screen.queryByText(/Gemini ·/)).not.toBeInTheDocument();
  });

  it("shows an error with retry when the brief fails", async () => {
    renderMerchant(<AiBriefCard storeId={null} />, { routes: [{ path: "/merchant/ai-brief", status: 500, body: { error: { code: "boom", message: "Brief unavailable" } } }] });
    expect(await screen.findByText("Brief unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("ChannelsPage", () => {
  it("rings up a random basket through the simulator and shows the receipt with low-stock warnings", async () => {
    const simulated = {
      ...order,
      duplicate: false,
      low_stock: [{ sku: "MLK-001", name: "Amul Taaza Toned Milk 1 L", on_hand: 6, reorder_point: 40, reorder_quantity: 120 }],
      shortfalls: [],
    };
    const { fetchSpy } = renderMerchant(<ChannelsPage />, {
      routes: [
        { path: "/merchant/channels", body: overview },
        { path: "/merchant/channels/orders", body: [] },
        { method: "POST", path: "/merchant/channels/simulate", status: 201, body: simulated },
        realtime,
      ],
    });

    expect(await screen.findByText("Channels & connectors")).toBeInTheDocument();
    expect(await screen.findByText("30 orders")).toBeInTheDocument();
    expect(screen.getByText("Order webhook.")).toBeInTheDocument();
    expect(screen.getByText("op_live_AbCd…")).toBeInTheDocument();
    expect(screen.getByText(/ingest\/orders -H "X-Api-Key: <your-api-key>"/)).toBeInTheDocument();

    const ring = screen.getByRole("button", { name: /Ring up random basket/ });
    await waitFor(() => expect(ring).toBeEnabled());
    fireEvent.click(ring);

    const receipt = await screen.findByRole("region", { name: "Receipt" });
    expect(within(receipt).getByText("SIM-AND01-0007")).toBeInTheDocument();
    expect(within(receipt).getByText("Butter Croissant")).toBeInTheDocument();
    expect(within(receipt).getByText("₹186.00")).toBeInTheDocument();
    expect(within(receipt).getByText("This sale pushed items to low stock")).toBeInTheDocument();

    const call = callsTo(fetchSpy, "POST", "/merchant/channels/simulate")[0];
    expect(bodyOf(call)).toEqual({ store_id: "s1", channel: "pos", payment_method: "upi", lines: [] });
  });
});

describe("LiveOrdersFeed", () => {
  it("falls back to polling when the realtime config says websocket", async () => {
    const { fetchSpy } = renderMerchant(<LiveOrdersFeed pollMs={60} />, {
      routes: [{ path: "/merchant/channels/orders", body: [order] }, realtime],
    });

    expect(await screen.findByText("SIM-AND01-0007")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByText(/2× Amul Taaza Toned Milk 1 L, 1× Butter Croissant/)).toBeInTheDocument();
    expect(await screen.findByText("Auto-refresh")).toBeInTheDocument();
    expect(callsTo(fetchSpy, "GET", "/realtime/config").length).toBeGreaterThan(0);
    expect(callsTo(fetchSpy, "POST", "/realtime/token")).toHaveLength(0);
    await waitFor(() => expect(callsTo(fetchSpy, "GET", "/merchant/channels/orders").length).toBeGreaterThanOrEqual(3));
  });
});
