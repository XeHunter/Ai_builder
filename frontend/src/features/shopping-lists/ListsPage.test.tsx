import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { baseRoutes, withStore } from "@/features/shopping-assistant/test-fixtures";
import { mockApi, renderWithProviders } from "@/tests/test-utils";
import type { ParseResponse } from "@/types/api";

import ListsPage from "./ListsPage";

const parsed: ParseResponse = {
  items: [
    {
      raw_text: "milk", quantity: 2, unit: null, product_id: "choc", display_name: "Dairy Milk Chocolate", confidence: 0.55,
      status: "pending", needs_review: true,
      candidates: [
        { product_id: "choc", name: "Dairy Milk Chocolate", price: 20, in_stock: true, score: 1.2, location: "A2-L-1-4" },
        { product_id: "amul", name: "Amul Taaza Toned Milk 1 L", price: 68, in_stock: true, score: 1.2, location: "D-2-2" },
      ],
    },
    {
      raw_text: "eggs", quantity: 1, unit: null, product_id: "eggs", display_name: "Country Brown Eggs", confidence: 1,
      status: "pending", needs_review: false,
      candidates: [{ product_id: "eggs", name: "Country Brown Eggs", price: 66, in_stock: true, score: 1, location: "D-6-3" }],
    },
    { raw_text: "unobtainium", quantity: 1, unit: "kg", product_id: null, display_name: "unobtainium", confidence: 0, status: "unresolved", needs_review: false, candidates: [] },
  ],
  duplicates_merged: [{ raw_text: "milk", merged_into: "Dairy Milk Chocolate" }],
  unresolved: ["unobtainium"],
  parser: { provider: "demo", kind: "deterministic", fell_back: false },
};

describe("ListsPage – new smart list", () => {
  beforeEach(() => localStorage.clear());

  it("parses text, lets the shopper fix a match and creates the list", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockApi([
      ...baseRoutes,
      { method: "POST", path: "/shopping-lists/parse", body: parsed },
      { method: "POST", path: "/shopping-lists", status: 201, body: { id: "new-list", name: "Party" } },
    ]);
    renderWithProviders(withStore(<ListsPage />), { route: "/shop/lists?new=1" });

    const textarea = await screen.findByLabelText("What do you need?");
    await user.type(textarea, "milk, eggs, milk, 1 kg unobtainium");
    await waitFor(() => expect(screen.getByRole("button", { name: /match products/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /match products/i }));

    const rows = await screen.findAllByTestId("review-item");
    expect(rows).toHaveLength(3);
    expect(screen.getByText(/duplicates merged/i)).toBeInTheDocument();
    expect(within(rows[0]).getByText("55% confidence")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Unresolved")).toBeInTheDocument();

    // Fix the wrong "milk" match and remove nothing else.
    await user.selectOptions(within(rows[0]).getByLabelText(/product for milk/i), "amul");
    const name = screen.getByLabelText("List name");
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: /create list/i }));
    expect(await screen.findByText("Give your list a name")).toBeInTheDocument();

    await user.type(name, "Party");
    await user.click(screen.getByRole("button", { name: /create list/i }));

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/shopping-lists") && init?.method === "POST");
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call![1]!.body));
      expect(body).toMatchObject({ name: "Party", store_id: "s1" });
      expect(body.items).toEqual([
        { raw_text: "milk", product_id: "amul", skip_match: false, quantity: 2, unit: null },
        { raw_text: "eggs", product_id: "eggs", skip_match: false, quantity: 1, unit: null },
        { raw_text: "unobtainium", product_id: null, skip_match: true, quantity: 1, unit: "kg" },
      ]);
    });
  });

  it("shows an empty state when the shopper has no lists", async () => {
    mockApi(baseRoutes);
    renderWithProviders(withStore(<ListsPage />), { route: "/shop/lists" });
    expect(await screen.findByText("No lists yet")).toBeInTheDocument();
  });
});
