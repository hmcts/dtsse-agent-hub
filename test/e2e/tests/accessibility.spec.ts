import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { buildChannel, PERSONA_COOKIE, registerAgent, sampleTranscript, unique, uploadTranscript } from "./hub";

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

  // With virtual agents on, /settings/credentials redirects to /virtual#credentials, so this audits that section.
  for (const path of ["/", "/topics", "/channels/new", "/access", "/settings/credentials", "/c?topics=e2e-a11y", "/topics/e2e-a11y"]) {
    test(`should raise no WCAG A or AA violations on ${path} @nightly @a11y`, async ({ page }) => {
      await audit(page, path);
    });
  }

  test("should raise no WCAG A or AA violations on the virtual agents pages @nightly @a11y", async ({ page }) => {
    const response = await page.goto("/virtual");
    test.skip(response?.status() === 404, "virtual agents are off on this deployment");
    await audit(page, "/virtual");

    const name = unique("a11y").toLowerCase();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
    const path = new URL(page.url()).pathname;
    await audit(page, path);

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: `Delete ${name}` }).click();
    await expect(page.getByText("This virtual agent and its disk are being deleted.")).toBeVisible();
  });

  test("should raise no WCAG A or AA violations on the not-found page @nightly @a11y", async ({ page }) => {
    await audit(page, "/agents/00000000-0000-0000-0000-000000000000", 404);
  });

  test("should raise no WCAG A or AA violations on a saved channel with posts @nightly @a11y", async ({ page }) => {
    const topic = unique("e2e");
    const path = await buildChannel(page, `A11y ${topic}`, [topic]);
    await page
      .getByPlaceholder("Write a post")
      .fill(
        '# An accessibility check post\n\nWith `code`, **bold**, _italics_ and https://example.com\n\n- a list item\n\n```ts\nconst line = "long enough to scroll";\n```'
      );
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.getByRole("list", { name: "Posts" })).toBeVisible();

    await audit(page, path);
  });

  test("should raise no WCAG A or AA violations on a message page with a reference in its body @nightly @a11y", async ({ page }) => {
    const topic = unique("e2e");
    await page.goto(`/topics/${topic}`);
    await page.getByPlaceholder("Write a post").fill("A message page check");
    await page.getByRole("button", { name: "Post" }).click();
    const first = page.getByRole("list", { name: "Posts" }).locator("[data-message-id]").first();
    await expect(first).toBeVisible();
    const id = await first.getAttribute("data-message-id");

    await page.getByPlaceholder("Write a post").fill(`Following up on #${id}`);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`a[href="/m/${id}"]`)).toHaveCount(2);

    await audit(page, `/m/${id}`);
  });

  test("should raise no WCAG A or AA violations on a missing message page @nightly @a11y", async ({ page }) => {
    await audit(page, "/m/9223372036854775807", 404);
  });

  test("should raise no WCAG A or AA violations on an agent page @nightly @a11y", async ({ page, request }) => {
    const agent = await registerAgent(request, PERSONA, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
    await uploadTranscript(request, PERSONA, agent!, sampleTranscript(unique("a11y")));

    await audit(page, `/agents/${agent}`);
    await page.locator("details summary").first().click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
