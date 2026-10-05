import { expect, type Page, test } from "@playwright/test";
import { asPersona, unique } from "./hub";

/** With virtual agents on, `/settings/credentials` sends people to the credentials section of `/virtual`. */
async function openCredentials(page: Page): Promise<void> {
  const response = await page.goto("/settings/credentials");
  expect(response?.status()).toBe(200);
  if (new URL(page.url()).pathname === "/virtual") {
    expect(new URL(page.url()).hash).toBe("#credentials");
    await expect(page.getByRole("region", { name: "Credentials" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { level: 1, name: "Credentials" })).toBeVisible();
  }
}

test.describe("credentials @smoke", () => {
  test("should render the credentials with the viewer's model route @smoke @regression", async ({ page }) => {
    await openCredentials(page);

    await expect(page.getByRole("heading", { name: "Model" })).toBeVisible();
    await expect(page.getByText("Credentials unavailable").or(page.getByRole("heading", { name: "GitHub token" }))).toBeVisible();
  });

  test("should store and delete a pasted token without ever showing it @regression", async ({ browser, baseURL }) => {
    const context = await asPersona(browser, `own-licence-${unique("e2e")}`, baseURL!);
    try {
      const page = await context.newPage();
      await openCredentials(page);
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
