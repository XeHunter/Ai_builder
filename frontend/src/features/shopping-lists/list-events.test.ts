import { describe, expect, it } from "vitest";

import type { ListEvent } from "@/lib/list-socket";
import type { ListItem, ShoppingListView } from "@/types/api";

import { applyListEvent, applyListEvents, computeGroups, needsProductData, withOverrides } from "./list-events";

const milkCard = {
  id: "p-milk", sku: "M", name: "Amul Milk", brand: null, description: "", unit: "1 L", category: null, price: 68,
  promotion: null, markdown: null, in_stock: true, stock_level: "in_stock" as const,
  location: { shelf_location_id: "x", shelf_code: "D-2-2", aisle_code: "D", aisle_label: "Dairy", fixture_label: "Dairy", level: 2, x: 0, y: 0 },
  image_url: null, tags: [], is_perishable: true,
};

function item(overrides: Partial<ListItem> = {}): ListItem {
  return {
    id: "i1", raw_text: "milk", display_name: "Amul Milk", product_id: "p-milk", quantity: 1, unit: null, status: "pending",
    match_confidence: 1, candidates: [], position: 0, version: 1, collected_by_id: null, collected_at: null, updated_at: null,
    product: milkCard, ...overrides,
  };
}

function list(items: ListItem[], version = 5): ShoppingListView {
  return {
    id: "l1", name: "Weekly", status: "active", is_shared: false, version, store: { id: "s1", name: "S", code: "S" }, raw_input: null,
    items, groups: [], progress: { total: items.length, collected: 0, unresolved: 0, unavailable: 0, percent: 0 }, my_role: "owner",
    members: [{ user_id: "u1", name: "Priya", role: "owner" }], updated_at: "2026-01-01T00:00:00Z",
  };
}

function ev(seq: number, type: string, payload: Record<string, unknown>, item_id: string | null = null): ListEvent {
  return { seq, type, item_id, actor_id: "u2", actor_name: "Rohan", payload, client_event_id: null, created_at: "2026-01-02T00:00:00Z" };
}

describe("applyListEvent", () => {
  it("marks an item collected, keeps its product card and updates progress", () => {
    const next = applyListEvent(list([item()]), ev(6, "item_collected", { item: { ...item({ status: "collected", version: 2 }), product: null } }, "i1"));
    expect(next.version).toBe(6);
    expect(next.items[0].status).toBe("collected");
    expect(next.items[0].product?.name).toBe("Amul Milk");
    expect(next.progress).toMatchObject({ total: 1, collected: 1, percent: 100 });
  });

  it("ignores events at or below the current list version (idempotent replay)", () => {
    const base = list([item()], 5);
    const next = applyListEvent(base, ev(5, "item_removed", { item: item() }, "i1"));
    expect(next).toBe(base);
  });

  it("never lets a stale item version overwrite a newer one", () => {
    const base = list([item({ version: 4, quantity: 3 })], 5);
    const next = applyListEvent(base, ev(6, "item_updated", { item: { ...item({ version: 3, quantity: 1 }), product: null } }, "i1"));
    expect(next.items[0].quantity).toBe(3);
    expect(next.version).toBe(6);
  });

  it("adds new items without a product card and reports that a refetch is needed", () => {
    const added = { ...item({ id: "i2", raw_text: "eggs", display_name: "Eggs", product_id: "p-eggs", position: 1 }), product: null };
    const next = applyListEvent(list([item()]), ev(6, "item_added", { item: added }, "i2"));
    expect(next.items).toHaveLength(2);
    expect(next.items[1].product).toBeNull();
    expect(needsProductData(next)).toBe(true);
    expect(computeGroups(next.items).map((g) => g.key)).toEqual(["D", "syncing"]);
  });

  it("drops the product card when the product match changes", () => {
    const next = applyListEvent(list([item()]), ev(6, "item_updated", { item: { ...item({ product_id: "p-other", version: 2 }), product: null } }, "i1"));
    expect(next.items[0].product).toBeNull();
  });

  it("removes items, adds members and renames the list", () => {
    const next = applyListEvents(list([item(), item({ id: "i2", position: 1 })]), [
      ev(8, "list_updated", { name: "Party" }),
      ev(6, "item_removed", { item: item() }, "i1"),
      ev(7, "member_joined", { user_id: "u2", name: "Rohan", role: "editor" }),
    ]);
    expect(next.items.map((i) => i.id)).toEqual(["i2"]);
    expect(next.members.map((m) => m.name)).toEqual(["Priya", "Rohan"]);
    expect(next.is_shared).toBe(true);
    expect(next.name).toBe("Party");
    expect(next.version).toBe(8);
  });
});

describe("withOverrides", () => {
  it("overlays optimistic status, quantity and removal", () => {
    const items = [item(), item({ id: "i2" }), item({ id: "i3" })];
    const out = withOverrides(items, {
      i1: { cid: "a", status: "collected" },
      i2: { cid: "b", removed: true },
      i3: { cid: "c", quantity: 4 },
    });
    expect(out.map((i) => [i.id, i.status, i.quantity])).toEqual([
      ["i1", "collected", 1],
      ["i3", "pending", 4],
    ]);
  });
});

describe("computeGroups", () => {
  it("orders aisles like the store walk and puts unresolved items last", () => {
    const loc = (aisle: string) => ({ ...milkCard, location: { ...milkCard.location, aisle_code: aisle, aisle_label: `Aisle ${aisle}` } });
    const groups = computeGroups([
      item({ id: "a", product: loc("D") }),
      item({ id: "b", product: loc("A2"), position: 1 }),
      item({ id: "c", product_id: null, product: null, status: "unresolved", position: 2 }),
      item({ id: "d", product: loc("P"), position: 3 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["P", "A2", "D", "unresolved"]);
  });
});
