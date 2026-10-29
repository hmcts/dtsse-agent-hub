import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "./__fixtures__/mock-hub.ts";
import {
  type Api,
  ApiError,
  createApi,
  createTokenProvider,
  DEFAULT_SCOPE,
  DEFAULT_URL,
  isMissingRoute,
  parseAzToken,
  type RunAz,
  requireAzureLogin
} from "./api.ts";
import { CLIENT_FEATURES } from "./features.ts";

const VID = "0f8a6a1e-1234-4000-8000-00000000000a";
const LAUNCH = `launch-${"q".repeat(16)}`;
const DEV_USER = "oid-alice|Alice Smith|alice@example.com";
/** What an unmatched path answers with: the first of the Next.js not-found document, as `request` slices it. */
const ERROR_PAGE = '<!DOCTYPE html><html lang="en" class="dark h-full"><head><meta charSet="utf-8"/>';

let hub: MockHub;
let url: string;
let api: Api;
let pod: Api;
let agentId: string;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: { oid: "oid-alice", name: "Alice Smith", email: "alice@example.com" } } } });
  url = await hub.listen();
  api = createApi({ env: {}, baseUrl: url, devUser: DEV_USER });
  pod = createApi({ env: {}, baseUrl: url, launchToken: LAUNCH });
  agentId = (
    await api.register({
      session_id: "sid-api-test",
      name: "alice-pcs-api",
      name_source: "derived",
      cwd: "/work",
      repo: "pcs-api",
      branch: "main",
      host: "box",
      client_features: [...CLIENT_FEATURES]
    })
  ).agent_id;
});

afterAll(async () => {
  await hub.close();
});

// A fetch that answers whatever it is given and records how it was called.
function recordingFetch(answer: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer();
  };
  return { calls, fetchImpl };
}

// A stand-in `az` on PATH, so the default runner is exercised rather than a stub.
function fakeAz(script: string): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-az-"));
  fs.writeFileSync(path.join(dir, "az"), script, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = dir;
  return {
    dir,
    restore: () => {
      process.env.PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("ApiError", () => {
  it("should name the method, path, status and the service's message when the body carries one", () => {
    // Act
    const error = new ApiError(409, { error: "ambiguous" }, "POST", "/api/agent/x/direct");

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("POST /api/agent/x/direct failed: 409 ambiguous");
    expect(error.status).toBe(409);
    expect(error.body).toEqual({ error: "ambiguous" });
  });

  it("should name only the status when there is no body", () => {
    // Act and assert
    expect(new ApiError(503, null, "GET", "/api/agent/agents").message).toBe("GET /api/agent/agents failed: 503");
  });

  it("should bound what the service's own message adds, however long it is", () => {
    // Act
    const error = new ApiError(500, { error: "x".repeat(300) }, "PUT", "/api/agent/x/artefact");

    // Assert
    expect(error.message).toBe(`PUT /api/agent/x/artefact failed: 500 ${"x".repeat(200)}`);
  });

  it("should keep an error page out of the message when the service answers with one rather than JSON", () => {
    // Act
    const error = new ApiError(404, { error: ERROR_PAGE }, "POST", "/api/virtual/x/login/atlassian/failed");

    // Assert: the document is still on the error, and none of it is in the sentence anything logs
    expect(error.message).toBe("POST /api/virtual/x/login/atlassian/failed failed: 404");
    expect(error.body).toEqual({ error: ERROR_PAGE });
  });
});

describe("isMissingRoute", () => {
  it("should be true when a 404 came back as the app's own error page", () => {
    // Act and assert
    expect(isMissingRoute(new ApiError(404, { error: ERROR_PAGE }, "POST", "/api/virtual/x/login/atlassian/failed"))).toBe(true);
  });

  it("should be false when a route of the hub's own answered the 404", () => {
    // Act and assert: a route that refuses sends JSON, and is a refusal to read rather than a deploy to wait for
    expect(isMissingRoute(new ApiError(404, { error: "there is no atlassian sign-in to report on" }, "POST", "/api/virtual/x/login/atlassian/failed"))).toBe(
      false
    );
  });

  it("should be false for another status, and for anything that is not an ApiError", () => {
    // Act and assert
    expect(isMissingRoute(new ApiError(500, { error: ERROR_PAGE }, "POST", "/api/virtual/x/login/atlassian/failed"))).toBe(false);
    expect(isMissingRoute(new Error("fetch failed"))).toBe(false);
  });
});

describe("parseAzToken", () => {
  it("should read expires_on as seconds since the epoch when az prints one", () => {
    // Act and assert
    expect(parseAzToken('{"accessToken":"tok","expires_on":"1764590400"}')).toEqual({ token: "tok", expiresAt: 1764590400000 });
  });

  it("should fall back to expiresOn when there is no expires_on", () => {
    // Act
    const parsed = parseAzToken('{"accessToken":"tok","expiresOn":"2026-12-01T12:00:00Z"}');

    // Assert
    expect(parsed).toEqual({ token: "tok", expiresAt: Date.parse("2026-12-01T12:00:00Z") });
  });

  it("should assume half an hour when neither expiry can be read", () => {
    // Act and assert
    expect(parseAzToken('{"accessToken":"tok","expiresOn":"never"}', 1000)).toEqual({ token: "tok", expiresAt: 1000 + 30 * 60 * 1000 });
    expect(parseAzToken('{"accessToken":"tok"}', 1000)).toEqual({ token: "tok", expiresAt: 1000 + 30 * 60 * 1000 });
  });

  it("should throw when az printed no access token", () => {
    // Act and assert
    expect(() => parseAzToken('{"subscription":"x"}')).toThrow("az returned no accessToken");
  });
});

describe("requireAzureLogin", () => {
  it("should ask az to show the account when it is called", async () => {
    // Arrange
    const seen: string[][] = [];
    const run: RunAz = async (args) => {
      seen.push(args);
      return "";
    };

    // Act
    await requireAzureLogin(run);

    // Assert
    expect(seen).toEqual([["account", "show", "-o", "none"]]);
  });

  it("should tell the caller to sign in when az refuses", async () => {
    // Arrange
    const run: RunAz = async () => {
      throw new Error("az account show failed: please run az login");
    };

    // Act and assert
    await expect(requireAzureLogin(run)).rejects.toThrow(/not logged in to Azure — run: az login\n\(az account show failed: please run az login\)/);
  });

  it("should accept the real az on PATH when it exits cleanly", async () => {
    // Arrange
    const az = fakeAz("#!/bin/sh\nexit 0\n");

    // Act and assert
    await expect(requireAzureLogin()).resolves.toBeUndefined();
    az.restore();
  });

  it("should report what the real az wrote to stderr when it fails", async () => {
    // Arrange
    const az = fakeAz("#!/bin/sh\necho \"Please run 'az login'\" >&2\nexit 1\n");

    // Act and assert
    await expect(requireAzureLogin()).rejects.toThrow(/az account show failed: Please run 'az login'/);
    az.restore();
  });

  it("should say az is not installed when there is no az on PATH", async () => {
    // Arrange
    const az = fakeAz("#!/bin/sh\nexit 0\n");
    fs.rmSync(path.join(az.dir, "az"));

    // Act and assert
    await expect(requireAzureLogin()).rejects.toThrow("az is not installed");
    az.restore();
  });
});

describe("createTokenProvider", () => {
  it("should ask az once and reuse the token while it is fresh", async () => {
    // Arrange
    let calls = 0;
    const run: RunAz = async () => {
      calls += 1;
      return JSON.stringify({ accessToken: `tok-${calls}`, expires_on: String(3600) });
    };
    const getToken = createTokenProvider({ run, now: () => 0 });

    // Act and assert
    expect(await getToken()).toBe("tok-1");
    expect(await getToken()).toBe("tok-1");
    expect(calls).toBe(1);
  });

  it("should ask az again when the cached token is inside the refresh margin", async () => {
    // Arrange
    let calls = 0;
    let clock = 0;
    const run: RunAz = async () => {
      calls += 1;
      return JSON.stringify({ accessToken: `tok-${calls}`, expires_on: String((clock + 10 * 60 * 1000) / 1000) });
    };
    const getToken = createTokenProvider({ run, now: () => clock });

    // Act
    await getToken();
    clock += 6 * 60 * 1000;
    const second = await getToken();

    // Assert
    expect(second).toBe("tok-2");
    expect(calls).toBe(2);
  });

  it("should make one call when two callers ask at the same time", async () => {
    // Arrange
    let calls = 0;
    const run: RunAz = async () => {
      calls += 1;
      return JSON.stringify({ accessToken: "tok", expires_on: String(3600) });
    };
    const getToken = createTokenProvider({ run, now: () => 0 });

    // Act
    const both = await Promise.all([getToken(), getToken()]);

    // Assert
    expect(both).toEqual(["tok", "tok"]);
    expect(calls).toBe(1);
  });

  it("should pass the default scope to az when none is given", async () => {
    // Arrange
    const seen: string[][] = [];
    const run: RunAz = async (args) => {
      seen.push(args);
      return JSON.stringify({ accessToken: "tok", expires_on: String(3600) });
    };

    // Act
    await createTokenProvider({ run, now: () => 0 })();

    // Assert
    expect(seen).toEqual([["account", "get-access-token", "--scope", DEFAULT_SCOPE, "-o", "json"]]);
  });
});

describe("createApi authentication", () => {
  it("should send X-Dev-User when the environment names a development user", async () => {
    // Act
    const headers = await createApi({ env: { AGENT_HUB_DEV_USER: DEV_USER } }).headers();

    // Assert
    expect(headers).toEqual({ "X-Dev-User": DEV_USER });
  });

  it("should send the launch token as the bearer when the environment is a virtual agent's pod", async () => {
    // Act
    const headers = await createApi({
      env: { AGENT_HUB_VIRTUAL_AGENT_ID: VID, AGENT_HUB_LAUNCH_TOKEN: LAUNCH, AGENT_HUB_DEV_USER: DEV_USER }
    }).headers({ Accept: "text/event-stream" });

    // Assert: a pod authenticates as itself, and never as a development user.
    expect(headers).toEqual({ Accept: "text/event-stream", Authorization: `Bearer ${LAUNCH}` });
  });

  it("should not treat a launch token with no agent id as a pod", async () => {
    // Act
    const headers = await createApi({ env: { AGENT_HUB_LAUNCH_TOKEN: LAUNCH, AGENT_HUB_DEV_USER: DEV_USER } }).headers();

    // Assert
    expect(headers).toEqual({ "X-Dev-User": DEV_USER });
  });

  it("should refuse to build a request when there is no credential at all", async () => {
    // Act and assert
    await expect(createApi({ env: {}, getToken: null }).headers()).rejects.toThrow(/no agent-hub credential/);
  });

  it("should take the base URL from the environment and strip its trailing slashes", () => {
    // Act and assert
    expect(createApi({ env: { AGENT_HUB_URL: "https://hub.example.net//", AGENT_HUB_DEV_USER: DEV_USER } }).baseUrl).toBe("https://hub.example.net");
    expect(createApi({ env: { AGENT_HUB_DEV_USER: DEV_USER } }).baseUrl).toBe(DEFAULT_URL);
  });

  it("should ask az for a token for AGENT_HUB_SCOPE when nothing else identifies the caller", async () => {
    // Arrange
    const az = fakeAz('#!/bin/sh\necho "$@" >&2\necho \'{"accessToken":"from-az","expires_on":"99999999999"}\'\n');

    // Act
    const headers = await createApi({ env: { AGENT_HUB_SCOPE: "api://other/.default" } }).headers();

    // Assert
    expect(headers).toEqual({ Authorization: "Bearer from-az" });
    az.restore();
  });
});

describe("createApi requests", () => {
  it("should register a session and give back the agent the hub stored", async () => {
    // Assert
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(hub.agents.get(agentId)).toMatchObject({ session_id: "sid-api-test", name: "alice-pcs-api", repo: "pcs-api", branch: "main" });
  });

  it("should post, read the feed and move the cursor when the agent is subscribed", async () => {
    // Arrange
    await api.subscribe(agentId, ["pcs-api"]);
    hub.addPost({ topics: ["pcs-api"], title: "Schema change", bodyText: "a new column", fromAgent: "bob-pcs-api" });

    // Act
    const feed = await api.feed(agentId, { limit: 10 });
    await api.setCursor(agentId, feed.cursor);

    // Assert
    expect(feed.messages.map((m) => m.title)).toEqual(["Schema change"]);
    expect(hub.agents.get(agentId)?.read_cursor).toBe(Number(feed.cursor));
  });

  it("should leave an empty parameter out of the query string", async () => {
    // Arrange
    const { calls, fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ topics: [] }), { status: 200 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    await stubbed.topics({ prefix: "", limit: 50 });
    await stubbed.topics();
    await stubbed.topicMessages("pcs-api", { since: 7 });

    // Assert
    expect(calls.map((c) => c.url)).toEqual([
      "https://hub.example.net/api/agent/topics?limit=50",
      "https://hub.example.net/api/agent/topics",
      "https://hub.example.net/api/agent/topics/pcs-api/messages?since=7"
    ]);
  });

  it("should list the topics and the agents the caller may message", async () => {
    // Act
    const [topics, agents] = await Promise.all([api.topics({ limit: 200 }), api.agents()]);

    // Assert
    expect(topics.topics.some((t) => t.slug === "pcs-api" && t.message_count > 0)).toBe(true);
    expect(agents.agents.some((a) => a.id === agentId)).toBe(true);
  });

  it("should add and remove subscriptions and read back the whole set", async () => {
    // Act
    const added = await api.subscribe(agentId, ["ccd", "pcs-api"]);
    const read = await api.subscriptions(agentId);
    const removed = await api.unsubscribe(agentId, ["ccd"]);

    // Assert
    expect(added.topics).toEqual(["ccd", "pcs-api"]);
    expect(read.topics).toEqual(["ccd", "pcs-api"]);
    expect(removed.topics).toEqual(["pcs-api"]);
  });

  it("should send a direct message, fetch it back by id and ack its delivery", async () => {
    // Arrange
    const incoming = hub.sendDirectFromUser(agentId, "can you rerun the migration?");

    // Act
    const fetched = await api.message(incoming.id);
    await api.ack(agentId, incoming.id);

    // Assert
    expect(fetched.message.body).toBe("can you rerun the migration?");
    expect(hub.deliveries.get(`${incoming.id}:${agentId}`)?.state).toBe("delivered");
  });

  it("should publish a post and send a direct reply to it", async () => {
    // Act
    const published = await api.post(agentId, { topics: ["pcs-api"], title: "Done", body: "migration rerun" });
    const replied = await api.direct(agentId, { reply_to_message: published.message.id, body: "thanks" });

    // Assert
    expect(published.message.kind).toBe("post");
    expect(replied.message.in_reply_to).toBe(published.message.id);
  });

  it("should tag agents in a post, which queues each of them a delivery of it", async () => {
    // Arrange: another person's agent, which a tagged post is the way to reach.
    const other = await createApi({ env: {}, baseUrl: url, devUser: "oid-bob|Bob Jones|bob@example.com" }).register({
      session_id: "sid-api-tagged",
      name: "bob-ccd",
      name_source: "derived",
      cwd: null,
      repo: null,
      branch: null,
      host: null,
      client_features: [...CLIENT_FEATURES]
    });

    // Act
    const published = await api.post(agentId, { topics: ["pcs-api"], title: "Over to you", body: "your turn", tag_agents: ["bob-ccd"] });

    // Assert
    expect(published.message.kind).toBe("post");
    expect(published.message.tagged_agents).toEqual([{ id: other.agent_id, name: "bob-ccd" }]);
    expect(hub.deliveries.get(`${published.message.id}:${other.agent_id}`)?.state).toBe("queued");
  });

  it("should refuse the whole post when a tag names no agent", async () => {
    // Act
    const refused = await api.post(agentId, { topics: ["pcs-api"], title: "Nobody", body: "x", tag_agents: ["no-such-agent"] }).catch((error) => error);

    // Assert
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(404);
    expect(hub.messages.some((message) => message.title === "Nobody")).toBe(false);
  });

  it("should heartbeat with the session's skills and take the agent offline", async () => {
    // Act
    await api.heartbeat(agentId, { status: "busy", name: "alice-pcs-api", skills: [{ name: "cft-explain", description: "explains" }] });
    const busy = hub.agents.get(agentId)?.status;
    await api.offline(agentId, { timeoutMs: 5000 });

    // Assert
    expect(busy).toBe("busy");
    expect(hub.agents.get(agentId)?.status).toBe("offline");
  });

  it("should upload a transcript batch and report how many entries were new", async () => {
    // Arrange
    const body = {
      session_id: "sid-api-test",
      entries: [
        {
          key: "e1",
          role: "user" as const,
          content: { text: "hello" },
          truncated: false,
          redacted: false,
          message_id: null,
          occurred_at: new Date().toISOString()
        }
      ]
    };

    // Act
    const first = await api.transcript(agentId, body);
    const again = await api.transcript(agentId, body, { timeoutMs: 5000 });

    // Assert
    expect(first.accepted).toBe(1);
    expect(again.accepted).toBe(0);
  });

  it("should throw an ApiError carrying the status and the service's body when the hub refuses", async () => {
    // Act
    const error = await api.message("999999").catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ error: "no such message" });
  });

  it("should carry the candidates of an ambiguous direct message when the hub answers 409", async () => {
    // Arrange
    hub.addPost({ topics: ["pcs-api"], bodyText: "one", fromAgent: "twin" });
    hub.addPost({ topics: ["pcs-api"], bodyText: "two", fromAgent: "twin" });

    // Act
    const error = await api.direct(agentId, { to_agent: "twin", body: "which of you?" }).catch((e) => e);

    // Assert
    expect(error.status).toBe(409);
    expect(error.body.candidates.map((c: { name: string }) => c.name)).toEqual(["twin", "twin"]);
  });

  it("should put a body that is not JSON into the error when the service answers in plain text", async () => {
    // Arrange
    const { fetchImpl } = recordingFetch(() => new Response("<html>gateway timeout</html>", { status: 504 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.agents().catch((e) => e);

    // Assert
    expect(error.status).toBe(504);
    expect(error.body).toEqual({ error: "<html>gateway timeout</html>" });
  });

  it("should read a JSON body that is not an object as text, rather than call it the contract's error", async () => {
    // Arrange: `502` parses as JSON, and handing a caller a number typed as `{ error }` would be a lie
    const { fetchImpl } = recordingFetch(() => new Response("502", { status: 502 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.agents().catch((e) => e);

    // Assert
    expect(error.body).toEqual({ error: "502" });
    expect(error.message).toBe("GET /api/agent/agents failed: 502 502");
  });

  it("should bound a body that is not JSON at all, whatever the service sent", async () => {
    // Arrange
    const { fetchImpl } = recordingFetch(() => new Response("y".repeat(5000), { status: 500 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.agents().catch((e) => e);

    // Assert
    expect(error.body).toEqual({ error: "y".repeat(200) });
  });

  it("should give back null when a 204 answers with no body", async () => {
    // Arrange
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act and assert
    await expect(stubbed.deleteMyCredential("claude_md")).resolves.toBeNull();
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("should abort a request that outlives its timeout", async () => {
    // Arrange
    const { calls, fetchImpl } = recordingFetch(() => new Response("{}", { status: 200 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    await stubbed.offline(agentId, { timeoutMs: 20 });
    const signal = calls[0]?.init?.signal as AbortSignal;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Assert
    expect(signal.aborted).toBe(true);
  });
});

describe("createApi credentials", () => {
  it("should read back the caller's own credential and answer null when none is stored", async () => {
    // Act
    const missing = await api.myCredential("claude_md");
    await api.putMyCredential("claude_md", "# my CLAUDE.md");
    const stored = await api.myCredential("claude_md");
    await api.deleteMyCredential("claude_md");

    // Assert
    expect(missing).toBeNull();
    expect(stored).toBe("# my CLAUDE.md");
    expect(await api.myCredential("claude_md")).toBeNull();
  });

  it("should throw rather than answer null when the hub refuses a write-only kind", async () => {
    // Act
    const error = await api.myCredential("github").catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(405);
  });

  it("should read and write the owner's credentials through the pod's own routes", async () => {
    // Act
    const missing = await pod.getCredential(VID, "github");
    await pod.putCredential(VID, "github", "ghp_abc");
    const stored = await pod.getCredential(VID, "github");

    // Assert
    expect(missing).toBeNull();
    expect(stored).toBe("ghp_abc");
    expect(await pod.getCredential(VID, "claude_md")).toBe("You are running in a pod in Preview and connected via the agent hub.");
  });

  it("should report a phase to the hub with and without a detail", async () => {
    // Act
    await pod.virtualStatus(VID, "provisioning");
    await pod.virtualStatus(VID, "awaiting_login", "github: the owner must enter a code");

    // Assert
    expect(hub.virtuals.get(VID)?.status).toEqual([{ phase: "provisioning" }, { phase: "awaiting_login", detail: "github: the owner must enter a code" }]);
  });

  it("should report listening ports through the pod's ports route", async () => {
    // Act
    await pod.putPorts(VID, { ports: [3000], local_only: [5173] });

    // Assert
    expect(hub.virtuals.get(VID)?.ports.at(-1)).toEqual({ ports: [3000], local_only: [5173] });
  });

  it("should relay a sign-in, poll for the pasted code and complete it", async () => {
    // Act
    await pod.loginPrompt(VID, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/code", expires_in: 600 });
    const beforePaste = await pod.loginCode(VID, "claude");
    hub.virtuals.get(VID)?.codes.set("claude", "the-code");
    const afterPaste = await pod.loginCode(VID, "claude");
    await pod.loginComplete(VID, "claude");

    // Assert
    expect(beforePaste).toBeNull();
    expect(afterPaste).toBe("the-code");
    expect(hub.virtuals.get(VID)?.prompts.at(-1)).toMatchObject({ kind: "claude", prompt: "paste_code" });
    expect(hub.virtuals.get(VID)?.completes.at(-1)).toEqual({ kind: "claude" });
  });

  it("should say whether the owner has asked for a sign-in, and forget it once one is relayed", async () => {
    // Arrange
    hub.virtuals.get(VID)?.signInRequests.add("azure");

    // Act
    const asked = await pod.signInRequested(VID, "azure");
    await pod.loginPrompt(VID, "azure", { prompt: "device_code", verification_uri: "https://login.microsoft.com/device", user_code: "ABC", expires_in: 900 });
    const after = await pod.signInRequested(VID, "azure");

    // Assert
    expect(asked).toBe(true);
    expect(after).toBe(false);
  });

  it.each([404, 405])("should answer that nobody asked when the hub answers %i for the route it does not have", async (status) => {
    // Arrange
    const api = createApi({ baseUrl: "http://hub", launchToken: "t", fetchImpl: async () => new Response("", { status }) });

    // Act & Assert
    expect(await api.signInRequested(VID, "azure")).toBe(false);
  });

  it("should throw when the hub cannot say whether a sign-in was asked for", async () => {
    // Arrange
    const api = createApi({ baseUrl: "http://hub", launchToken: "t", fetchImpl: async () => new Response("", { status: 500 }) });

    // Act & Assert
    await expect(api.signInRequested(VID, "azure")).rejects.toThrow(/500/);
  });
});

describe("createApi conversations", () => {
  it("should open the sessions stream as the agent stream is opened when the pod asks for it", async () => {
    // Arrange
    const controller = new AbortController();

    // Act
    const res = await pod.sessionsStream(VID, { signal: controller.signal });

    // Assert
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(hub.calls.filter((c) => c.path === `/api/virtual/${VID}/sessions`).at(-1)?.headers.accept).toBe("text/event-stream");
    controller.abort();
  });

  it("should throw an ApiError naming the sessions path when the hub refuses the stream", async () => {
    // Act
    const error = await api.sessionsStream(VID).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(`GET /api/virtual/${VID}/sessions failed: 403 forbidden`);
  });

  it("should put what the supervisor runs when it reports its sessions", async () => {
    // Arrange
    const body = { sessions: [{ conversation_id: "0f8a6a1e-0000-4000-8000-000000000001", state: "live" as const }], max: 4 };

    // Act
    await pod.putSessions(VID, body);

    // Assert
    expect(hub.virtuals.get(VID)?.sessionReports.at(-1)).toEqual(body);
  });

  it("should read the document back, save it with the base version and give the current one on a conflict", async () => {
    // Arrange
    const conversationAgent = (
      await pod.register({
        session_id: "sid-api-conv",
        name: "conv",
        name_source: "derived",
        conversation_id: "0f8a6a1e-0000-4000-8000-00000000000b",
        client_features: [...CLIENT_FEATURES]
      })
    ).agent_id;

    // Act
    const before = await pod.getArtefact(conversationAgent);
    const saved = await pod.putArtefact(conversationAgent, { markdown: "# Plan\n", base_version: 0, title: "Plan" });
    const after = await pod.getArtefact(conversationAgent);
    const stale = await pod.putArtefact(conversationAgent, { markdown: "other", base_version: 0 }).catch((e) => e);

    // Assert
    expect(before).toEqual({ title: null, markdown: "", version: 0, updated_by: null, updated_at: null });
    expect(saved).toEqual({ version: 1 });
    expect(after).toMatchObject({ title: "Plan", markdown: "# Plan\n", version: 1, updated_by: "agent" });
    expect(stale).toBeInstanceOf(ApiError);
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ version: 1, updated_by: "agent" });
  });

  it("should give a 404 the caller can tell apart when the agent is not a conversation's", async () => {
    // Act
    const error = await api.getArtefact(agentId).catch((e) => e);

    // Assert
    expect(error.status).toBe(404);
    expect(error.body).toEqual({ error: "not a conversation" });
  });

  it("should list the virtual agent's conversations, which the uploads reconciliation reads", async () => {
    // Act
    const { conversations } = await pod.conversations(VID);

    // Assert
    expect(Array.isArray(conversations)).toBe(true);
  });
});

describe("createApi questions", () => {
  const QUESTION = {
    session_id: "sid-api-test",
    tool_use_id: "toolu_bdrk_01TNH",
    questions: [
      {
        question: "Do you prefer red or blue?",
        header: "Color",
        options: [
          { label: "Red", description: "You prefer red." },
          { label: "Blue", description: "You prefer blue." }
        ],
        multiSelect: false
      }
    ]
  };

  it("should post the question set for the agent when a session's hook intercepted one", async () => {
    // Act
    await api.postQuestion(agentId, QUESTION);

    // Assert
    expect(hub.calls.at(-1)?.path).toBe(`/api/agent/${agentId}/question`);
    // `asked_at` is the hub's own, not the caller's: the offer window is read against when the hub stored it.
    expect(hub.questions.at(-1)).toEqual({ agent_id: agentId, asked_at: expect.any(String), ...QUESTION });
  });

  // The hook denies the tool whether or not the POST answered, so a retry after a lost response is a real case.
  it("should leave one question on screen when the same tool use is posted twice", async () => {
    // Act
    await api.postQuestion(agentId, QUESTION);
    await api.postQuestion(agentId, QUESTION);

    // Assert
    expect(hub.questions.filter((asked) => asked.tool_use_id === QUESTION.tool_use_id)).toHaveLength(1);
  });

  it("should throw an ApiError naming the question path when the hub refuses the body", async () => {
    // Act
    const error = await api.postQuestion(agentId, { ...QUESTION, questions: [] }).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe(`POST /api/agent/${agentId}/question failed: 400 bad question`);
  });

  // The caller has to be able to tell this from the idempotent retry above: nothing was written, so there is no
  // card for the model to wait for and it has to be sent back to asking in words.
  it("should throw a 409 when a different question of this session's is still unanswered", async () => {
    // Arrange
    await api.postQuestion(agentId, QUESTION);

    // Act
    const error = await api.postQuestion(agentId, { ...QUESTION, tool_use_id: "toolu_second" }).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(hub.questions.filter((asked) => asked.agent_id === agentId)).toHaveLength(1);
  });
});

describe("createApi attachments", () => {
  const UPLOAD = "0f8a6a1e-0000-4000-8000-0000000000a1";

  it("should read one part as raw bytes and report the whole file fetched", async () => {
    // Arrange
    hub.attachments.set(UPLOAD, { parts: [new Uint8Array([1, 2, 3]), new Uint8Array([4])], fetched: false });

    // Act
    const first = await api.attachmentPart(agentId, UPLOAD, 0);
    const second = await api.attachmentPart(agentId, UPLOAD, 1);
    await api.attachmentFetched(agentId, UPLOAD);

    // Assert
    expect([...first]).toEqual([1, 2, 3]);
    expect([...second]).toEqual([4]);
    expect(hub.attachments.get(UPLOAD)).toEqual({ parts: [], fetched: true });
  });

  it("should raise a 404 the caller can tell apart when the part is not there", async () => {
    // Arrange
    hub.attachments.set(UPLOAD, { parts: [], fetched: true });

    // Act
    const error = await api.attachmentPart(agentId, UPLOAD, 0).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });

  it("should carry the body of a refusal that is not JSON into the error", async () => {
    // Arrange
    const { fetchImpl } = recordingFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.attachmentPart(agentId, UPLOAD, 0).catch((e) => e);

    // Assert
    expect(error.status).toBe(502);
    expect(error.body.error).toBe("<html>bad gateway</html>");
  });
});

describe("createApi stream", () => {
  it("should open the event stream and send Last-Event-ID when the client has one", async () => {
    // Arrange
    const controller = new AbortController();

    // Act
    const res = await api.stream(agentId, { signal: controller.signal, lastEventId: "42" });

    // Assert
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const call = hub.calls.filter((c) => c.path === `/api/agent/${agentId}/stream`).at(-1);
    expect(call?.headers["last-event-id"]).toBe("42");
    controller.abort();
  });

  it("should throw an ApiError holding the service's body when the stream is refused", async () => {
    // Arrange
    hub.failNextStreams(1, 429);

    // Act
    const error = await api.stream(agentId).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.body).toEqual({ error: "stream refused" });
  });

  it("should throw holding the text when the refusal is not JSON", async () => {
    // Arrange
    const { fetchImpl } = recordingFetch(() => new Response("nope", { status: 500 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.stream(agentId).catch((e) => e);

    // Assert
    expect(error.status).toBe(500);
    expect(error.body).toEqual({ error: "nope" });
  });

  it("should let a stream opened against a service without the route be recognised as one", async () => {
    // Arrange: a client newer than the service it is talking to meets this on a stream as readily as anywhere
    // else, so the stream has to read an unparseable body rather than discard it.
    const { fetchImpl } = recordingFetch(() => new Response(ERROR_PAGE, { status: 404 }));
    const stubbed = createApi({ env: {}, baseUrl: "https://hub.example.net", devUser: DEV_USER, fetchImpl });

    // Act
    const error = await stubbed.stream(agentId).catch((e) => e);

    // Assert
    expect(isMissingRoute(error)).toBe(true);
    expect(error.message).toBe(`GET /api/agent/${agentId}/stream failed: 404`);
  });
});
