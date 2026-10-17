import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockApi, renderWithProviders } from "@/tests/test-utils";

import { PlacementRulesCard, type RuleBook } from "./PlacementRulesCard";

const book: RuleBook = {
  layout_id: "l1", layout_name: "Main floor v1", status: "active", placements_checked: 76, kid_targeted_products: 5,
  blocking: 1, warnings: 1,
  rules: [
    { code: "unsafe_height", kind: "block", group: "Customer safety", title: "Heavy items low", description: "5 kg+ not above 100 cm.",
      why: "Falls.", checked: true, violations: 1,
      examples: [{ product: "Atta 5 kg", sku: "STP-002", shelf_code: "A3-L-1-4", height_cm: 140, message: "x" }] },
    { code: "kid_eye_level", kind: "warn", group: "Responsible retail", title: "Treats above kids' eye level",
      description: "Confectionery below 90 cm is flagged.", why: "Pester power.", checked: true, violations: 1,
      examples: [{ product: "Dairy Milk", sku: "CHO-002", shelf_code: "A2-L-1-1", height_cm: 20, message: "x" }] },
    { code: "child_checkout", kind: "block", group: "Responsible retail", title: "No kids' treats at checkout",
      description: "Blocked.", why: "UK HFSS.", checked: true, violations: 0, examples: [] },
    { code: "eye_level_test", kind: "ai", group: "AI recommendations", title: "Best sellers to adult eye level",
      description: "A/B test.", why: "Attention.", checked: false, violations: 0, examples: [] },
  ],
};

describe("PlacementRulesCard", () => {
  it("shows rules by group with live violations and expandable evidence", async () => {
    mockApi([{ path: "/merchant/layouts/l1/rules", body: book }]);
    renderWithProviders(<PlacementRulesCard layoutId="l1" />);
    expect(await screen.findByText("Treats above kids' eye level")).toBeInTheDocument();
    expect(screen.getByText("Responsible retail")).toBeInTheDocument();
    expect(screen.getByText("AI policy")).toBeInTheDocument();
    expect(screen.getAllByText("1 found")).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole("button", { name: /Treats above kids' eye level/ }));
    expect(screen.getByText("A2-L-1-1")).toBeInTheDocument();
    expect(screen.getByText("Pester power.")).toBeInTheDocument();
  });
});
