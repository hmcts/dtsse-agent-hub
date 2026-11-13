import { describe, expect, it, vi } from "vitest";
import { type Fetch, PROXY_BODY_LIMIT_BYTES } from "./forward.ts";
import {
  cookieValue,
  denyFraming,
  type FeedbackDependencies,
  feedbackTicketUrl,
  serveViewer,
  stillLive,
  stillServed,
  ticketUrl,
  type ViewerAgent,
  type ViewerDependencies,
  type ViewerFeedbackLink
} from "./serve.ts";
import type { ViewerSettings } from "./settings.ts";
import {
  openFeedbackCookie,
  openFeedbackTicket,
  openTicket,
  openViewerCookie,
  sealFeedbackCookie,
  sealFeedbackTicket,
  sealTicket,
  sealViewerCookie
} from "./tickets.ts";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OWNER = "owner-oid";
const PREFIX = `/${ID}/8080`;
const COOKIE = `ahv-${ID}-8080`;
const SETTINGS: ViewerSettings = {
  host: "agent-hub-viewer.example",
  origin: "https://agent-hub-viewer.example",
  hubOrigin: "https://agent-hub.example",
  secret: "a-test-session-secret-long-enough-to-be-plausible"
};
const AGENT: ViewerAgent = { id: ID, ownerOid: OWNER, desired: "running", statefulsetName: "va-abc", exposedPorts: [3000, 8080] };

function deps(overrides: Partial<ViewerDependencies> = {}): ViewerDependencies {
  return {
    settings: SETTINGS,
    publicDomain: "preview.platform.hmcts.net",
    loadAgent: async (id) => (id === ID ? AGENT : undefined),
    fetch: vi.fn<Fetch>(async () => new Response("Hello, world!\n")),
    ...overrides
  };
}

async function withCookie(path: string, init: RequestInit = {}, grant = { oid: OWNER, virtualAgentId: ID, port: 8080 }): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${COOKIE}=${await sealViewerCookie(grant, SETTINGS.secret)}`);
  return new Request(`https://agent-hub-viewer.example${path}`, { ...init, headers });
}

describe("stillServed", () => {
  it("should serve the owner a port the pod reports on an agent that is not being deleted", () => {
    expect(stillServed(AGENT, OWNER, 8080)).toBe(true);
  });

  it.each<[string, ViewerAgent | undefined, string, number]>([
    ["no such agent", undefined, OWNER, 8080],
    ["someone else", AGENT, "someone-else", 8080],
    ["an agent being deleted", { ...AGENT, desired: "deleted" }, OWNER, 8080],
    ["a port the pod does not report", AGENT, OWNER, 5173]
  ])("should serve nothing for %s", (_case, agent, oid, port) => {
    expect(stillServed(agent, oid, port)).toBe(false);
  });
});

describe("cookieValue", () => {
  it("should find the named cookie among others and nothing when it is absent", () => {
    expect(cookieValue("a=1; ahv-x=sealed=value; b", "ahv-x")).toBe("sealed=value");
    expect(cookieValue("a=1", "ahv-x")).toBeUndefined();
    expect(cookieValue(null, "ahv-x")).toBeUndefined();
  });
});

describe("ticketUrl", () => {
  it("should send the owner to the viewer's ticket exchange with a ticket for that port and path", async () => {
    const url = new URL((await ticketUrl(OWNER, AGENT, 8080, "/docs?page=2", SETTINGS))!);

    expect(url.origin).toBe("https://agent-hub-viewer.example");
    expect(url.pathname).toBe("/_auth");
    expect(await openTicket(url.searchParams.get("ticket"), SETTINGS.secret)).toEqual({ oid: OWNER, virtualAgentId: ID, port: 8080, path: "/docs?page=2" });
  });

  it("should land at the prefix's root when the path asked for could leave the viewer's host", async () => {
    const url = new URL((await ticketUrl(OWNER, AGENT, 8080, "//evil.example/", SETTINGS))!);

    expect((await openTicket(url.searchParams.get("ticket"), SETTINGS.secret))?.path).toBe("/");
  });

  it("should give nothing when the port is not the person's to open", async () => {
    expect(await ticketUrl("someone-else", AGENT, 8080, null, SETTINGS)).toBeUndefined();
    expect(await ticketUrl(OWNER, AGENT, 5173, null, SETTINGS)).toBeUndefined();
  });
});

describe("serveViewer", () => {
  it("should answer 404 for a path outside every port's prefix", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/"), "/", deps());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should send a root-relative request from a port's page back under that page's prefix, keeping its method", async () => {
    const request = new Request("https://agent-hub-viewer.example/submit?x=1", {
      method: "POST",
      body: "a=1",
      headers: { referer: `https://agent-hub-viewer.example${PREFIX}/form` }
    });

    const response = await serveViewer(request, "/submit?x=1", deps());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${PREFIX}/submit?x=1`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should send a request from a page that has left its prefix to the port last served, when its Referer names none", async () => {
    const request = new Request("https://agent-hub-viewer.example/aggregated/x?access=read", {
      headers: { referer: "https://agent-hub-viewer.example/cases", cookie: `ahv-last=${ID}/8080` }
    });

    const response = await serveViewer(request, "/aggregated/x?access=read", deps());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${PREFIX}/aggregated/x?access=read`);
  });

  it("should prefer the Referer's port to the one last served", async () => {
    const request = new Request("https://agent-hub-viewer.example/x", {
      headers: { referer: `https://agent-hub-viewer.example/${ID}/3000/`, cookie: `ahv-last=${ID}/8080` }
    });

    expect((await serveViewer(request, "/x", deps())).headers.get("location")).toBe(`/${ID}/3000/x`);
  });

  it("should remember the port of an HTML page it forwards, and of nothing else", async () => {
    const html = deps({ fetch: vi.fn<Fetch>(async () => new Response("<p>hi</p>", { headers: { "content-type": "text/html" } })) });
    const json = deps({ fetch: vi.fn<Fetch>(async () => new Response("{}", { headers: { "content-type": "application/json" } })) });

    const page = await serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, html);
    const api = await serveViewer(await withCookie(`${PREFIX}/api`), `${PREFIX}/api`, json);

    expect(page.headers.getSetCookie()).toContain(`ahv-last=${ID}/8080; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`);
    expect(api.headers.getSetCookie()).toEqual([]);
  });

  it("should answer 404 outside every prefix when the Referer names no port's page", async () => {
    const request = new Request("https://agent-hub-viewer.example/style.css", { headers: { referer: "https://elsewhere.example/" } });

    expect((await serveViewer(request, "/style.css", deps())).status).toBe(404);
  });

  it("should add the slash a bare prefix lacks, so its cookie is sent", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `${PREFIX}?a=1`, deps());

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${PREFIX}/?a=1`);
  });

  it("should swap a good ticket for a cookie scoped to its port's prefix and land on its path", async () => {
    const ticket = await sealTicket({ oid: OWNER, virtualAgentId: ID, port: 8080, path: "/docs" }, SETTINGS.secret);

    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `/_auth?ticket=${encodeURIComponent(ticket)}`, deps());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PREFIX}/docs`);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${COOKIE}=`));
    expect(cookie).toContain(`Path=${PREFIX}/;`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(await openViewerCookie(cookieValue(cookie.split(";")[0]!, COOKIE), SETTINGS.secret)).toEqual({ oid: OWNER, virtualAgentId: ID, port: 8080 });
  });

  it("should refuse a missing or bad ticket with 400", async () => {
    expect((await serveViewer(new Request("https://agent-hub-viewer.example/x"), "/_auth", deps())).status).toBe(400);
    expect((await serveViewer(new Request("https://agent-hub-viewer.example/x"), "/_auth?ticket=forged", deps())).status).toBe(400);
  });

  it("should send a GET without a cookie through the hub for a ticket, keeping where it was going", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `${PREFIX}/docs?page=2`, deps());

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`https://agent-hub.example/assistant/ports/${ID}/8080`);
    expect(location.searchParams.get("path")).toBe("/docs?page=2");
  });

  it("should send a request through the hub when its cookie is for another port", async () => {
    const request = await withCookie(`${PREFIX}/`, {}, { oid: OWNER, virtualAgentId: ID, port: 3000 });

    expect((await serveViewer(request, `${PREFIX}/`, deps())).status).toBe(303);
  });

  it("should refuse a POST without a cookie with 401, since a redirect would drop its body", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x", { method: "POST", body: "x" }), `${PREFIX}/form`, deps());

    expect(response.status).toBe(401);
  });

  it("should forward a request with a good cookie to the pod's ingress for that port", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("Hello, world!\n"));

    const response = await serveViewer(await withCookie(`${PREFIX}/docs?page=2`), `${PREFIX}/docs?page=2`, deps({ fetch: fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledWith("https://va-abc-8080.preview.platform.hmcts.net/docs?page=2", expect.anything());
    expect(fetchImpl.mock.calls[0]![1].headers).toBeInstanceOf(Headers);
    expect((fetchImpl.mock.calls[0]![1].headers as Headers).get("x-forwarded-prefix")).toBe(PREFIX);
    expect(await response.text()).toBe("Hello, world!\n");
  });

  it("should answer 404 when the cookie's person no longer owns the agent, or the port has gone", async () => {
    const gone = deps({ loadAgent: async () => ({ ...AGENT, exposedPorts: [3000] }) });
    const moved = deps({ loadAgent: async () => ({ ...AGENT, ownerOid: "someone-else" }) });

    expect((await serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, gone)).status).toBe(404);
    expect((await serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, moved)).status).toBe(404);
  });

  // Next's proxy ends the body clone at the limit and only warns, so without this the pod would be handed the first
  // 6 MiB of the upload as if that were all of it.
  it("should answer 413 rather than forward a body the proxy has truncated", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("never asked for"));
    const request = await withCookie(`${PREFIX}/upload`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(PROXY_BODY_LIMIT_BYTES + 1) }
    });

    const response = await serveViewer(request, `${PREFIX}/upload`, deps({ fetch: fetchImpl }));

    expect(response.status).toBe(413);
    expect(await response.text()).toContain("cannot carry a request body larger than 6 MiB");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should forward a body up to the limit, which arrives whole", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("thanks"));
    const request = await withCookie(`${PREFIX}/upload`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(PROXY_BODY_LIMIT_BYTES) }
    });

    expect((await serveViewer(request, `${PREFIX}/upload`, deps({ fetch: fetchImpl }))).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("should answer 502 when the pod does not answer", async () => {
    const refused = deps({
      fetch: async () => {
        throw new TypeError("fetch failed");
      }
    });

    const response = await serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, refused);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("The web server on port 8080 did not answer.\n");
  });

  it("should let an error that is not about the pod propagate", async () => {
    const broken = deps({
      loadAgent: async () => {
        throw new Error("database down");
      }
    });

    await expect(serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, broken)).rejects.toThrow("database down");
  });
});

describe("the viewer's framing headers for a port", () => {
  it("should forbid framing every answer, replacing whatever the pod sent", async () => {
    const pod = deps({
      fetch: vi.fn<Fetch>(async () => new Response("hi", { headers: { "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'self'" } }))
    });

    const forwarded = await serveViewer(await withCookie(`${PREFIX}/`), `${PREFIX}/`, pod);
    const missing = await serveViewer(new Request("https://agent-hub-viewer.example/"), "/", deps());

    for (const response of [forwarded, missing]) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });

  it("should forbid framing a response it is handed", () => {
    expect(denyFraming(new Response(null)).headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("feedback links on the viewer", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
  const FPREFIX = `/f/${TOKEN}`;
  const FCOOKIE = `ahv-f-${TOKEN}`;
  const REVIEWER = "reviewer-oid";
  const HUB = "https://agent-hub.example";
  const LINK: ViewerFeedbackLink = {
    token: TOKEN,
    origin: "https://prototype.example",
    prototypeVersion: "3",
    revokedAt: null,
    project: { ownerOid: OWNER, archivedAt: null, maskInputs: true },
    memberOids: []
  };

  function feedback(overrides: Partial<FeedbackDependencies> = {}): FeedbackDependencies {
    return {
      findLink: async (token) => (token === TOKEN ? LINK : null),
      publicAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: vi.fn<Fetch>(async () => new Response("prototype")),
      readWidget: async () => ({ body: new TextEncoder().encode("widget();"), etag: '"abc"' }),
      nonce: () => "n0nce",
      env: { NODE_ENV: "production" },
      ...overrides
    };
  }

  /** `rest.fetch` is the feedback fetch; the ports' own fetch throws, since no feedback request may use it. */
  function withFeedback(overrides: Partial<FeedbackDependencies> = {}, rest: Partial<ViewerDependencies> = {}): ViewerDependencies {
    const { fetch, ...others } = rest;
    return deps({
      feedback: feedback({ ...(fetch === undefined ? {} : { fetch }), ...overrides }),
      ...others,
      fetch: async () => {
        throw new Error("a feedback request used the ports' fetch");
      }
    });
  }

  async function reviewing(path: string, init: RequestInit = {}, grant = { oid: REVIEWER, token: TOKEN }): Promise<Request> {
    const headers = new Headers(init.headers);
    headers.set("cookie", `${FCOOKIE}=${await sealFeedbackCookie(grant, SETTINGS.secret)}`);
    return new Request(`https://agent-hub-viewer.example${path}`, { ...init, headers });
  }

  function expectHubFraming(response: Response): void {
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(`frame-ancestors ${HUB}`);
    expect(response.headers.get("content-security-policy")).not.toContain("'none'");
  }

  describe("stillLive", () => {
    it("should keep a link open to a reviewer while it is not revoked and its project not archived", () => {
      expect(stillLive(LINK, REVIEWER)).toBe(true);
      expect(stillLive({ ...LINK, revokedAt: new Date() }, REVIEWER)).toBe(false);
      expect(stillLive({ ...LINK, project: { ...LINK.project, archivedAt: new Date() } }, OWNER)).toBe(false);
      expect(stillLive(null, REVIEWER)).toBe(false);
      expect(stillLive(undefined, REVIEWER)).toBe(false);
    });
  });

  describe("feedbackTicketUrl", () => {
    it("should send the frame to the viewer's ticket exchange with a ticket for the person, link and path", async () => {
      const url = new URL((await feedbackTicketUrl({ oid: REVIEWER }, TOKEN, "/start?x=1", SETTINGS))!);

      expect(`${url.origin}${url.pathname}`).toBe("https://agent-hub-viewer.example/_auth");
      expect(await openFeedbackTicket(url.searchParams.get("ticket"), SETTINGS.secret)).toEqual({ oid: REVIEWER, token: TOKEN, path: "/start?x=1" });
    });

    it("should land at the prefix's root when the path could leave the viewer's host, and give nothing while the viewer is off", async () => {
      const url = new URL((await feedbackTicketUrl({ oid: REVIEWER }, TOKEN, "//evil.example/", SETTINGS))!);

      expect((await openFeedbackTicket(url.searchParams.get("ticket"), SETTINGS.secret))?.path).toBe("/");
      expect(await feedbackTicketUrl({ oid: REVIEWER }, TOKEN, null, undefined)).toBeUndefined();
    });

    it("should read the viewer's settings from the environment when given none", async () => {
      vi.stubEnv("AGENT_HUB_VIEWER_HOST", "");

      expect(await feedbackTicketUrl({ oid: REVIEWER }, TOKEN, null)).toBeUndefined();

      vi.unstubAllEnvs();
    });
  });

  it("should swap a feedback ticket for a cookie scoped to the link's prefix, framed by the hub", async () => {
    const ticket = await sealFeedbackTicket({ oid: REVIEWER, token: TOKEN, path: "/start" }, SETTINGS.secret);

    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `/_auth?ticket=${encodeURIComponent(ticket)}`, withFeedback());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${FPREFIX}/start`);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${FCOOKIE}=`));
    expect(cookie).toContain(`Path=${FPREFIX}/;`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(await openFeedbackCookie(cookieValue(cookie.split(";")[0]!, FCOOKIE), SETTINGS.secret)).toEqual({ oid: REVIEWER, token: TOKEN });
    expectHubFraming(response);
  });

  it("should refuse a feedback ticket while feedback is off, and a bad ticket with 400 the hub may frame while it is on", async () => {
    const ticket = await sealFeedbackTicket({ oid: REVIEWER, token: TOKEN, path: "/" }, SETTINGS.secret);

    const off = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `/_auth?ticket=${encodeURIComponent(ticket)}`, deps());
    const bad = await serveViewer(new Request("https://agent-hub-viewer.example/x"), "/_auth?ticket=forged", withFeedback());

    expect(off.status).toBe(400);
    expect(off.headers.get("x-frame-options")).toBe("DENY");
    expect(bad.status).toBe(400);
    expectHubFraming(bad);
  });

  it("should still swap a port's ticket while feedback is on", async () => {
    const ticket = await sealTicket({ oid: OWNER, virtualAgentId: ID, port: 8080, path: "/" }, SETTINGS.secret);

    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `/_auth?ticket=${encodeURIComponent(ticket)}`, withFeedback());

    expect(response.headers.get("location")).toBe(`${PREFIX}/`);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("should answer 404 for every feedback path and the widget while feedback is off", async () => {
    for (const path of [`${FPREFIX}/start`, FPREFIX, "/_feedback/widget.js"]) {
      const response = await serveViewer(await reviewing(path), path, deps());

      expect(response.status).toBe(404);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("should add the slash a bare prefix lacks", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `${FPREFIX}?a=1`, withFeedback());

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${FPREFIX}/?a=1`);
    expectHubFraming(response);
  });

  it("should send a GET without a cookie to the hub's review page, keeping where it was going", async () => {
    const response = await serveViewer(new Request("https://agent-hub-viewer.example/x"), `${FPREFIX}/page?x=1`, withFeedback());

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${HUB}/review/${TOKEN}`);
    expect(location.searchParams.get("path")).toBe("/page?x=1");
  });

  it("should send a GET through the hub when its cookie is for another link", async () => {
    const request = await reviewing(`${FPREFIX}/`, {}, { oid: REVIEWER, token: "ZZZZEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde" });

    expect((await serveViewer(request, `${FPREFIX}/`, withFeedback())).status).toBe(303);
  });

  it("should answer 401 rather than redirect a frame or a POST without a cookie", async () => {
    const frame = new Request("https://agent-hub-viewer.example/x", { headers: { "sec-fetch-dest": "iframe" } });
    const post = new Request("https://agent-hub-viewer.example/x", { method: "POST", body: "x" });

    const framed = await serveViewer(frame, `${FPREFIX}/`, withFeedback());
    const posted = await serveViewer(post, `${FPREFIX}/`, withFeedback());

    expect(framed.status).toBe(401);
    expect(await framed.text()).toContain("Reload the page");
    expectHubFraming(framed);
    expect(posted.status).toBe(401);
  });

  it("should forward a reviewer's request to the link's origin with the widget injected and the hub allowed to frame it", async () => {
    const fetchImpl = vi.fn<Fetch>(
      async () =>
        new Response("<html><head><title>p</title></head></html>", {
          headers: { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'; script-src 'self'" }
        })
    );

    const response = await serveViewer(await reviewing(`${FPREFIX}/start?x=1`), `${FPREFIX}/start?x=1`, withFeedback({}, { fetch: fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledWith("https://prototype.example/start?x=1", expect.anything());
    expect((fetchImpl.mock.calls[0]![1].headers as Headers).get("x-forwarded-prefix")).toBe(FPREFIX);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(`script-src 'self' https://agent-hub-viewer.example; frame-ancestors ${HUB}`);
    expect(await response.text()).toBe(
      `<html><head><script src="/_feedback/widget.js" nonce="n0nce" data-hub-origin="${HUB}" data-prefix="${FPREFIX}" data-upstream-origin="https://prototype.example" data-mask-inputs="true" data-version="3" defer></script><title>p</title></head></html>`
    );
    expect(response.headers.getSetCookie()).toContain(`ahv-last=f/${TOKEN}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`);
  });

  it("should let the hub alone frame a page that sets no policy of its own, and remember no page for an asset", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("body{}", { headers: { "content-type": "text/css" } }));

    const response = await serveViewer(await reviewing(`${FPREFIX}/app.css`), `${FPREFIX}/app.css`, withFeedback({}, { fetch: fetchImpl }));

    expectHubFraming(response);
    expect(response.headers.get("content-security-policy")).toBe(`frame-ancestors ${HUB}`);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("should give each page a fresh nonce when none is supplied", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("<head>", { headers: { "content-type": "text/html" } }));

    const response = await serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, withFeedback({ nonce: undefined }, { fetch: fetchImpl }));

    expect(await response.text()).toMatch(/nonce="[A-Za-z0-9_-]{24}"/);
  });

  it("should send a root-relative request from a feedback page back under its prefix, framed by the hub", async () => {
    const request = new Request("https://agent-hub-viewer.example/next", { headers: { referer: `https://agent-hub-viewer.example${FPREFIX}/start` } });

    const response = await serveViewer(request, "/next", withFeedback());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${FPREFIX}/next`);
    expectHubFraming(response);
  });

  it("should answer 404 when the link is revoked, its project archived or it no longer exists", async () => {
    for (const findLink of [
      async () => ({ ...LINK, revokedAt: new Date() }),
      async () => ({ ...LINK, project: { ...LINK.project, archivedAt: new Date() } }),
      async () => null
    ]) {
      const response = await serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, withFeedback({ findLink }));

      expect(response.status).toBe(404);
      expectHubFraming(response);
    }
  });

  it("should refuse a link whose origin is not one the hub may fetch, without fetching it", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("never asked for"));
    const local = withFeedback({ findLink: async () => ({ ...LINK, origin: "https://127.0.0.1" }) }, { fetch: fetchImpl });
    const rebound = withFeedback({ publicAddresses: async () => [] }, { fetch: fetchImpl });

    expect((await serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, local)).status).toBe(502);
    expect((await serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, rebound)).status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should answer 413 rather than forward a body the proxy has truncated", async () => {
    const request = await reviewing(`${FPREFIX}/form`, { method: "POST", body: "x", headers: { "content-length": String(PROXY_BODY_LIMIT_BYTES + 1) } });

    expect((await serveViewer(request, `${FPREFIX}/form`, withFeedback())).status).toBe(413);
  });

  it("should answer 502 when the prototype does not answer, and let any other error propagate", async () => {
    const refused = withFeedback(
      {},
      {
        fetch: async () => {
          throw new TypeError("fetch failed");
        }
      }
    );
    const broken = withFeedback({
      findLink: async () => {
        throw new Error("database down");
      }
    });

    const response = await serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, refused);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("The prototype did not answer.\n");
    await expect(serveViewer(await reviewing(`${FPREFIX}/`), `${FPREFIX}/`, broken)).rejects.toThrow("database down");
  });

  describe("the widget", () => {
    it("should serve the bundle as uncached-but-revalidated JavaScript", async () => {
      const response = await serveViewer(new Request("https://agent-hub-viewer.example/_feedback/widget.js"), "/_feedback/widget.js", withFeedback());

      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        etag: '"abc"'
      });
      expect(await response.text()).toBe("widget();");
    });

    it("should answer 304 to a browser holding the same bundle, and a HEAD with no body", async () => {
      const cached = await serveViewer(
        new Request("https://agent-hub-viewer.example/_feedback/widget.js", { headers: { "if-none-match": '"abc"' } }),
        "/_feedback/widget.js",
        withFeedback()
      );
      const head = await serveViewer(
        new Request("https://agent-hub-viewer.example/_feedback/widget.js", { method: "HEAD" }),
        "/_feedback/widget.js",
        withFeedback()
      );

      expect(cached.status).toBe(304);
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
    });

    it("should answer 404 before the bundle is built and 405 to a method other than GET or HEAD", async () => {
      const unbuilt = await serveViewer(
        new Request("https://agent-hub-viewer.example/x"),
        "/_feedback/widget.js",
        withFeedback({ readWidget: async () => undefined })
      );
      const posted = await serveViewer(new Request("https://agent-hub-viewer.example/x", { method: "POST" }), "/_feedback/widget.js", withFeedback());

      expect(unbuilt.status).toBe(404);
      expect(posted.status).toBe(405);
    });
  });
});
