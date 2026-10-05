import { expect, test } from "@playwright/test";
import { asPersona, unique } from "./hub";

test.describe("virtual agents @regression", () => {
  test("should create a virtual agent, show a sign-in its pod relays, and delete it @regression", async ({ browser, baseURL, request }) => {
    const persona = unique("va");
    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/virtual");
      test.skip(response?.status() === 404, "virtual agents are off on this deployment");

      await expect(page.getByRole("heading", { level: 1, name: "Virtual agents" })).toBeVisible();
      await expect(page.getByText("A virtual agent acts with your GitHub and Azure access.")).toBeVisible();
      const name = unique("e2e").toLowerCase();
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: "Create" }).click();
      await expect(page.getByRole("status").filter({ hasText: `${name} is starting` })).toBeVisible();

      await page.getByRole("link", { name }).click();
      await page.waitForURL(/\/virtual\/[0-9a-f-]{36}$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(page.getByRole("list", { name: "Sign-ins" }).getByRole("heading", { name: "GitHub" })).toBeVisible();

      // Only a development build accepts X-Dev-Orchestrator; anywhere else the orchestrator's own token is needed.
      const claim = await request.post("/api/orchestrator/claim", { headers: { "x-dev-orchestrator": "e2e" }, data: { cluster: "e2e" } });
      if (claim.status() === 200) {
        const claimed = ((await claim.json()) as { virtual_agents: { id: string; launch_token?: string }[] }).virtual_agents.find((entry) => entry.id === id);
        expect(claimed?.launch_token).toBeDefined();
        const login = await request.post(`/api/virtual/${id}/login/github`, {
          headers: { authorization: `Bearer ${claimed!.launch_token}` },
          data: { prompt: "device_code", verification_uri: "https://github.com/login/device", user_code: "WXYZ-9876", expires_in: 600 }
        });
        expect(login.status()).toBe(204);
        await expect(page.getByText("WXYZ-9876")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("link", { name: "https://github.com/login/device" })).toBeVisible();
      }

      await page.getByRole("button", { name: "Delete" }).click();
      await page
        .getByRole("group", { name: `Confirm deleting ${name}` })
        .getByRole("button", { name: `Delete ${name}` })
        .click();
      await expect(page.getByText("This virtual agent and its disk are being deleted.")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("should keep one person's virtual agent from another @regression", async ({ browser, baseURL }) => {
    const owner = await asPersona(browser, unique("va-owner"), baseURL!);
    const other = await asPersona(browser, unique("va-other"), baseURL!);
    try {
      const page = await owner.newPage();
      const response = await page.goto("/virtual");
      test.skip(response?.status() === 404, "virtual agents are off on this deployment");
      const name = unique("mine").toLowerCase();
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: "Create" }).click();
      await page.getByRole("link", { name }).click();
      await page.waitForURL(/\/virtual\/[0-9a-f-]{36}$/);
      const path = new URL(page.url()).pathname;

      const theirs = await other.newPage();
      expect((await theirs.goto(path))?.status()).toBe(404);
      await theirs.goto("/virtual");
      await expect(theirs.getByRole("link", { name })).toHaveCount(0);

      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: `Delete ${name}` }).click();
      await expect(page.getByText("This virtual agent and its disk are being deleted.")).toBeVisible();
    } finally {
      await owner.close();
      await other.close();
    }
  });
});
