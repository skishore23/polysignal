import { test, expect } from "@playwright/test";

test("dashboard and read API start against a fresh database", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle(/PolySignal/i);
  await expect(page.getByRole("heading", { name: /POLY.*SIGNAL/i })).toBeVisible();

  const wallets = await request.get("/api/wallets");
  expect(wallets.ok()).toBe(true);
  expect(Array.isArray(await wallets.json())).toBe(true);
});
