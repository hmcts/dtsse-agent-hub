import { describe, expect, it, vi } from "vitest";
import { type Fetch, PROXY_BODY_LIMIT_BYTES } from "./forward.ts";
import { cookieValue, serveViewer, stillServed, ticketUrl, type ViewerAgent, type ViewerDependencies } from "./serve.ts";
import type { ViewerSettings } from "./settings.ts";
import { openTicket, openViewerCookie, sealTicket, sealViewerCookie } from "./tickets.ts";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OWNER = "owner-oid";
const PREFIX = `/${ID}/8080`;
const COOKIE = `ahv-${ID}-8080`;
const SETTINGS: ViewerSettings = {
  host: "agent-hub-viewer.example",
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
    expect(`${location.origin}${location.pathname}`).toBe(`https://agent-hub.example/hub/virtual/${ID}/ports/8080`);
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
