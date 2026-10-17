import { describe, expect, it, vi } from "vitest";

import { api, ApiError, buildUrl, errorMessage } from "@/lib/api";

describe("api client", () => {
  it("builds versioned URLs and drops empty query params", () => {
    expect(buildUrl("/stores", { q: "milk", page: 2, empty: "", none: null })).toBe("/api/v1/stores?q=milk&page=2");
  });

  it("parses the backend error envelope into ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "business_rule_violation", message: "Blocked", details: { violations: ["Below floor."] }, request_id: "r1" } }), {
          status: 422,
        }),
      ),
    );
    const err = (await api.post("/merchant/pricing/changes", {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("business_rule_violation");
    expect(err.requestId).toBe("r1");
    expect(errorMessage(err)).toBe("Blocked: Below floor.");
  });

  it("reports network failures clearly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const err = (await api.get("/stores").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("network_error");
  });

  it("sends JSON bodies with credentials", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await api.post("/auth/login", { email: "a@b.c" });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.c" });
  });
});
