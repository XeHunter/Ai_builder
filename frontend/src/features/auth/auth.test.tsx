import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/app/providers";
import LoginPage, { loginSchema } from "@/features/auth/LoginPage";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { customerMe, merchantMe, mockApi } from "@/tests/test-utils";

function renderAt(route: string, routes: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>{routes}</Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

describe("login", () => {
  it("validates the form schema", () => {
    expect(loginSchema.safeParse({ email: "nope", password: "" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });

  it("shows field errors and the server error message", async () => {
    mockApi([
      { path: "/auth/me", status: 401, body: { error: { code: "not_authenticated", message: "Authentication required" } } },
      { method: "POST", path: "/auth/login", status: 401, body: { error: { code: "invalid_credentials", message: "Incorrect email or password" } } },
    ]);
    renderAt("/login", <Route path="/login" element={<LoginPage />} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "priya@demo.omnipulse.ai");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Incorrect email or password")).toBeInTheDocument();
  });

  it("demo account buttons fill the form", async () => {
    mockApi([{ path: "/auth/me", status: 401, body: { error: { code: "not_authenticated", message: "x" } } }]);
    renderAt("/login", <Route path="/login" element={<LoginPage />} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /FreshMart admin/ }));
    expect(screen.getByLabelText("Email")).toHaveValue("admin@freshmart.demo");
  });
});

describe("RequireAuth", () => {
  const routes = (
    <>
      <Route path="/login" element={<p>login page</p>} />
      <Route path="/shop" element={<p>shop home</p>} />
      <Route path="/merchant" element={<p>merchant home</p>} />
      <Route
        path="/merchant/pricing"
        element={
          <RequireAuth kind="merchant" permission="pricing.read">
            <p>pricing page</p>
          </RequireAuth>
        }
      />
    </>
  );

  it("redirects anonymous users to login", async () => {
    mockApi([{ path: "/auth/me", status: 401, body: { error: { code: "not_authenticated", message: "x" } } }]);
    renderAt("/merchant/pricing", routes);
    expect(await screen.findByText("login page")).toBeInTheDocument();
  });

  it("sends shoppers away from merchant pages", async () => {
    mockApi([{ path: "/auth/me", body: customerMe }]);
    renderAt("/merchant/pricing", routes);
    expect(await screen.findByText("shop home")).toBeInTheDocument();
  });

  it("blocks merchants without the permission", async () => {
    mockApi([{ path: "/auth/me", body: { ...merchantMe, merchant: { ...merchantMe.merchant, permissions: ["insights.read"] } } }]);
    renderAt("/merchant/pricing", routes);
    expect(await screen.findByText("You don't have access to this page")).toBeInTheDocument();
  });

  it("renders the page for permitted merchants", async () => {
    mockApi([{ path: "/auth/me", body: merchantMe }]);
    renderAt("/merchant/pricing", routes);
    await waitFor(() => expect(screen.getByText("pricing page")).toBeInTheDocument());
  });
});
