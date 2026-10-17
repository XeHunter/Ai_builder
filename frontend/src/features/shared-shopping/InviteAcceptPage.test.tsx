import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { customerMe, mockApi, renderWithProviders } from "@/tests/test-utils";

import InviteAcceptPage from "./InviteAcceptPage";

describe("InviteAcceptPage", () => {
  it("shows the invitation preview", async () => {
    mockApi([
      { path: "/auth/me", body: customerMe },
      { path: "/invitations/tok123", body: { list_name: "Weekend breakfast", owner_name: "Priya Sharma", role: "editor", expires_at: "2026-10-20T10:00:00Z", item_count: 6 } },
    ]);
    renderWithProviders(<InviteAcceptPage />, { route: "/invite/tok123", path: "/invite/:token" });
    expect(await screen.findByText(/invited you to “Weekend breakfast”/)).toBeInTheDocument();
    expect(screen.getByText("Can add, edit and check off items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join list" })).toBeInTheDocument();
  });

  it("explains an expired invitation", async () => {
    mockApi([
      { path: "/auth/me", body: customerMe },
      { path: "/invitations/old", status: 422, body: { error: { code: "invitation_expired", message: "This invitation has expired" } } },
    ]);
    renderWithProviders(<InviteAcceptPage />, { route: "/invite/old", path: "/invite/:token" });
    expect(await screen.findByText("This invitation has expired")).toBeInTheDocument();
    expect(screen.getByText(/Ask the list owner to send you a new link/)).toBeInTheDocument();
  });
});
