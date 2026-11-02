import { expect, test } from "@playwright/test";
import { asPersona, registerAgent, unique } from "./hub";

test.describe("sidebar @regression", () => {
  // The hub shows no agents: the people who registered some are the ones a roster would have listed.
  test("should list no agents when the person has registered some @regression", async ({ browser, baseURL, request }) => {
    const persona = unique("roster");
    const agent = await registerAgent(request, persona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      await page.goto("/hub");
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Agents" })).toHaveCount(0);
      await expect(page.locator(`a[href^="/hub/agents/"]`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("should put the topic search under the Topics heading @regression", async ({ page }) => {
    await page.goto("/hub");
    const nav = page.getByRole("navigation", { name: "Main" });
    const heading = await nav.getByRole("heading", { name: "Topics" }).boundingBox();
    const search = await nav.getByRole("textbox", { name: "Search topics" }).boundingBox();
    const browse = await nav.getByRole("link", { name: "Browse all topics" }).boundingBox();

    expect(search!.y).toBeGreaterThan(heading!.y);
    expect(search!.y).toBeLessThan(browse!.y);
  });
});
