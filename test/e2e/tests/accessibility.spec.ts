import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { askQuestion, buildChannel, connectForChat, PERSONA_COOKIE, registerAgent, sampleTranscript, unique, uploadTranscript } from "./hub";

const PERSONA = unique("a11y");

/**
 * Audits the page as it stands, which is what a surface reached by interacting rather than by its own address needs.
 *
 * `within` narrows it to one region, for a surface that sits inside a page audited by a test of its own: auditing
 * the whole page again would report that page's own findings against whichever test ran last, and the one that owns
 * them would no longer be the one that fails.
 */
async function expectNoViolations(page: Page, within?: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  const results = await (within === undefined ? builder : builder.include(within)).analyze();
  expect(results.violations).toEqual([]);
}

async function audit(page: Page, path: string, status = 200): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(status);
  await expectNoViolations(page);
}

test.describe("accessibility @nightly", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: PERSONA_COOKIE, value: PERSONA, url: baseURL! }]);
  });

  // With virtual agents on, /hub/settings/credentials redirects to /hub/virtual#credentials, so this audits that section.
  for (const path of [
    "/hub",
    "/hub/topics",
    "/hub/channels/new",
    "/hub/access",
    "/hub/settings/credentials",
    "/hub/c?topics=e2e-a11y",
    "/hub/topics/e2e-a11y"
  ]) {
    test(`should raise no WCAG A or AA violations on ${path} @nightly @a11y`, async ({ page }) => {
      await audit(page, path);
    });
  }

  test("should raise no WCAG A or AA violations on the virtual agents pages @nightly @a11y", async ({ page }) => {
    const response = await page.goto("/hub/virtual");
    test.skip(response?.status() === 404, "virtual agents are off on this deployment");
    await audit(page, "/hub/virtual");

    const name = unique("a11y").toLowerCase();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/\/hub\/agents\/[0-9a-f-]{36}$/);
    const path = new URL(page.url()).pathname;
    await audit(page, path);

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: `Delete ${name}` }).click();
    await expect(page.getByText("This virtual agent and its disk are being deleted.")).toBeVisible();
  });

  test("should raise no WCAG A or AA violations on the not-found page @nightly @a11y", async ({ page }) => {
    await audit(page, "/hub/agents/00000000-0000-0000-0000-000000000000", 404);
  });

  test("should raise no WCAG A or AA violations on a saved channel with posts @nightly @a11y", async ({ page }) => {
    const topic = unique("e2e");
    const path = await buildChannel(page, `A11y ${topic}`, [topic]);
    await page.getByPlaceholder("Write a post").fill(
      // Every block of the subset, so the gate audits what a body renders: the table covers its `th scope="col"`
      // header, an aligned column, and the focusable wrapper a keyboard user scrolls a wide table with, which is
      // why its last cell is long enough to overflow the column the table sits in.
      '# An accessibility check post\n\nWith `code`, **bold**, _italics_ and https://example.com\n\n- a list item\n\n```ts\nconst line = "long enough to scroll";\n```\n\n| Flag | Count | Note |\n| :--- | ----: | ---- |\n| -v | 2 | a note long enough that the table has to scroll sideways in the column it sits in |'
    );
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.getByRole("list", { name: "Posts" })).toBeVisible();

    await audit(page, path);
  });

  test("should raise no WCAG A or AA violations on a message page with a reference in its body @nightly @a11y", async ({ page }) => {
    const topic = unique("e2e");
    await page.goto(`/hub/topics/${topic}`);
    await page.getByPlaceholder("Write a post").fill("A message page check");
    await page.getByRole("button", { name: "Post" }).click();
    const first = page.getByRole("list", { name: "Posts" }).locator("[data-message-id]").first();
    await expect(first).toBeVisible();
    const id = await first.getAttribute("data-message-id");

    await page.getByPlaceholder("Write a post").fill(`Following up on #${id}`);
    await page.getByRole("button", { name: "Post" }).click();
    await expect(page.locator(`a[href="/hub/m/${id}"]`)).toHaveCount(2);

    await audit(page, `/hub/m/${id}`);
  });

  test("should raise no WCAG A or AA violations on a missing message page @nightly @a11y", async ({ page }) => {
    await audit(page, "/hub/m/9223372036854775807", 404);
  });

  test("should raise no WCAG A or AA violations on an agent page @nightly @a11y", async ({ page, request }) => {
    const agent = await registerAgent(request, PERSONA, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
    await uploadTranscript(request, PERSONA, agent!, sampleTranscript(unique("a11y")));

    await audit(page, `/hub/agents/${agent}`);
    await page.locator("details summary").first().click();
    await expectNoViolations(page);
  });

  test("should raise no WCAG A or AA violations on an agent page showing a question @nightly @a11y", async ({ page, request }) => {
    const agent = await registerAgent(request, PERSONA, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
    await askQuestion(request, PERSONA, agent!, {
      question: "Do you prefer red or blue?",
      header: "Colour",
      options: [
        { label: "Red", description: "You prefer red." },
        { label: "Blue", description: "You prefer blue." }
      ]
    });

    const response = await page.goto(`/hub/agents/${agent}`);
    expect(response?.status()).toBe(200);
    // The card alone, not the page around it: the agent page is audited whole by the test above, and this one is
    // about the question's own markup — its fieldsets, its labelled options and the free-text way out.
    const card = '[aria-label="A question for you"]';
    await expect(page.locator(card)).toBeVisible();
    await expectNoViolations(page, card);
    // The free-text box is a surface of its own, reached by pressing rather than by its own address.
    await page.getByRole("button", { name: "Something else" }).click();
    await expect(page.locator(card).getByRole("textbox")).toBeVisible();
    await expectNoViolations(page, card);
  });

  /**
   * The Assistant, which is audited as a first visit renders it: the shell, its sidebar and the new-chat screen, with
   * the connections banner asking for the Azure sign-in nothing has made yet, GitHub and Claude having been stored so
   * that the gate they are behind lets the page through. That is the whole of the Assistant a
   * deployment can show without a pod — a conversation, its thread and its document panel all need one running, so
   * they stay outside this gate.
   *
   * It skips wherever the Assistant is off, which is every environment `Jenkinsfile_nightly` can target:
   * `values.aat.template.yaml` and `values.preview.template.yaml` both set `VIRTUAL_AGENTS_ENABLED: "false"`, and the
   * layout answers 404 while it is. So this runs against `next dev` with the flag on, and goes live here the moment a
   * deployment turns it on. A skip is the point of the status check: without it the spec would pass on the 404.
   */
  test("should raise no WCAG A or AA violations on the Assistant's new chat and getting-ready screen @nightly @a11y", async ({ page, request }) => {
    await connectForChat(request, PERSONA);
    const response = await page.goto("/assistant");
    // Conditional on the deployment rather than a test put aside: `VIRTUAL_AGENTS_ENABLED` is `"false"` in every
    // environment `Jenkinsfile_nightly` targets, so the layout answers 404 there. Turning the flag on in one is all
    // this needs to run, and the audit below then runs unchanged.
    test.skip(response?.status() === 404, "the Assistant is off on this deployment");
    expect(response?.status()).toBe(200);

    // The new-chat screen is under whichever getting-ready surface the visit shows, so both are in the audited page.
    await expect(page.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
    await expectNoViolations(page);
  });
});
