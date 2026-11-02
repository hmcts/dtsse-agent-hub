import { expect, test } from "@playwright/test";
import { asPersona, chatPersona, connectForChat } from "./hub";

const ASSISTANT_OFF = "the Assistant runs on a virtual agent, which is off on this deployment";

/**
 * A person's credentials, in the Assistant's settings. `/hub/settings/credentials`, where the published client's pod
 * boot messages send people to paste a GitHub token, lands on the Credentials section; `routes.spec.ts` checks the redirect itself.
 */
test.describe("credentials @smoke", () => {
  test("should open the Assistant's settings at Credentials when the old credentials address is visited @smoke @regression", async ({
    browser,
    baseURL,
    request
  }) => {
    const persona = chatPersona("credentials");
    await connectForChat(request, persona);
    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/hub/settings/credentials");
      test.skip(new URL(page.url()).pathname === "/hub", ASSISTANT_OFF);
      expect(response?.status()).toBe(200);

      await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("heading", { name: "Credentials" })).toBeVisible();
      expect(new URL(page.url()).search).toBe("");
    } finally {
      await context.close();
    }
  });

  test("should never show a pasted token when it is replaced and then removed @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("tokens");
    await connectForChat(request, persona);
    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant?settings=credentials");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      const dialog = page.getByRole("dialog", { name: "Settings" });
      // Previews and the -staging release have sign-in off, so credentials are unavailable there.
      test.skip(await dialog.getByText(/Your credentials cannot be shown/).isVisible(), "this deployment cannot store a development identity's credentials");

      const token = `sk-ant-oat-${persona.replaceAll("-", "")}${"a".repeat(24)}`;
      await dialog.getByRole("button", { name: "Replace your Claude token" }).click();
      await dialog.getByLabel("New Claude token").fill(token);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog.getByRole("status").filter({ hasText: "Your Claude token is saved" })).toBeVisible();
      expect(await page.content()).not.toContain(token);

      await dialog.getByRole("button", { name: "Remove your Claude token" }).click();
      await expect(dialog.getByText(/cannot answer again until you paste a new one/)).toBeVisible();
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(dialog.getByRole("status").filter({ hasText: "Your Claude token is removed" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
