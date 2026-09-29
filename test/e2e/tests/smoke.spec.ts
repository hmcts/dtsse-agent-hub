import { expect, test } from "@playwright/test";

test.describe("smoke @smoke", () => {
  test("should render home with the sidebar @smoke @regression", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("heading", { name: "Agents" })).toBeVisible();
  });

  test("should say sign-in is disabled when the deployment runs without it @smoke", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("note")).toContainText("Sign-in is disabled");
  });
});
