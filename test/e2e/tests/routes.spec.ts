import { expect, test } from "@playwright/test";

/**
 * Where the two UIs live. The HMCTS Assistant is the default UI, so `/` is it wherever it runs and the hub keeps its
 * own pages under `/hub`. Every address the hub used to answer on still redirects, because `/hub/agents/{id}` and
 * `/hub/topics/{slug}` are pasted into chats and tickets.
 */

/** Each old hub address, and where it now lives. */
const MOVED: [string, string][] = [
  ["/access", "/hub/access"],
  ["/agents/00000000-0000-0000-0000-000000000000", "/hub/agents/00000000-0000-0000-0000-000000000000"],
  ["/c", "/hub/c"],
  ["/c?topics=e2e-routes&mode=all", "/hub/c?topics=e2e-routes&mode=all"],
  ["/channels/new", "/hub/channels/new"],
  ["/m/1", "/hub/m/1"],
  ["/settings/credentials", "/hub/settings/credentials"],
  ["/topics", "/hub/topics"],
  ["/topics/e2e-routes", "/hub/topics/e2e-routes"],
  ["/virtual", "/hub/virtual"]
];

test.describe("routes @regression", () => {
  test("should serve the hub under /hub @smoke @regression", async ({ page }) => {
    const response = await page.goto("/hub");

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });

  test("should send / to the default UI @smoke @regression", async ({ page }) => {
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    // The Assistant runs on a virtual agent, so deployments with the feature off get the hub instead.
    expect(new URL(page.url()).pathname).toMatch(/^\/(assistant|hub)$/);
  });

  for (const [from, to] of MOVED) {
    test(`should redirect ${from} to ${to} @regression`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });

      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe(to);
    });
  }
});
