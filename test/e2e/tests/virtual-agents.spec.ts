import { expect, test } from "@playwright/test";
import { asPersona, unique } from "./hub";

test.describe("virtual agents @regression", () => {
  test("should offer the create form when the person has no virtual agents @regression", async ({ browser, baseURL }) => {
    const context = await asPersona(browser, unique("va-none"), baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/hub/virtual");
      test.skip(response?.status() === 404, "virtual agents are off on this deployment");

      expect(response?.status()).toBe(200);
      await expect(page.getByText("You have no virtual agents.")).toBeVisible();
      const form = page.getByRole("form", { name: "Create a virtual agent" });
      await expect(form.getByLabel("Name")).toBeVisible();
      await expect(form.getByRole("button", { name: "Create" })).toBeEnabled();
    } finally {
      await context.close();
    }
  });
});
