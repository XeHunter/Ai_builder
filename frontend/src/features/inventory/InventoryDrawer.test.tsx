import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { bodyOf, callsTo, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";

import { AdjustForm, makeAdjustSchema } from "./components/InventoryDrawer";
import type { InventoryDetail } from "./types";

const item: InventoryDetail = {
  id: "i1", store_id: "s1", store_code: "AND01", product_id: "p1", sku: "MLK-001", name: "Amul Taaza Toned Milk 1 L", category: "Dairy",
  is_perishable: true, quantity_on_hand: 10, reorder_point: 5, reorder_quantity: 20, price: 68, stock_status: "in_stock", shelf_code: "D-2-2",
  next_expiry: "2026-10-18", batch_count: 1,
  batches: [{ id: "b1", batch_code: "MLK-001-B1", quantity_received: 20, quantity_remaining: 10, received_at: "2026-10-10T00:00:00Z", expiry_date: "2026-10-18", days_to_expiry: 2, status: "active", markdown_price: null, markdown_pct: null, in_clearance: false }],
  adjustments: [],
};

describe("makeAdjustSchema", () => {
  const schema = makeAdjustSchema({ onHand: 10, batches: item.batches });
  it("rejects zero, removing more than available, and wrong-signed reasons", () => {
    expect(schema.safeParse({ delta: 0, reason: "manual" }).success).toBe(false);
    const tooMany = schema.safeParse({ delta: -11, reason: "count_correction" });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0].message).toBe("Only 10 units available to remove");
    expect(schema.safeParse({ delta: -3, reason: "receive" }).success).toBe(false);
    expect(schema.safeParse({ delta: 3, reason: "damage" }).success).toBe(false);
    expect(schema.safeParse({ delta: 2.5, reason: "manual" }).success).toBe(false);
    expect(schema.safeParse({ delta: -10, reason: "damage" }).success).toBe(true);
    expect(schema.safeParse({ delta: 24, reason: "receive", batch_code: "B9", expiry_date: "2026-10-25" }).success).toBe(true);
  });
});

describe("AdjustForm", () => {
  it("shows validation errors and does not call the API for invalid input", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<AdjustForm item={item} />);
    await user.type(screen.getByLabelText("Change (+/−)"), "-50");
    await user.selectOptions(screen.getByLabelText("Reason"), "damage");
    await user.click(screen.getByRole("button", { name: "Apply adjustment" }));
    expect(await screen.findByText("Only 10 units available to remove")).toBeInTheDocument();
    expect(screen.getByText(/are taken first-expiry-first-out/)).toBeInTheDocument();
    expect(callsTo(fetchSpy, "POST", /adjust$/)).toHaveLength(0);
  });

  it("receives stock with a batch code and expiry date", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<AdjustForm item={item} />, {
      routes: [{ method: "POST", path: "/merchant/inventory/items/i1/adjust", body: { ...item, quantity_on_hand: 34 } }],
    });
    await user.type(screen.getByLabelText("Change (+/−)"), "24");
    await user.type(await screen.findByLabelText("Batch code"), "MLK-001-B2");
    await user.type(screen.getByLabelText("Expiry date"), "2026-10-25");
    await user.click(screen.getByRole("button", { name: "Apply adjustment" }));
    await waitFor(() => expect(callsTo(fetchSpy, "POST", "/merchant/inventory/items/i1/adjust")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchSpy, "POST", "/merchant/inventory/items/i1/adjust")[0])).toEqual({
      delta: 24, reason: "receive", note: null, batch_id: null, batch_code: "MLK-001-B2", expiry_date: "2026-10-25",
    });
  });

  it("surfaces 422 business errors from the server", async () => {
    const user = userEvent.setup();
    renderMerchant(<AdjustForm item={item} />, {
      routes: [{ method: "POST", path: "/merchant/inventory/items/i1/adjust", status: 422, body: { error: { code: "business_rule", message: "Only 4 units available; cannot remove 6" } } }],
    });
    await user.type(screen.getByLabelText("Change (+/−)"), "-6");
    await user.selectOptions(screen.getByLabelText("Reason"), "manual");
    await user.click(screen.getByRole("button", { name: "Apply adjustment" }));
    expect(await screen.findByText("Only 4 units available; cannot remove 6")).toBeInTheDocument();
  });
});
