/* Test helpers for merchant operations pages: providers incl. the merchant store context. */
import type { ReactElement } from "react";

import { MerchantStoreProvider } from "@/hooks/use-stores";
import { mockApi, merchantMe, renderWithProviders, type MockRoute } from "@/tests/test-utils";

export const STORES = [
  { id: "s1", code: "AND01", name: "FreshMart Andheri West", city: "Mumbai", latitude: 19.13, longitude: 72.82, geofence_radius_m: 1000, timezone: "Asia/Kolkata" },
  { id: "s2", code: "BAN01", name: "FreshMart Bandra", city: "Mumbai", latitude: 19.05, longitude: 72.82, geofence_radius_m: 1000, timezone: "Asia/Kolkata" },
];

export function meWith(permissions: string[] | ((all: string[]) => string[])) {
  const perms = typeof permissions === "function" ? permissions(merchantMe.merchant.permissions) : permissions;
  return { ...merchantMe, merchant: { ...merchantMe.merchant, permissions: perms } };
}

/** Mocks auth + stores (plus the given routes) and renders inside the merchant store provider. */
export function renderMerchant(ui: ReactElement, { routes = [], route = "/", path = "*", me = merchantMe, storeId }: { routes?: MockRoute[]; route?: string; path?: string; me?: unknown; storeId?: string } = {}) {
  localStorage.clear();
  if (storeId) localStorage.setItem("op.merchant.store", storeId);
  const fetchSpy = mockApi([{ path: "/auth/me", body: me }, { path: "/merchant/stores", body: STORES }, ...routes]);
  const utils = renderWithProviders(<MerchantStoreProvider>{ui}</MerchantStoreProvider>, { route, path });
  return { ...utils, fetchSpy };
}

/** Finds the fetch calls for a method + path (ignores the query string). */
export function callsTo(spy: ReturnType<typeof mockApi>, method: string, path: string | RegExp) {
  return spy.mock.calls.filter(([input, init]) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0];
    const m = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    return m === method && (typeof path === "string" ? url === path : path.test(url));
  });
}

export function bodyOf(call: unknown[]): unknown {
  const init = call[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
}
