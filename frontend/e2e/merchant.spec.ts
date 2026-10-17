import path from "node:path";

import { expect, test } from "@playwright/test";

import { apiGet, apiToken, login } from "./helpers";

const SAMPLE_CSV = path.resolve(import.meta.dirname, "../../data/sample/inventory_import_sample.csv");

test("merchant journey: import, expiry markdown approval, forecast, fraud case, audit", async ({ page, request }) => {
  const token = await apiToken(request, "admin@freshmart.demo");
  await login(page, "admin@freshmart.demo");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  // 3-4: import with validation errors, then commit the valid rows
  await page.goto("/merchant/inventory/import");
  await page.getByLabel("Inventory file").setInputFiles(SAMPLE_CSV);
  await page.getByRole("button", { name: "Upload & validate" }).click();
  const commit = page.getByRole("button", { name: /Commit \d+ valid rows?/ });
  await expect(commit).toBeVisible({ timeout: 15_000 });
  await expect(commit).toHaveText(/Commit 6 valid rows/);
  await commit.click();
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page.getByText(/products? created/i).first()).toBeVisible({ timeout: 30_000 });

  // 5-7: the 40-carton milk batch has a markdown recommendation; approve & publish it
  await page.goto("/merchant/expiry");
  await expect(page.getByText("MLK-002-B1").first()).toBeVisible();
  const batches = await apiGet<{ batch_code: string; price_change: { id: string } | null }[]>(request, token, "/merchant/expiry/batches?days=3");
  const milk = batches.find((b) => b.batch_code === "MLK-002-B1");
  expect(milk?.price_change).toBeTruthy();
  await page.goto(`/merchant/pricing?change=${milk!.price_change!.id}`);
  await page.getByRole("button", { name: /Approve & publish/ }).click();
  await expect(page.getByText(/SIM-ESL-/).first()).toBeVisible({ timeout: 15_000 });

  // 8-11: forecast, affinity, layout and merchandising pages render real data
  await page.goto("/merchant/forecasting");
  await expect(page.getByText(/Umbrella/).first()).toBeVisible({ timeout: 15_000 });
  await page.goto("/merchant/cross-selling");
  await expect(page.getByText(/Memory Card/).first()).toBeVisible({ timeout: 15_000 });
  await page.goto("/merchant/layout");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  await page.goto("/merchant/merchandising");
  await expect(page.getByText(/Aashirvaad/).first()).toBeVisible();

  // 12: open a fraud alert and record an outcome
  const alerts = await apiGet<{ items: { id: string; signals: { code: string }[] }[] }>(request, token, "/merchant/fraud/alerts?status=open&page_size=100");
  const dup = alerts.items.find((a) => a.signals.some((s) => s.code === "duplicate_receipt"));
  expect(dup).toBeTruthy();
  await page.goto(`/merchant/fraud?alert=${dup!.id}`);
  await page.getByRole("button", { name: /Start investigation/ }).click();
  await page.getByRole("button", { name: /Close with outcome/ }).click();
  await page.getByLabel("Outcome").selectOption("confirmed_fraud");
  await page.getByLabel("Reviewer note").fill("Second refund of the same receipt confirmed at the service desk.");
  await page.locator("form").filter({ has: page.getByLabel("Reviewer note") }).getByRole("button", { name: /Close case/ }).click();
  await expect(page.getByText(/Confirmed fraud/).first()).toBeVisible({ timeout: 15_000 });

  // 13: audit events for the actions above
  await page.goto("/merchant/settings");
  await expect(page.getByText("pricing.price_change.published").first()).toBeVisible({ timeout: 15_000 });
});
