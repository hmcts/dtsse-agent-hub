import { expect, test } from "@playwright/test";
import { asPersona, registerAgent, unique } from "./hub";

test.describe("sidebar @regression", () => {
  test("should show seven whole agent rows and scroll the rest when there are more @regression", async ({ browser, baseURL, request }) => {
    const persona = unique("roster");
    const agents = [];
    for (let index = 0; index < 9; index++) {
      agents.push(await registerAgent(request, persona, unique(`agent${index}`)));
    }
    test.skip(agents.includes(undefined), "this deployment checks real agent tokens, so the suite cannot register an agent");

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/");
      const list = page.getByRole("complementary", { name: "Sidebar" }).getByRole("list", { name: "Agents" });
      await expect(list.getByRole("link")).toHaveCount(9);

      const row = await list
        .getByRole("link")
        .first()
        .evaluate((link) => link.getBoundingClientRect().height);
      const { visible, total } = await list.evaluate((element) => ({ visible: element.clientHeight, total: element.scrollHeight }));
      expect(visible).toBe(row * 7);
      expect(total).toBe(row * 9);
    } finally {
      await context.close();
    }
  });

  test("should put the topic search under the Topics heading @regression", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Main" });
    const heading = await nav.getByRole("heading", { name: "Topics" }).boundingBox();
    const search = await nav.getByRole("textbox", { name: "Search topics" }).boundingBox();
    const browse = await nav.getByRole("link", { name: "Browse all topics" }).boundingBox();

    expect(search!.y).toBeGreaterThan(heading!.y);
    expect(search!.y).toBeLessThan(browse!.y);
  });
});
