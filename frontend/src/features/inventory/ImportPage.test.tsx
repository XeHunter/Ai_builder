import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { callsTo, renderMerchant } from "@/features/merchant-dashboard/components/test-helpers";
import type { MockRoute } from "@/tests/test-utils";

import ImportPage, { checkImportFile } from "./ImportPage";

const validated = {
  id: "imp1", filename: "sample.csv", status: "validated", total_rows: 13, valid_rows: 6, error_rows: 7, warning_rows: 3,
  summary: { would_create_products: 2, rows_creating: 1, rows_updating: 5, unknown_columns: ["colour"], previously_imported_at: null },
  error_message: null, created_at: "2026-10-16T10:00:00Z", committed_at: null,
};
const errorRows = {
  items: [
    {
      row_number: 8, is_valid: false, action: "skip", normalized: null, warnings: [],
      raw: { product_id: "TEA-001", store_id: "AND01", stock_quantity: "-5" },
      errors: [{ field: "stock_quantity", message: "cannot be negative" }],
    },
  ],
  total: 1, page: 1, page_size: 20,
};

describe("checkImportFile", () => {
  it("rejects wrong extensions and files over 5 MB", () => {
    expect(checkImportFile(new File(["a"], "stock.pdf"))).toMatch(/csv or .xlsx/);
    const big = new File(["a"], "big.csv");
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    expect(checkImportFile(big)).toMatch(/limit is 5 MB/);
    expect(checkImportFile(new File(["product_id"], "ok.CSV"))).toBeNull();
  });
});

describe("ImportPage review & commit", () => {
  it("shows error rows with field messages and commits valid rows after confirmation", async () => {
    const user = userEvent.setup();
    const importRoute: MockRoute = { path: "/merchant/inventory/imports/imp1", body: validated };
    const routes: MockRoute[] = [
      importRoute,
      { path: "/merchant/inventory/imports/imp1/rows", body: errorRows },
      { path: "/merchant/inventory/imports", body: [validated] },
      { method: "POST", path: "/merchant/inventory/imports/imp1/commit", body: { job_id: "job1", job_status: "queued", import: { ...validated, status: "committing" } } },
      { path: "/merchant/jobs/job1", body: { id: "job1", job_type: "inventory_import_commit", status: "succeeded", attempts: 1, max_attempts: 1, result: {}, error: null, scheduled_for: "", started_at: null, finished_at: null, created_at: "" } },
    ];
    const { fetchSpy } = renderMerchant(<ImportPage />, { route: "/merchant/inventory/import?id=imp1", routes });

    expect(await screen.findByText(/cannot be negative/)).toBeInTheDocument();
    expect(screen.getByText("-5")).toBeInTheDocument();
    expect(screen.getByText("colour")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Errors \(7\)/ })).toHaveAttribute("data-state", "active");

    // After the commit job finishes the import reports the applied summary.
    importRoute.body = { ...validated, status: "completed", committed_at: "2026-10-16T10:05:00Z", summary: { ...validated.summary, products_created: 1, products_updated: 3, batches_created: 2, batches_updated: 3, placements_set: 1, units_delta: 42 } };

    await user.click(await screen.findByRole("button", { name: /Commit 6 valid rows/ }));
    const dialog = await screen.findByRole("dialog", { name: "Commit this import?" });
    expect(dialog).toHaveTextContent("7 row(s) with errors will be skipped");
    await user.click(screen.getByRole("button", { name: "Commit import" }));

    await waitFor(() => expect(callsTo(fetchSpy, "POST", "/merchant/inventory/imports/imp1/commit")).toHaveLength(1));
    expect(await screen.findByText("Import applied")).toBeInTheDocument();
    expect(screen.getByText("+42")).toBeInTheDocument();
  });

  it("requests rows for the selected tab", async () => {
    const user = userEvent.setup();
    const { fetchSpy } = renderMerchant(<ImportPage />, {
      route: "/merchant/inventory/import?id=imp1",
      routes: [
        { path: "/merchant/inventory/imports/imp1", body: validated },
        { path: "/merchant/inventory/imports/imp1/rows", body: errorRows },
        { path: "/merchant/inventory/imports", body: [] },
      ],
    });
    await user.click(await screen.findByRole("tab", { name: /Warnings/ }));
    await waitFor(() => expect(callsTo(fetchSpy, "GET", "/merchant/inventory/imports/imp1/rows").some(([u]) => String(u).includes("only=warnings"))).toBe(true));
  });
});
