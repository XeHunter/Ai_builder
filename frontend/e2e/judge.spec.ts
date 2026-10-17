import { expect, test, type Page } from "@playwright/test";

/**
 * The judge journeys on a deployed demo: one-click personas, omnichannel orders landing on the
 * owner's live feed, and a brand-new store going live through the onboarding wizard.
 * Set E2E_SHOTS=<dir> to save screenshots of each screen.
 */
const SHOTS = process.env.E2E_SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("one-click store owner: AI brief, POS simulator and live feed", async ({ page }) => {
  await page.goto("/login");
  await shot(page, "01-login");
  await page.getByRole("button", { name: /Enter as Store Owner/ }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Today's AI brief")).toBeVisible();
  await expect(page.getByText(/Take action/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "02-owner-overview");

  await page.goto("/merchant/channels");
  await expect(page.getByRole("heading", { name: /Channels/ })).toBeVisible();
  await page.getByRole("button", { name: /Ring up random basket/ }).click();
  await expect(page.getByText(/AND01-POS-|BAN01-POS-/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "03-owner-channels");
});

test("one-click customer: click & collect lands on the owner's feed", async ({ page, browser }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /Enter as Customer/ }).click();
  await expect(page).toHaveURL(/\/shop/);
  await shot(page, "04-customer-home");
  await page.goto("/shop/lists");
  await page.getByRole("link", { name: /Weekend breakfast/ }).first().click();
  // add something new so there is always an uncollected item to order (the demo may have been used)
  await page.getByLabel("Add an item").fill("2 bananas");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Order for pickup" })).toBeVisible();
  await shot(page, "05-customer-list");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText("Ready for pickup soon")).toBeVisible({ timeout: 15_000 });
  const receipt = (await page.getByText(/^[A-Z0-9]+-ONL-[A-F0-9]+$/).first().textContent())?.trim() ?? "";
  expect(receipt).toMatch(/-ONL-/);
  await shot(page, "06-customer-ordered");

  const owner = await (await browser.newContext()).newPage();
  await owner.goto("/login");
  await owner.getByRole("button", { name: /Enter as Store Owner/ }).click();
  await expect(owner.getByRole("heading", { name: "Overview" })).toBeVisible();
  await owner.goto("/merchant/channels");
  await expect(owner.getByText(receipt).first()).toBeVisible({ timeout: 15_000 });
  await expect(owner.getByText("Priya Sharma").first()).toBeVisible();
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/07-owner-sees-order.png`, fullPage: true });
});

test("new store owner goes live through the setup wizard", async ({ page }) => {
  const email = `owner${Date.now()}@kirana.example`;
  await page.goto("/onboarding");
  await page.getByLabel(/Business name/i).fill("Sharma Kirana Mart");
  await page.getByLabel(/Your name|Full name/i).fill("Rakesh Sharma");
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/Password/i).fill("Kirana@2026");
  await shot(page, "08-signup");
  await page.getByRole("button", { name: /Create|Sign up|Get started/i }).click();
  await expect(page).toHaveURL(/\/merchant\/setup/);

  await page.getByLabel(/Store name/i).fill("Sharma Kirana Mart - Pune");
  await page.getByLabel(/City/i).fill("Pune");
  await page.getByRole("button", { name: /Create store/i }).click();
  await page.getByRole("button", { name: /Continue/i }).click();
  await expect(page.getByRole("button", { name: /Use this floor plan/i })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot(page, "09-layout-builder");
  await page.getByRole("button", { name: /Use this floor plan/i }).click();
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByRole("button", { name: /starter catalog/i }).first().click();
  await page.getByRole("button", { name: /Add \d+ valid rows?/ }).click({ timeout: 30_000 });
  await expect(page.getByText(/completed|imported/i).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "10-catalog");
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByRole("button", { name: /sample sales/i }).click();
  await expect(page.getByText(/Bills imported/i).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByRole("button", { name: /Create POS API key/i }).click();
  await expect(page.getByText(/op_live_/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "11-channels-step");
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByRole("button", { name: /Run first analytics/i }).click();
  await expect(page.getByRole("link", { name: /Open dashboard/i })).toBeVisible({ timeout: 120_000 });
  await shot(page, "12-finish");
});
