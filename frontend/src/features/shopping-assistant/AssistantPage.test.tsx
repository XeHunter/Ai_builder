import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { mockApi, renderWithProviders } from "@/tests/test-utils";
import type { AssistantResponse } from "@/types/api";

import AssistantPage from "./AssistantPage";
import { baseRoutes, product, withStore } from "./test-fixtures";

const reply: AssistantResponse = {
  message: "Here is a breakfast basket for 2 totalling ₹414, within your ₹500 budget.",
  intent: { intent: "budget_basket", search_queries: [], occasion: "breakfast", budget: 500, people: 2, reference_product: null },
  products: [
    product({ id: "bread", name: "Harvest Gold White Bread", price: 45, quantity: 1, line_total: 45, slot: "bread" }),
    product({ id: "eggs", name: "Country Brown Eggs", price: 66, quantity: 1, line_total: 66, slot: "eggs" }),
  ],
  complementary: [product({ id: "jam", name: "Kissan Jam", price: 165, reason: "Often bought with bread" })],
  reference: null,
  basket: { total: 414, budget: 500, people: 2, within_budget: true, skipped: ["cereal", "coffee"], occasion: "breakfast" },
  unmatched: [],
  directions: [{ product_id: "bread", name: "Harvest Gold White Bread", shelf_location_id: "x", shelf_code: "P-3-2", aisle_code: "P", aisle_label: "Produce & bakery wall", fixture_label: "Bakery", level: 2, x: 0, y: 0 }],
  clarifying_question: null,
  provider: { name: "demo", kind: "deterministic", fell_back: false },
  grounding: { validated: true, issues: [] },
};

describe("AssistantPage", () => {
  beforeEach(() => localStorage.clear());

  it("sends a suggested prompt and renders products, basket, complements and directions", async () => {
    const user = userEvent.setup();
    const spy = mockApi([...baseRoutes, { method: "POST", path: "/assistant/chat", body: reply }]);
    renderWithProviders(withStore(<AssistantPage />), { route: "/shop/assistant" });

    const chip = await screen.findByRole("button", { name: "I need breakfast items for two people under ₹500." });
    await waitFor(() => expect(chip).toBeEnabled());
    await user.click(chip);

    expect(await screen.findByText(/breakfast basket for 2 totalling/)).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Harvest Gold White Bread" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Country Brown Eggs" })).toBeInTheDocument();
    expect(screen.getByText("Within budget")).toBeInTheDocument();
    expect(screen.getByText(/of ₹500(\.00)? budget/)).toBeInTheDocument();
    expect(screen.getByText("Left out to stay on budget: cereal, coffee")).toBeInTheDocument();
    expect(screen.getByText("Often bought with bread")).toBeInTheDocument();
    expect(screen.getByText("Deterministic AI fallback")).toBeInTheDocument();
    expect(screen.getByText("Checked against store data")).toBeInTheDocument();

    const call = spy.mock.calls.find(([url]) => String(url).includes("/assistant/chat"));
    expect(JSON.parse(String(call![1]!.body))).toEqual({ store_id: "s1", message: "I need breakfast items for two people under ₹500." });
  });

  it("includes the context product from ?product= and shows an error with retry", async () => {
    const user = userEvent.setup();
    const spy = mockApi([
      ...baseRoutes,
      { path: "/stores/s1/products/cam", body: { product: product({ id: "cam", name: "Canon EOS 1500D" }), complementary: [], complement_reasons: {} } },
      { method: "POST", path: "/assistant/chat", status: 429, body: { error: { code: "rate_limited", message: "Too many requests" } } },
    ]);
    renderWithProviders(withStore(<AssistantPage />), { route: "/shop/assistant?product=cam" });

    expect(await screen.findByText(/Asking about: Canon EOS 1500D/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message the shopping assistant"), "Which memory card fits?{Enter}");
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).includes("/assistant/chat"));
    expect(JSON.parse(String(call![1]!.body)).context_product_id).toBe("cam");
  });
});
