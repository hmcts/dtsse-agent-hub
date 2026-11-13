import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { dismissGettingReady, PERSONA_COOKIE, unique } from "./hub";

const PERSONA = unique("feedback");

/** A public page the deployment's pod can reach, which is all the wizard's check needs of a prototype. */
const PROTOTYPE = "https://www.gov.uk/";

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("prototype feedback @regression", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: PERSONA_COOKIE, value: PERSONA, url: baseURL! }]);
  });

  test("should set up a project from the plus menu and list its share link on the project's page @regression", async ({ page }) => {
    const wizard = await page.request.get("/assistant/feedback/new");
    test.skip(wizard.status() === 404, "prototype feedback is off on this deployment: it needs FEEDBACK_ENABLED, the viewer host and Blob Storage");

    await page.goto("/assistant");
    await dismissGettingReady(page);
    await page.getByRole("button", { name: "Workflows" }).click();
    await page.getByRole("menuitem", { name: /New feedback project/ }).click();
    await page.waitForURL(/\/assistant\/feedback\/new$/);
    await expect(page.getByRole("heading", { name: "Step 1 of 5: Name" })).toBeVisible();
    await expectNoViolations(page);

    const name = `E2E ${unique("project")}`;
    await page.getByLabel("Project name").fill(name);
    await page.getByRole("button", { name: "Next" }).click();

    const link = page.getByRole("group", { name: "Link 1" });
    await link.getByLabel("Label").fill("Round 1");
    await link.getByLabel("Prototype address").fill(PROTOTYPE);
    await link.getByLabel("Prototype address").blur();
    const checked = page.getByText(/The prototype answered|Could not confirm the prototype|This address cannot be used/);
    await expect(checked).toBeVisible({ timeout: 15_000 });
    test.skip(
      (await checked.textContent())?.includes("cannot be used") ?? false,
      "this deployment cannot resolve public addresses, so no link can be saved from it"
    );
    await page.getByRole("button", { name: "Next" }).click();
    // A prototype the pod could not reach is a warning, which a second Next carries on past.
    if (await page.getByRole("heading", { name: "Step 2 of 5: Links" }).isVisible()) {
      await page.getByRole("button", { name: "Next" }).click();
    }
    await expect(page.getByRole("heading", { name: "Step 3 of 5: Team" })).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Create project" }).click();

    await expect(page.getByRole("heading", { name: "Step 5 of 5: Share" })).toBeVisible();
    const share = page.getByLabel("Share link for Round 1");
    await expect(share).toHaveValue(/\/review\/[A-Za-z0-9_-]+$/);
    const address = await share.inputValue();

    await page.getByRole("link", { name: "Go to project" }).click();
    await page.waitForURL(/\/assistant\/feedback\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByLabel("Share link for Round 1")).toHaveValue(address);
    await expectNoViolations(page);
  });
});
