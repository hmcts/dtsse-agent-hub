import { expect, test } from "@playwright/test";

/**
 * Where the two UIs live. The HMCTS Assistant is the default UI, so `/` is it wherever it runs and the hub keeps its
 * own pages under `/hub`. Every address the hub used to answer on still redirects, because `/hub/agents/{id}` and
 * `/hub/topics/{slug}` are pasted into chats and tickets — and `/hub/agents/{id}` itself only sends people on, since
 * the hub shows no agents.
 */

/** Each old hub address, and where it now lives. */
const MOVED: [string, string][] = [
  ["/agents/00000000-0000-0000-0000-000000000000", "/hub/agents/00000000-0000-0000-0000-000000000000"],
  ["/c", "/hub/c"],
  ["/c?topics=e2e-routes&mode=all", "/hub/c?topics=e2e-routes&mode=all"],
  ["/channels/new", "/hub/channels/new"],
  ["/m/1", "/hub/m/1"],
  ["/topics", "/hub/topics"],
  ["/topics/e2e-routes", "/hub/topics/e2e-routes"]
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

  // The not-found page renders outside the hub's layout, so this link is the only way back into it.
  test("should offer the hub as the way back from an unmatched hub address @regression", async ({ page }) => {
    const response = await page.goto("/hub/nonsense");

    expect(response?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/hub");
  });

  test("should offer the front door from an unmatched address outside the hub @regression", async ({ page }) => {
    const response = await page.goto("/nonsense");

    expect(response?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });

  // An id that is none of the viewer's: their own chats' agents go to the chat, which needs a registered agent, and
  // that is `local-chats.spec.ts`'s to set up.
  test("should send an agent's page to the hub's home when the agent is none of the viewer's @regression", async ({ page }) => {
    const response = await page.goto("/hub/agents/00000000-0000-0000-0000-000000000000");

    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/hub");
  });

  for (const [from, to] of MOVED) {
    test(`should redirect ${from} to ${to} @regression`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });

      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe(to);
    });
  }

  // The virtual agents and credentials pages are the Assistant's settings now, opened at the section that replaced
  // each, in one hop from the bare address as from the `/hub` one. Or the hub where virtual agents are off.
  const RETIRED: [string, string][] = [
    ["/virtual", "assistant"],
    ["/hub/virtual", "assistant"],
    ["/hub/virtual/0f8a6a1e-0000-4000-8000-000000000001", "assistant"],
    ["/settings/credentials", "credentials"],
    ["/hub/settings/credentials", "credentials"]
  ];
  for (const [from, section] of RETIRED) {
    test(`should redirect the retired ${from} to the Assistant's ${section} settings @regression`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      expect([`/assistant?settings=${section}`, "/hub"]).toContain(response.headers().location ?? "");
    });
  }

  // `/hub/virtual/{id}/ports/{port}` and `/virtual/{id}/ports/{port}` redirect in one hop to the viewer's ticket route,
  // `/assistant/ports/{id}/{port}`, keeping `path=`.
  for (const from of ["/hub/virtual/0f8a6a1e-0000-4000-8000-000000000001/ports/3000", "/virtual/0f8a6a1e-0000-4000-8000-000000000001/ports/3000"]) {
    test(`should redirect ${from} to the viewer's ticket route @regression`, async ({ request }) => {
      const response = await request.get(`${from}?path=%2Fdocs`, { maxRedirects: 0 });

      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe("/assistant/ports/0f8a6a1e-0000-4000-8000-000000000001/3000?path=%2Fdocs");
    });
  }

  test("should show the not-found page, and redirect nowhere, when an address under the old ticket route names no port @regression", async ({ request }) => {
    const response = await request.get("/hub/virtual/not-an-id/ports/3000", { maxRedirects: 0 });

    expect(response.status()).toBe(404);
    expect(response.headers().location).toBeUndefined();
    expect(response.headers()["content-type"]).toContain("text/html");
  });

  // The access page managed standing access to every agent its owner had; there is none. What anyone shares is one
  // chat at a time, which is `/assistant/shared`, so both of its addresses go there — or to the hub where virtual
  // agents are off and the Assistant's pages are not found at all.
  for (const from of ["/access", "/hub/access"]) {
    test(`should redirect the retired ${from} to the shared chats @regression`, async ({ request }) => {
      const response = await request.get(from, { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      expect(response.headers().location).toMatch(/^(\/assistant\/shared|\/hub)$/);
    });
  }

  // The half of `docs/agent-api.md`'s missing-route rule that can change under us. Clients tell a route that
  // refused them from a path this service has no route for by the body: a route sends `{ error }`, and an
  // unmatched path gets the app's own not-found document, which starts with `<`. `isMissingRoute` in the client
  // rests on that, and a Next upgrade serving a plain-text 404 instead would quietly turn every client-newer-
  // than-hub skew back into a reported fault. No API route answers this path, now or planned.
  // `maxRedirects: 0` so a route appearing here later fails as the redirect it is, rather than following it to
  // something that answers 200 and reading as a mystery.
  test("should answer an unmatched API path with the not-found document, not JSON @regression", async ({ request }) => {
    const response = await request.get("/api/agent/nonsense", { maxRedirects: 0 });

    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("text/html");
    expect((await response.text()).trimStart().startsWith("<")).toBe(true);
  });

  // A secret pasted into one of the bare addresses must not reach the 308's `Location`: Traefik's access log keeps
  // it. `src/proxy.ts` strips it first, which is why these are not config `redirects()`.
  for (const bare of ["/settings/credentials", "/agents/va-1", "/virtual/va-1"]) {
    test(`should strip a secret from ${bare} rather than repeat it in the redirect @regression`, async ({ request }) => {
      const response = await request.get(`${bare}?token=sk-ant-0000000000000000000000`, { maxRedirects: 0 });

      expect(response.status()).toBe(303);
      expect(response.headers().location).toBe(bare);
      expect(response.headers().location).not.toContain("sk-ant-");
    });
  }
});
