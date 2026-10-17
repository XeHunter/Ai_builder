import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { baseRoutes, withStore } from "@/features/shopping-assistant/test-fixtures";
import { mockApi, renderWithProviders } from "@/tests/test-utils";

import OffersPage from "./OffersPage";

const prefs = {
  in_app_enabled: true, email_enabled: false, sms_enabled: false, push_enabled: false, marketing_opt_in: true,
  location_consent: true, location_consent_at: "2026-10-01T00:00:00Z", abandoned_list_reminders: true, cooldown_minutes: 240,
};

const offers = {
  promotions: [
    { id: "pr1", name: "Monsoon Tea Time", description: "10% off tea", ends_at: "2026-10-25T00:00:00Z", promo_type: "percent_off", discount_value: 10, nearby_only: false, products: ["Tata Tea"] },
    { id: "pr2", name: "Nearby: Hot drinks", description: "15% off coffee", ends_at: "2026-10-23T00:00:00Z", promo_type: "percent_off", discount_value: 15, nearby_only: true, products: [] },
  ],
  coupons: [],
};

describe("OffersPage", () => {
  beforeEach(() => localStorage.clear());

  it("labels proximity offers and claims regular ones", async () => {
    const user = userEvent.setup();
    const spy = mockApi([
      ...baseRoutes,
      { path: "/offers", body: offers },
      { path: "/me/preferences", body: prefs },
      { method: "POST", path: "/offers/pr1/claim", body: { code: "TEA-1234", new: true, expires_at: "2026-10-25T00:00:00Z" } },
    ]);
    renderWithProviders(withStore(<OffersPage />), { route: "/shop/offers" });
    expect(await screen.findByText("Monsoon Tea Time")).toBeInTheDocument();
    expect(screen.getByText("Only near the store")).toBeInTheDocument();
    // Only the non-proximity offer can be claimed.
    const claims = screen.getAllByRole("button", { name: "Claim coupon" });
    expect(claims).toHaveLength(1);
    await user.click(claims[0]);
    await waitFor(() => expect(spy.mock.calls.some(([url, init]) => String(url).includes("/offers/pr1/claim") && init?.method === "POST")).toBe(true));
  });

  it("shows a consent prompt when the location report is refused (403)", async () => {
    const user = userEvent.setup();
    const spy = mockApi([
      ...baseRoutes,
      { path: "/offers", body: offers },
      { path: "/me/preferences", body: prefs },
      { method: "PATCH", path: "/me/preferences", body: { ...prefs, location_consent: true } },
      {
        method: "POST",
        path: "/me/location",
        status: 403,
        body: { error: { code: "forbidden", message: "Location consent is required; enable it in your notification preferences" } },
      },
    ]);
    renderWithProviders(withStore(<OffersPage />), { route: "/shop/offers" });
    const near = await screen.findByRole("button", { name: "Near FreshMart Andheri West" });
    await user.click(near);

    expect(await screen.findByText("Location consent is off")).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).includes("/me/location"));
    const body = JSON.parse(String(call![1]!.body));
    expect(body.simulated).toBe(true);
    expect(body.latitude).toBeGreaterThan(19.1364);
    expect(body.latitude - 19.1364).toBeLessThan(0.002);

    await user.click(screen.getByRole("button", { name: "Enable location consent" }));
    await waitFor(() => {
      const patch = spy.mock.calls.find(([url, init]) => String(url).includes("/me/preferences") && init?.method === "PATCH");
      expect(JSON.parse(String(patch![1]!.body))).toEqual({ location_consent: true });
    });
  });
});
