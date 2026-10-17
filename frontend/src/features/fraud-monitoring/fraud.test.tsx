import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MerchantStoreProvider } from "@/hooks/use-stores";
import { merchantMe, mockApi, renderWithProviders } from "@/tests/test-utils";

import { closeSchema, CloseAlertForm, lineIssues } from "./AlertDrawer";
import FraudPage from "./FraudPage";
import type { Txn } from "./types";

const alert = {
  id: "a1", store_id: "s1", subject_type: "transaction", subject_ref: "AND01-1", transaction_id: "t1", rule_score: 70,
  anomaly_score: 90, risk_score: 75, risk_level: "high", status: "open", outcome: null, detected_at: new Date().toISOString(),
  summary: "8 returns in 30 days (limit 4)",
  signals: [{ code: "refund_frequency", name: "Frequent returns", weight: 70, detail: "8 returns in 30 days (limit 4)", value: 8, kind: "deterministic_rule" }],
};

describe("close alert form", () => {
  it("schema requires an outcome and a note of at least 5 characters", () => {
    expect(closeSchema.safeParse({ outcome: "false_positive", note: "ok" }).success).toBe(false);
    expect(closeSchema.safeParse({ outcome: "false_positive", note: "     ok   " }).success).toBe(false);
    expect(closeSchema.safeParse({ outcome: "bogus", note: "Receipt verified" }).success).toBe(false);
    expect(closeSchema.safeParse({ outcome: "false_positive", note: "Receipt verified" }).success).toBe(true);
  });

  it("shows validation errors and does not submit without a note", async () => {
    mockApi([{ path: "/auth/me", body: merchantMe }]);
    const onSubmit = vi.fn();
    renderWithProviders(<CloseAlertForm onSubmit={onSubmit} onCancel={() => undefined} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Outcome"), "false_positive");
    await user.click(screen.getByRole("button", { name: /close case/i }));
    expect(await screen.findByText(/at least 5 characters/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Reviewer note"), "Receipt and CCTV checked");
    await user.click(screen.getByRole("button", { name: /close case/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ outcome: "false_positive", note: "Receipt and CCTV checked" });
  });
});

describe("receipt comparison", () => {
  const base: Omit<Txn, "items" | "type"> = { id: "x", receipt_number: "R1", channel: "pos", occurred_at: "", total: 0, terminal_id: null, is_simulated: true };
  it("flags returned lines missing from or exceeding the original and scale discrepancies", () => {
    const original: Txn = { ...base, type: "sale", items: [{ product: "Milk", quantity: 1, detected_quantity: null, unit_price: 50, line_total: 50 }] };
    const ret: Txn = {
      ...base, type: "return",
      items: [
        { product: "Milk", quantity: 2, detected_quantity: null, unit_price: 50, line_total: 100 },
        { product: "Camera", quantity: 1, detected_quantity: null, unit_price: 9000, line_total: 9000 },
      ],
    };
    expect(lineIssues(ret, original)).toEqual([["Returned 2, original 1"], ["Not on original receipt"]]);
    const sco: Txn = { ...base, type: "sale", channel: "self_checkout", items: [{ product: "Chips", quantity: 1, detected_quantity: 3, unit_price: 20, line_total: 20 }] };
    expect(lineIssues(sco, null)).toEqual([["Scale detected 3, charged 1"]]);
  });
});

describe("FraudPage", () => {
  it("renders the review queue and opens the case drawer from ?alert", async () => {
    mockApi([
      { path: "/auth/me", body: merchantMe },
      { path: "/merchant/stores", body: [{ id: "s1", code: "AND01", name: "FreshMart Andheri", city: "Mumbai", latitude: 0, longitude: 0, geofence_radius_m: 100, timezone: "Asia/Kolkata" }] },
      { path: "/merchant/fraud/alerts", body: { items: [alert], total: 1, page: 1, page_size: 20 } },
      { path: "/merchant/fraud/alerts/a1", body: { ...alert, investigation: null, guidance: "Scores prioritise human review." } },
    ]);
    renderWithProviders(
      <MerchantStoreProvider>
        <FraudPage />
      </MerchantStoreProvider>,
      { route: "/?alert=a1" },
    );
    expect(await screen.findByRole("button", { name: "Open case AND01-1", hidden: true })).toBeInTheDocument();
    expect(await screen.findByText("Scores prioritise human review.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start investigation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close with outcome/i })).toBeInTheDocument();
  });
});
