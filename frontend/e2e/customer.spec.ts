import path from "node:path";

import { expect, test } from "@playwright/test";

import { login } from "./helpers";

const SAMPLE_PHOTO = path.resolve(import.meta.dirname, "../../data/sample/query_images/photo_sea-001.jpg");

test("shopper journey: smart list, route, shared sync, photo search, assistant", async ({ page, browser }) => {
  await login(page, "priya@demo.omnipulse.ai");
  await expect(page.getByText("Best sellers at this store")).toBeVisible();

  // 3-5: parse the demo list and review matches
  await page.goto("/shop/lists?new=1");
  await page.getByLabel("What do you need?").fill("Milk, eggs, bread, chocolate, diapers, detergent, and coffee.");
  await page.getByRole("button", { name: /match products/i }).click();
  await expect(page.getByText("Review your list")).toBeVisible();
  await page.getByLabel("List name").fill("E2E groceries");
  await page.getByRole("button", { name: "Create list" }).click();

  // 6-8: live list, route on the map, collect an item
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Plan my route" }).click();
  await expect(page.getByText(/walk ·/)).toBeVisible();
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  await page.getByRole("checkbox").first().click();
  await expect(page.getByRole("checkbox").first()).toBeChecked();

  // 9-10: share with Rohan and verify real-time synchronisation
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByRole("button", { name: "Create invitation link" }).click();
  await expect(page.getByAltText("QR code for the invitation link")).toBeVisible();
  const inviteUrl = await page.getByRole("textbox", { name: "Invitation link" }).inputValue();
  await page.keyboard.press("Escape");

  const rohanCtx = await browser.newContext();
  const rohan = await rohanCtx.newPage();
  await login(rohan, "rohan@demo.omnipulse.ai");
  await rohan.goto(new URL(inviteUrl).pathname);
  await rohan.getByRole("button", { name: "Join list" }).click();
  await expect(rohan.getByText("Live", { exact: true })).toBeVisible({ timeout: 15_000 });
  await rohan.getByLabel("Add an item").fill("2 kg rice");
  await rohan.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/rice/i).first()).toBeVisible({ timeout: 10_000 });
  await rohanCtx.close();

  // 11: photo search
  await page.goto("/shop/visual");
  await page.locator("input[type=file]").first().setInputFiles(SAMPLE_PHOTO);
  await expect(page.getByText(/% match/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Umbrella/).first()).toBeVisible();

  // 12: complementary product recommendation
  await page.goto("/shop/assistant");
  await page.getByRole("button", { name: "Which compatible memory card goes with this camera?" }).click();
  await expect(page.getByText(/SanDisk/).first()).toBeVisible({ timeout: 15_000 });
});
