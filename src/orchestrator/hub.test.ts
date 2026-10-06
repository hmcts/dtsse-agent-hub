import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { createHub, HubError } from "./hub.ts";

const SCOPE = "api://dtsse-agent-hub/.default";

const credential: TokenCredential = { getToken: vi.fn(async () => ({ token: "app-token", expiresOnTimestamp: Date.now() + 60_000 })) };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function hubWith(responses: (Response | Error)[], options: { credential?: TokenCredential; attempts?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? json(500, { error: "no more responses" });
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as unknown as typeof globalThis.fetch;
  const hub = createHub({
    url: "https://agent-hub.example/",
    scope: SCOPE,
    credential: options.credential ?? credential,
    fetch,
    attempts: options.attempts,
    backoffMs: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });
  return { hub, calls, sleeps };
}

describe("createHub", () => {
  it("should claim for the cluster with the orchestrator's token for the hub's scope", async () => {
    const agents = [{ id: "a", launch_token: "ahv_x" }];
    const { hub, calls } = hubWith([json(200, { virtual_agents: agents, active: true })]);

    expect(await hub.claim("cft-preview-00")).toEqual({ active: true, agents });
    expect(calls[0]!.url).toBe("https://agent-hub.example/api/orchestrator/claim");
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: JSON.stringify({ cluster: "cft-preview-00" }) });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer app-token");
    expect(credential.getToken).toHaveBeenCalledWith(SCOPE);
  });

  it("should take a claim as active when the hub does not say otherwise", async () => {
    const { hub } = hubWith([json(200, { virtual_agents: [] })]);

    expect(await hub.claim("c")).toEqual({ active: true, agents: [] });
  });

  it("should report who holds the lease when the hub puts this cluster on standby", async () => {
    const lease = { cluster: "cft-preview-01", renewed_at: "2026-10-05T12:00:00.000Z" };
    const { hub } = hubWith([json(200, { virtual_agents: [], active: false, lease: { ...lease, extra: 1 } })]);

    expect(await hub.claim("cft-preview-00")).toEqual({ active: false, lease });
  });

  it.each([
    ["no lease", undefined],
    ["a lease that is not an object", "cft-preview-01"],
    ["a lease without its time", { cluster: "cft-preview-01" }]
  ])("should refuse a standby answer when it carries %s", async (_label, lease) => {
    const { hub } = hubWith([json(200, { virtual_agents: [], active: false, lease })]);

    await expect(hub.claim("c")).rejects.toThrow("POST /api/orchestrator/claim: the hub said this cluster is on standby but not who holds the lease");
  });

  it("should post what was observed for an agent", async () => {
    const { hub, calls } = hubWith([new Response(null, { status: 204 })]);
    const body = { generation: 2, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: true };

    await hub.observed("a/b", body);

    expect(calls[0]!.url).toBe("https://agent-hub.example/api/orchestrator/virtual-agents/a%2Fb/observed");
    expect(calls[0]!.init.body).toBe(JSON.stringify(body));
  });

  it("should post an apply error for an agent", async () => {
    const { hub, calls } = hubWith([new Response(null, { status: 204 })]);
    const body = { generation: 3, error: "GET services/va-1: 403 forbidden" };

    await hub.applyFailed("a/b", body);

    expect(calls[0]!.url).toBe("https://agent-hub.example/api/orchestrator/virtual-agents/a%2Fb/apply-failed");
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: JSON.stringify(body) });
  });

  it("should list the live agents without a body", async () => {
    const live = [{ id: "a", statefulset_name: "va-a", pvc_name: null, cluster: "cft-preview-00" }];
    const { hub, calls } = hubWith([json(200, { virtual_agents: live })]);

    expect(await hub.live()).toEqual(live);
    expect(calls[0]!.init).toMatchObject({ method: "GET", body: undefined });
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("should retry with backoff when the hub fails or the network does", async () => {
    const { hub, sleeps } = hubWith([json(503, { error: "starting" }), new Error("ECONNRESET"), json(429, {}), json(200, { virtual_agents: [] })]);

    expect(await hub.live()).toEqual([]);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("should give up with the last failure when every attempt fails", async () => {
    const { hub, calls } = hubWith([json(502, { error: "bad gateway" }), json(502, { error: "bad gateway" })], { attempts: 2 });

    await expect(hub.live()).rejects.toThrow("GET /api/orchestrator/live: 502 bad gateway");
    expect(calls).toHaveLength(2);
  });

  it("should not retry a request the hub refused, and keep its status", async () => {
    const { hub, calls } = hubWith([json(409, { error: "generation 9 has not been asked for" })]);

    const failure = await hub
      .observed("a", { generation: 9, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: false })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HubError);
    expect(failure).toMatchObject({ status: 409, message: expect.stringContaining("generation 9") });
    expect(calls).toHaveLength(1);
  });

  it("should name only the status when an error has no JSON body", async () => {
    const { hub } = hubWith([new Response("<html>", { status: 401 })]);

    await expect(hub.live()).rejects.toThrow("GET /api/orchestrator/live: 401 401");
  });

  it("should name only the status when an error's JSON has no message", async () => {
    const { hub } = hubWith([json(400, { problem: "x" })]);

    await expect(hub.live()).rejects.toThrow("GET /api/orchestrator/live: 400 400");
  });

  it("should retry and then fail when no token can be had", async () => {
    const failing: TokenCredential = { getToken: async () => null };
    const { hub, calls } = hubWith([], { credential: failing, attempts: 2 });

    await expect(hub.claim("c")).rejects.toThrow(`no token for ${SCOPE}`);
    expect(calls).toHaveLength(0);
  });

  it("should report a thrown value that is not an Error", async () => {
    const throwing: TokenCredential = {
      getToken: async () => {
        throw "unavailable";
      }
    };
    const { hub } = hubWith([], { credential: throwing, attempts: 1 });

    await expect(hub.claim("c")).rejects.toThrow("POST /api/orchestrator/claim: unavailable");
  });

  it("should never put a claim's launch tokens in an error when the claim body is unreadable", async () => {
    const { hub } = hubWith([new Response("ahv_secret not json", { status: 200 })]);

    const failure = await hub.claim("c").catch((error: unknown) => error);
    expect(String(failure)).not.toContain("ahv_secret");
  });

  it("should not attempt at all when no attempts are allowed", async () => {
    const { hub } = hubWith([], { attempts: 0 });

    await expect(hub.live()).rejects.toThrow("was not attempted");
  });
});

describe("createHub's defaults", () => {
  it("should wait between attempts on a timer when no sleep is given", async () => {
    const responses = [json(503, {}), json(200, { virtual_agents: [] })];
    const fetch = vi.fn(async () => responses.shift()!) as unknown as typeof globalThis.fetch;
    const hub = createHub({ url: "https://agent-hub.example", scope: SCOPE, credential, fetch, backoffMs: 1 });

    expect(await hub.live()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
