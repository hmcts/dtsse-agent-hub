import { expect, test } from "@playwright/test";
import { asPersona, unique } from "./hub";

test.describe("virtual agents @regression", () => {
  test("should create a virtual agent, show a sign-in its pod relays, rename it and delete it @regression", async ({ browser, baseURL, request }) => {
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
      await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      await expect(page.getByText("Starting…")).toBeVisible();

      await page.goto("/virtual");
      expect(await page.getByRole("link", { name }).getAttribute("href")).toBe(`/agents/${id}`);
      await page.goto(`/virtual/${id}`);
      await page.waitForURL(new RegExp(`/agents/${id}$`));
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(page.getByRole("list", { name: "Sign-ins" }).getByRole("heading", { name: "GitHub" })).toBeVisible();
      await expect(page.getByText("No web servers running")).toBeVisible();

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

        const ports = await request.put(`/api/virtual/${id}/ports`, {
          headers: { authorization: `Bearer ${claimed!.launch_token}` },
          data: { ports: [3000], local_only: [5173] }
        });
        expect(ports.status()).toBe(204);
        await expect(page.getByRole("list", { name: "Web server URLs" }).getByRole("link", { name: /^https:\/\/va-[0-9a-f]{8}-3000\./ })).toBeVisible({
          timeout: 15_000
        });
        await expect(page.getByText("port 5173 is listening on 127.0.0.1 only — start it on 0.0.0.0 to open it here")).toBeVisible();
      }

      const renamed = `${name}-renamed`;
      const rename = page.getByRole("form", { name: `Rename ${name}` });
      await rename.getByLabel("New name").fill(renamed);
      await rename.getByRole("button", { name: "Rename" }).click();
      await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();

      await page.getByRole("button", { name: "Delete" }).click();
      await page
        .getByRole("group", { name: `Confirm deleting ${renamed}` })
        .getByRole("button", { name: `Delete ${renamed}` })
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
      await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
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
