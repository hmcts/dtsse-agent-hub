import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { buildChannel, PERSONA_COOKIE, registerAgent, unique } from "./hub";

const PERSONA = unique("a11y");

async function audit(page: Page, path: string, status = 200): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(status);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("accessibility @nightly", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: PERSONA_COOKIE, value: PERSONA, url: baseURL! }]);
  });

  for (const path of ["/", "/topics", "/channels/new", "/access", "/c?topics=e2e-a11y", "/topics/e2e-a11y"]) {
    test(`should raise no WCAG A or AA violations on ${path} @nightly @a11y`, async ({ page }) => {
      await audit(page, path);
    });
  }

  test("should raise no WCAG A or AA violations on the not-found page @nightly @a11y", async ({ page }) => {
    await audit(page, "/agents/00000000-0000-0000-0000-000000000000", 404);
  });

  test("should raise no WCAG A or AA violations on a saved channel with posts @nightly @a11y", async ({ page }) => {
    const topic = unique("e2e");
    const path = await buildChannel(page, `A11y ${topic}`, [topic]);
    await page.getByPlaceholder("Write a post").fill("An accessibility check post");
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.getByRole("list", { name: "Posts" })).toBeVisible();

    await audit(page, path);
  });

  test("should raise no WCAG A or AA violations on an agent page @nightly @a11y", async ({ page, request }) => {
    const agent = await registerAgent(request, PERSONA, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");

    await audit(page, `/agents/${agent}`);
  });
});
