import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { groupShelves, StoreMap } from "@/components/maps/StoreMap";
import type { Layout, Shelf } from "@/types/api";

const shelf = (code: string, level: number, x = 5, y = 5): Shelf => ({
  id: code, code, fixture_id: "f1", aisle_code: "A1", section: 1, level, height_cm: level * 40, x, y,
  capacity_facings: 6, is_clearance: false, access_node: "N1",
  products: level === 3 ? [{ placement_id: "p", product_id: "prod", name: "Milk", sku: "MLK", facings: 2, is_primary: true, category: "Dairy" }] : [],
});

const layout: Layout = {
  id: "l1", store_id: "s1", name: "Test", version: 1, status: "active", width_m: 20, height_m: 10, based_on_layout_id: null, published_at: null,
  fixtures: [{ id: "f1", code: "A1-L", kind: "aisle_shelf", label: "Aisle 1", aisle_code: "A1", x: 4, y: 2, width: 1, height: 6, levels: 5, is_chilled: false, is_movable: false }],
  shelves: [shelf("A1-L-1-1", 1), shelf("A1-L-1-3", 3), shelf("A1-L-2-1", 1, 5, 8)],
  nodes: [{ code: "N1", x: 6, y: 5, kind: "walkway", label: null }, { code: "ENT", x: 1, y: 9, kind: "entrance", label: "the entrance" }],
  edges: [{ from: "N1", to: "ENT", distance_m: 6.4, accessible: true, blocked: false }],
};

describe("StoreMap", () => {
  it("groups shelf levels into sections, highest level first", () => {
    const sections = groupShelves(layout.shelves);
    expect(sections).toHaveLength(2);
    expect(sections[0].shelves.map((s) => s.level)).toEqual([3, 1]);
    expect(sections[0].label).toBe("A1-L-1");
  });

  it("renders route stops and calls the section handler from keyboard", () => {
    const onSection = vi.fn();
    render(
      <StoreMap
        layout={layout}
        onSectionClick={onSection}
        route={{
          store_id: "s1", layout_id: "l1", algorithm: "held_karp_exact", total_distance_m: 10, unoptimized_distance_m: 12, saved_distance_m: 2,
          stops: [{ order: 1, node_code: "N1", x: 6, y: 5, items: [] }], path: [{ code: "ENT", x: 1, y: 9 }, { code: "N1", x: 6, y: 5 }],
          steps: [], unrouted: [], accessible_only: false, positioning: "manual_start_point",
        }}
      />,
    );
    expect(screen.getByRole("img", { name: "Store floor plan" })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Your route")).toBeInTheDocument();
    const section = screen.getByRole("button", { name: "Shelf section A1-L-1" });
    fireEvent.keyDown(section, { key: "Enter" });
    expect(onSection).toHaveBeenCalledWith(expect.objectContaining({ label: "A1-L-1" }));
  });
});
