import { expect, test } from "@playwright/test";
import { asPersona, unique } from "./hub";

test.describe("credentials @smoke", () => {
  test("should render the credentials page with the viewer's model route @smoke @regression", async ({ page }) => {
    const response = await page.goto("/settings/credentials");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Credentials" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Model" })).toBeVisible();
    await expect(page.getByText("Credentials unavailable").or(page.getByRole("heading", { name: "GitHub token" }))).toBeVisible();
  });

  test("should store and delete a pasted token without ever showing it @regression", async ({ browser, baseURL }) => {
    const context = await asPersona(browser, `own-licence-${unique("e2e")}`, baseURL!);
    try {
      const page = await context.newPage();
      await page.goto("/settings/credentials");
      // Previews and the -staging release have sign-in off, so credentials are unavailable there.
      test.skip(await page.getByText("Credentials unavailable").isVisible(), "this deployment cannot store a development identity's credentials");

      const token = `ghp_${unique("e2e").replaceAll("-", "")}${"a".repeat(24)}`;
      const github = page.getByRole("form", { name: "Save GitHub token" });
      await github.getByLabel("Paste a GitHub token").fill(token);
      await github.getByRole("button", { name: "Save" }).click();

      await expect(page.getByRole("status").filter({ hasText: "Your GitHub token is stored" })).toBeVisible();
      await expect(page.getByRole("form", { name: "Delete GitHub token" })).toBeVisible();
      await expect(page.getByLabel("Paste a Claude token")).toBeVisible();
      expect(await page.content()).not.toContain(token);

      await page.getByRole("form", { name: "Delete GitHub token" }).getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("form", { name: "Delete GitHub token" })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
