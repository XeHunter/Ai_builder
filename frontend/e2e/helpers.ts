import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const PASSWORD = "Demo@12345";
export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8000";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Bearer token for direct API calls used to look up ids for deep links. */
export async function apiToken(request: APIRequestContext, email: string): Promise<string> {
  const r = await request.post(`${API}/api/v1/auth/login`, { data: { email, password: PASSWORD } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).access_token;
}

export async function apiGet<T>(request: APIRequestContext, token: string, path: string): Promise<T> {
  const r = await request.get(`${API}/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(r.ok()).toBeTruthy();
  return r.json() as Promise<T>;
}
