/* Shared fixtures for customer-page tests. */
import type { ReactElement } from "react";

import { ShopperStoreProvider } from "@/hooks/use-stores";
import { customerMe, type MockRoute } from "@/tests/test-utils";
import type { ProductCard, Store } from "@/types/api";

export const testStore: Store = {
  id: "s1",
  code: "AND01",
  name: "FreshMart Andheri West",
  address: "Lokhandwala",
  city: "Mumbai",
  latitude: 19.1364,
  longitude: 72.8296,
  geofence_radius_m: 1000,
  merchant_id: "m1",
};

/** Routes every customer page needs: the session and the store list. */
export const baseRoutes: MockRoute[] = [
  { path: "/auth/me", body: customerMe },
  { path: "/stores", body: [testStore] },
  { path: "/shopping-lists", body: [] },
];

export function withStore(ui: ReactElement): ReactElement {
  return <ShopperStoreProvider>{ui}</ShopperStoreProvider>;
}

export function product(overrides: Partial<ProductCard> = {}): ProductCard {
  return {
    id: "p1",
    sku: "SKU-1",
    name: "Amul Taaza Toned Milk 1 L",
    brand: "Amul",
    description: "Toned milk",
    unit: "1 L",
    category: { id: "c1", name: "Dairy" },
    price: 68,
    promotion: null,
    markdown: null,
    in_stock: true,
    stock_level: "in_stock",
    location: { shelf_location_id: "sl1", shelf_code: "D-2-2", aisle_code: "D", aisle_label: "Dairy & eggs chillers", fixture_label: "Dairy", level: 2, x: 1, y: 1 },
    image_url: null,
    tags: [],
    is_perishable: true,
    ...overrides,
  };
}
