import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers";

import { bodyOf, callsTo, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";
import { merchantMe, mockApi, renderWithProviders } from "@/tests/test-utils";

import { firstIncomplete } from "./onboarding-api";
import SetupWizardPage from "./SetupWizardPage";
import SignupPage, { signupSchema } from "./SignupPage";
import type { OnboardingStatus } from "./types";

const unauthenticated = { path: "/auth/me", status: 401, body: { error: { code: "not_authenticated", message: "Authentication required" } } };

function statusWith(steps: Partial<OnboardingStatus["steps"]>): OnboardingStatus {
  return {
    steps: { store: false, layout: false, catalog: false, history: false, channels: false, ...steps },
    complete: false,
    stores: steps.store ? [{ id: "s9", code: "PUN01", name: "Sharma Fresh Mart", city: "Pune" }] : [],
    counts: { products: 0, stocked_items: 0, sales: 0, api_keys: 0 },
  };
}

describe("store-owner sign-up", () => {
  it("validates the password length before calling the API", async () => {
    expect(signupSchema.safeParse({ business_name: "Sharma Mart", full_name: "Ravi Sharma", email: "ravi@example.com", password: "short" }).success).toBe(false);
    const fetchSpy = mockApi([unauthenticated]);
    renderWithProviders(<SignupPage />, { route: "/onboarding" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Business name"), "Sharma Fresh Mart");
    await user.type(screen.getByLabelText("Your name"), "Ravi Sharma");
    await user.type(screen.getByLabelText("Email"), "ravi@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: /Create account/ }));
    expect(await screen.findByText("Use at least 8 characters")).toBeInTheDocument();
    expect(callsTo(fetchSpy, "POST", "/onboarding/merchant")).toHaveLength(0);
  });

  it("shows a 409 (email already registered) next to the email field", async () => {
    mockApi([
      unauthenticated,
      { method: "POST", path: "/onboarding/merchant", status: 409, body: { error: { code: "conflict", message: "Email already registered" } } },
    ]);
    renderWithProviders(<SignupPage />, { route: "/onboarding" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Business name"), "Sharma Fresh Mart");
    await user.type(screen.getByLabelText("Your name"), "Ravi Sharma");
    await user.type(screen.getByLabelText("Email"), "ravi@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough1");
    await user.click(screen.getByRole("button", { name: /Create account/ }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });

  it("sends signed-in merchants straight to the setup wizard", async () => {
    mockApi([{ path: "/auth/me", body: merchantMe }]);
    render(
      <AppProviders client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/onboarding"]}>
          <Routes>
            <Route path="/onboarding" element={<SignupPage />} />
            <Route path="/merchant/setup" element={<p>setup wizard</p>} />
          </Routes>
        </MemoryRouter>
      </AppProviders>,
    );
    expect(await screen.findByText("setup wizard")).toBeInTheDocument();
  });
});

describe("setup wizard", () => {
  it("resumes at the first incomplete step", () => {
    expect(firstIncomplete({ store: true, layout: true, catalog: false, history: false, channels: true })).toBe("catalog");
    expect(firstIncomplete({ store: true, layout: true, catalog: true, history: true, channels: true })).toBe("finish");
  });

  it("starts at the first incomplete step and lets the owner revisit completed ones", async () => {
    renderMerchant(<SetupWizardPage />, {
      route: "/merchant/setup",
      routes: [{ path: "/merchant/onboarding/status", body: statusWith({ store: true, layout: true }) }],
    });
    const current = await screen.findByRole("button", { name: "Step 3: Products & stock" });
    expect(current).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Step 1: Store details (done)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Use the starter catalog/ })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Step 1: Store details (done)" }));
    expect(screen.getByRole("button", { name: "Step 1: Store details (done)" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Sharma Fresh Mart", { selector: "p" })).toBeInTheDocument();
  });

  it("locks later steps until a store exists", async () => {
    renderMerchant(<SetupWizardPage />, { route: "/merchant/setup", routes: [{ path: "/merchant/onboarding/status", body: statusWith({}) }] });
    expect(await screen.findByRole("button", { name: "Step 1: Store details" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: "Step 2: Floor plan" })).toBeDisabled();
    expect(screen.getByLabelText("Latitude")).toHaveValue(18.5204);
    expect(screen.getByLabelText("Longitude")).toHaveValue(73.8567);
  });

  it("creates a POS key and shows the secret once", async () => {
    const { fetchSpy } = renderMerchant(<SetupWizardPage />, {
      route: "/merchant/setup",
      routes: [
        { path: "/merchant/onboarding/status", body: statusWith({ store: true, layout: true, catalog: true, history: true }) },
        {
          method: "POST", path: "/merchant/channels/keys", status: 201,
          body: { id: "k1", name: "Counter 1 billing", channel: "pos", provider: "generic", prefix: "op_live_ab", store_id: "s9", store_code: "PUN01", created_at: "2026-10-17T10:00:00Z", secret: "op_live_abc123secret" },
        },
      ],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Create POS API key/ }));
    expect(await screen.findByText("op_live_abc123secret")).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();
    const [call] = callsTo(fetchSpy, "POST", "/merchant/channels/keys");
    expect(bodyOf(call)).toEqual({ name: "Counter 1 billing", channel: "pos", provider: "generic", store_id: "s9" });
  });
});
