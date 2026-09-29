import { generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as heartbeat } from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import { POST as offline } from "../../src/app/api/agent/[agentId]/offline/route.ts";
import { POST as register } from "../../src/app/api/agent/register/route.ts";
import { devUser, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

const ALICE = person("alice");
const BOB = person("bob");

const REGISTRATION = { session_id: "session-1", name: "alice-pcs-api", cwd: "/work/pcs-api", repo: "pcs-api", branch: "master", host: "laptop" };

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/agent/register", () => {
  it("should create the agent and record its owner from the caller's identity", async () => {
    const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION });

    expect(response.status).toBe(200);
    const { agent_id, name } = await jsonOf(response);
    expect(name).toBe("alice-pcs-api");
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agent_id }, include: { owner: true } });
    expect(agent).toMatchObject({ ownerOid: ALICE.oid, status: "idle", repo: "pcs-api", cwd: "/work/pcs-api" });
    expect(agent.owner).toMatchObject({ name: ALICE.name, email: ALICE.email, tid: "dev" });
  });

  it("should return the same agent when the same session registers again, with its metadata refreshed and status idle", async () => {
    const first = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));
    await prisma.agent.update({ where: { id: first.agent_id }, data: { status: "offline", endedAt: new Date() } });

    const second = await jsonOf(
      await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, name: "renamed", branch: "HDPI-1" } })
    );

    expect(second).toEqual({ agent_id: first.agent_id, name: "renamed" });
    expect(await prisma.agent.count()).toBe(1);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: first.agent_id } })).toMatchObject({ status: "idle", branch: "HDPI-1", endedAt: null });
  });

  it("should refuse to take over a session registered by someone else", async () => {
    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION });

    const response = await call(register, { as: BOB, path: "/api/agent/register", method: "POST", body: REGISTRATION });

    expect(response.status).toBe(409);
    expect(await prisma.agent.findFirstOrThrow()).toMatchObject({ ownerOid: ALICE.oid });
  });

  it("should start a new agent's read cursor at the newest message, so it is not handed the whole board", async () => {
    await prisma.user.create({ data: { oid: "oid-x", tid: "dev", name: "X" } });
    const topic = await prisma.topic.create({ data: { slug: "old" } });
    const old = await prisma.message.create({
      data: { kind: "post", authorOid: "oid-x", body: "before", topics: { create: [{ topicId: topic.id }] } }
    });

    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).readCursor).toBe(old.id);
  });

  it("should refuse a registration without a session id", async () => {
    const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { name: "x" } });

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/session_id/);
  });

  it("should refuse a caller with no identity", async () => {
    const request = new Request("http://localhost:3000/api/agent/register", { method: "POST", body: JSON.stringify(REGISTRATION) });

    const response = await register(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function registration(headers: Record<string, string>): Request {
    return new Request("http://localhost:3000/api/agent/register", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(REGISTRATION)
    });
  }

  it("should record an X-Dev-User oid under the dev- prefix, so the header cannot act as a real person", async () => {
    const real = "a1b2c3d4-0000-0000-0000-000000000001";

    const response = await register(registration({ "x-dev-user": `${real}|Real Person|real@example.com` }), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    const agent = await prisma.agent.findFirstOrThrow();
    expect(agent.ownerOid).toBe(`dev-${real}`);
    expect(await prisma.user.findUnique({ where: { oid: real } })).toBeNull();
  });

  it("should answer 503 rather than trust X-Dev-User when the bypass is set on a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await register(registration({ "x-dev-user": devUser(ALICE) }), { params: Promise.resolve({}) });

    expect(response.status).toBe(503);
    expect(await prisma.agent.count()).toBe(0);
  });

  it("should answer 503 with Retry-After, not 401, when the tenant's keys cannot be fetched", async () => {
    vi.stubEnv("AGENT_AUTH_DISABLED", "");
    vi.stubEnv("ENTRA_TENANT_ID", "outage-tenant");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed")))
    );
    const { privateKey } = await generateKeyPair("RS256");
    const jwt = await new SignJWT({ oid: "an-oid", tid: "outage-tenant", scp: "user_impersonation" })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer("https://login.microsoftonline.com/outage-tenant/v2.0")
      .setAudience("api://dtsse-agent-hub")
      .setExpirationTime("5m")
      .sign(privateKey);

    const response = await register(registration({ authorization: `Bearer ${jwt}` }), { params: Promise.resolve({}) });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

describe("heartbeat and offline", () => {
  it("should record the status and name, and bring an offline agent back", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));
    const params = { agentId: agent_id };

    expect((await call(offline, { as: ALICE, path: `/api/agent/${agent_id}/offline`, method: "POST", params })).status).toBe(204);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ status: "offline" });

    const response = await call(heartbeat, {
      as: ALICE,
      path: `/api/agent/${agent_id}/heartbeat`,
      method: "POST",
      params,
      body: { status: "busy", name: "new" }
    });

    expect(response.status).toBe(204);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ status: "busy", name: "new", endedAt: null });
  });

  it("should give 404 for an agent that does not exist, so the client re-registers", async () => {
    for (const agentId of ["7d9f1c7e-1111-4222-8333-944455556666", "not-a-uuid"]) {
      const response = await call(heartbeat, {
        as: ALICE,
        path: `/api/agent/${agentId}/heartbeat`,
        method: "POST",
        params: { agentId },
        body: { status: "idle" }
      });
      expect(response.status).toBe(404);
      expect(await jsonOf(response)).toEqual({ error: "no such agent" });
    }
  });

  it("should give 403 when the caller does not own the agent", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));

    const response = await call(heartbeat, {
      as: BOB,
      path: `/api/agent/${agent_id}/heartbeat`,
      method: "POST",
      params: { agentId: agent_id },
      body: { status: "idle" }
    });

    expect(response.status).toBe(403);
  });
});
