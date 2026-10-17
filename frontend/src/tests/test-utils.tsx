/* Test helpers: render with providers and mock the fetch-based API client. */
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { AppProviders } from "@/app/providers";

export type MockRoute = { method?: string; path: string | RegExp; status?: number; body: unknown };

/** Mock global fetch with simple path matching against `/api/v1...` URLs. Returns the spy. */
export function mockApi(routes: MockRoute[]) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0];
    const match = routes.find((r) => (r.method ?? "GET").toUpperCase() === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)));
    if (!match) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: `No mock for ${method} ${path}` } }), { status: 404 });
    }
    return new Response(match.status === 204 ? null : JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

export function renderWithProviders(ui: ReactElement, { route = "/", path = "*" }: { route?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={ui} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

export const customerMe = {
  user: { id: "u1", email: "priya@demo.omnipulse.ai", full_name: "Priya Sharma", account_type: "customer", preferred_store_id: "s1" },
  merchant: null,
};

export const merchantMe = {
  user: { id: "u2", email: "admin@freshmart.demo", full_name: "Anita Desai", account_type: "merchant", preferred_store_id: null },
  merchant: {
    merchant_id: "m1", merchant_name: "FreshMart", role: "merchant_admin", all_stores: true, store_ids: [],
    permissions: ["insights.read", "inventory.read", "inventory.write", "inventory.import", "pricing.read", "pricing.approve",
      "pricing.publish", "pricing.recommend", "expiry.manage", "catalog.read", "catalog.write", "forecast.read", "forecast.run",
      "layout.read", "layout.write", "merchandising.read", "merchandising.manage", "affinity.read", "affinity.run",
      "fraud.read", "fraud.investigate", "settings.manage", "integrations.manage", "audit.read"],
  },
};
