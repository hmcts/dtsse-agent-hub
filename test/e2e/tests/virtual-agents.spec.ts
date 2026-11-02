import { expect, type Page, test } from "@playwright/test";
import { asPersona, chatPersona, connectForChat, dismissGettingReady, openLocalChat, registerAgent, unique } from "./hub";

const ASSISTANT_OFF = "the Assistant runs on a virtual agent, which is off on this deployment";
const CANNOT_REGISTER = "this deployment checks real agent tokens, so the suite cannot register an agent";

/** Opens the Assistant's settings at the section the navigation calls `section`. */
async function settings(page: Page, section: string): Promise<void> {
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { name: section }).click();
}

test.describe("virtual agents @regression", () => {
  test("should open the Assistant section of its settings when an old virtual agents address is visited @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("va-old");
    await connectForChat(request, persona);
    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      for (const old of ["/hub/virtual", "/hub/virtual/0f8a6a1e-0000-4000-8000-000000000001"]) {
        await page.goto(old);
        test.skip(new URL(page.url()).pathname === "/hub", ASSISTANT_OFF);
        await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("heading", { name: "Your assistant" })).toBeVisible();
        expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe("/assistant");
      }
    } finally {
      await context.close();
    }
  });

  /**
   * The Assistant's own agent through its settings: made on the first visit, a sign-in its pod relays, the web
   * servers it reports, a rename and a restart. The pod is stood in for with the orchestrator's development header,
   * which only a development build accepts; anywhere else the parts that need a pod are left out.
   */
  test("should show the Assistant's agent, a sign-in and web servers its pod relays, and rename and restart it, when its settings are opened @regression", async ({
    browser,
    baseURL,
    request
  }) => {
    const persona = chatPersona("va");
    await connectForChat(request, persona);
    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);

      await settings(page, "Assistant");
      await expect(page.getByRole("heading", { name: "Your assistant" })).toBeVisible();
      await expect(page.getByLabel("Name")).toHaveValue("assistant");

      const claim = await request.post("/api/orchestrator/claim", { headers: { "x-dev-orchestrator": "e2e" }, data: { cluster: "e2e" } });
      if (claim.status() === 200) {
        const claimed = ((await claim.json()) as { virtual_agents: { id: string; owner: { oid: string }; launch_token?: string }[] }).virtual_agents.find(
          (entry) => entry.owner.oid === `dev-${persona}`
        );
        expect(claimed?.launch_token).toBeDefined();
        const id = claimed!.id;
        const token = { authorization: `Bearer ${claimed!.launch_token}` };

        const login = await request.post(`/api/virtual/${id}/login/atlassian`, {
          headers: token,
          data: { prompt: "device_code", verification_uri: "https://id.atlassian.com/login/device", user_code: "WXYZ-9876", expires_in: 600 }
        });
        expect(login.status()).toBe(204);
        const ports = await request.put(`/api/virtual/${id}/ports`, { headers: token, data: { ports: [3000], local_only: [5173] } });
        expect(ports.status()).toBe(204);

        await page.reload();
        await dismissGettingReady(page);
        await settings(page, "Connections");
        await expect(page.getByRole("list", { name: "Connections" }).getByText("Waiting for you")).toBeVisible({ timeout: 15_000 });
        await page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { name: "Web servers" }).click();
        const link = page.getByRole("list", { name: "Web server URLs" }).getByRole("link").first();
        await expect(link).toHaveAttribute("href", /\/3000\/$|-3000\./);
        await expect(page.getByText("Port 5173 is listening on 127.0.0.1 only. Start it on 0.0.0.0 to open it here.")).toBeVisible();
        await page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { name: "Assistant" }).click();
      }

      const renamed = unique("mine").toLowerCase();
      await page.getByLabel("Name").fill(renamed);
      await page.getByRole("button", { name: "Rename" }).click();
      await expect(page.getByRole("form", { name: "Rename your assistant" }).getByRole("status")).toHaveText(`Renamed to ${renamed}`);

      const restart = page.getByRole("button", { name: "Restart your assistant" });
      if ((await restart.count()) > 0) {
        await restart.click();
        await expect(page.getByText(/Anything a chat is working on right now stops/)).toBeVisible();
        await page.getByRole("button", { name: "Restart", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Settings" }).getByText("Restarting. Your chats are kept.")).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });

  test("should keep one person's assistant and chats from another when both use the Assistant @regression", async ({ browser, baseURL, request }) => {
    const ownerPersona = chatPersona("va-owner");
    const name = unique("laptop");
    const agent = await registerAgent(request, ownerPersona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, ownerPersona);
    const otherPersona = chatPersona("va-other");
    await connectForChat(request, otherPersona);
    const owner = await asPersona(browser, ownerPersona, baseURL!);
    const other = await asPersona(browser, otherPersona, baseURL!);
    try {
      const page = await owner.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      const path = await openLocalChat(page, name);
      const renamed = unique("owners").toLowerCase();
      await settings(page, "Assistant");
      await page.getByLabel("Name").fill(renamed);
      await page.getByRole("button", { name: "Rename" }).click();
      await expect(page.getByRole("form", { name: "Rename your assistant" }).getByRole("status")).toHaveText(`Renamed to ${renamed}`);

      const theirs = await other.newPage();
      expect((await theirs.goto(path))?.status()).toBe(404);
      await theirs.goto(`/hub/agents/${agent}`);
      expect(new URL(theirs.url()).pathname).toBe("/hub");
      await theirs.goto("/assistant");
      await dismissGettingReady(theirs);
      await settings(theirs, "Assistant");
      await expect(theirs.getByLabel("Name")).not.toHaveValue(renamed);
    } finally {
      await owner.close();
      await other.close();
    }
  });
});
