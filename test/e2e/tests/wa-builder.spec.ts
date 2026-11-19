import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { PERSONA_COOKIE, unique } from "./hub";

const PERSONA = unique("wa-builder");

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("work allocation builder @regression", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: PERSONA_COOKIE, value: PERSONA, url: baseURL! }]);
  });

  test("should list the services, and raise no WCAG A or AA violations, on the builder's home @regression @a11y", async ({ page }) => {
    const response = await page.goto("/assistant/wa-builder");
    test.skip(response?.status() === 404, "virtual agents are off on this deployment");

    await expect(page.getByRole("heading", { level: 1, name: "Work Allocation builder" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("should open a service's views and a task, each free of WCAG A and AA violations, when a service is held @regression @a11y", async ({ page }) => {
    const response = await page.goto("/assistant/wa-builder");
    test.skip(response?.status() === 404, "virtual agents are off on this deployment");
    const service = page.getByRole("table", { name: "Services" }).getByRole("link").first();
    test.skip((await service.count()) === 0, "no service has a Work Allocation spec saved on this deployment");

    await service.click();
    await expect(page.getByRole("navigation", { name: "Views of this service" })).toBeVisible();
    for (const view of ["Service setup", "Roles and permissions", "Task board", "Case lifecycle", "Simulator"]) {
      await page.getByRole("link", { name: view }).click();
      await expect(page.getByRole("link", { name: view })).toHaveAttribute("aria-current", "page");
      await expectNoViolations(page);
    }

    await page.getByRole("link", { name: "Task board" }).click();
    await page.getByRole("table").first().getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: "When it is created" })).toBeVisible();
    await expectNoViolations(page);
  });
});
