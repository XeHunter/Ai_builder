import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { callsTo, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";

import ExpiryPage from "./ExpiryPage";

const batch = {
  batch_id: "b1", store_id: "s1", store_code: "AND01", product_id: "p1", product: "Fresh Malai Paneer 200 g", sku: "DRY-004", batch_code: "DRY-004-B1",
  expiry_date: "2026-10-17", hours_to_sell_by: 29.3, quantity_remaining: 30, daily_velocity: 7.86, expected_sell_through: 9.6, units_at_risk: 20.4,
  value_at_risk: 1429.4, status: "active", markdown_price: null, in_clearance: false,
  price_change: { id: "pc9", status: "RECOMMENDED", discount_pct: 20, proposed_price: 76 }, priority: 48.85,
};

describe("ExpiryPage", () => {
  it("lists prioritised batches with urgency and a link to the linked price change", async () => {
    renderMerchant(<ExpiryPage />, { routes: [{ path: "/merchant/expiry/batches", body: [batch] }] });
    expect(await screen.findByText("Fresh Malai Paneer 200 g")).toBeInTheDocument();
    expect(screen.getByText("29 h")).toHaveClass("text-danger");
    expect(screen.getByText("20.4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Recommended/ })).toHaveAttribute("href", "/merchant/pricing?change=pc9");
    expect(screen.getByText(/never sold/)).toBeInTheDocument();
  });

  it("re-evaluates the selected store synchronously and summarises the results", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<ExpiryPage />, {
      storeId: "s1",
      routes: [
        { path: "/merchant/expiry/batches", body: [batch] },
        {
          method: "POST",
          path: "/merchant/expiry/evaluate",
          body: { store: "AND01", batches_evaluated: 5, price_changes_expired: 0, results: [{ batch_id: "b1", product: "Fresh Malai Paneer 200 g", hours_left: 29.3, quantity: 30, actions: ["markdown 20% (RECOMMENDED)"] }] },
        },
      ],
    });
    await user.click(await screen.findByRole("button", { name: /Re-evaluate AND01 now/ }));
    expect(await screen.findByText(/AND01: 5 batches evaluated/)).toBeInTheDocument();
    expect(screen.getByText(/markdown 20% \(RECOMMENDED\)/)).toBeInTheDocument();
    await waitFor(() => expect(String(callsTo(fetchSpy, "POST", "/merchant/expiry/evaluate")[0][0])).toContain("store_id=s1"));
  });
});
