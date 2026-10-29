import { generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgent, SessionOwnedElsewhere } from "../../src/agents/store.ts";
import { POST as heartbeat } from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import { POST as offline } from "../../src/app/api/agent/[agentId]/offline/route.ts";
import { POST as register } from "../../src/app/api/agent/register/route.ts";
import { createConversation, ensureAssistant, linkLocalSession, listConversations } from "../../src/assistant/store.ts";
import { devUser, insertAgent, insertUser, person, prisma, resetDatabase } from "./database.ts";
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

  it("should store the reported skills, and keep them when a later registration of the session sends none", async () => {
    const skills = [
      { name: "pcs:start-env", description: "Start an environment" },
      { name: "cft-explain", description: "Explain a CFT topic" }
    ];
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, skills } }));

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([skills[1], skills[0]]);

    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, branch: "HDPI-2" } });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([skills[1], skills[0]]);

    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, skills: [] } });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([]);
  });

  it("should register the session and keep the stored skills when the skills field is not a list", async () => {
    const skills = [{ name: "cft-explain", description: "Explain a CFT topic" }];
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, skills } }));
    const stored = async () => (await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills;
    expect(await stored()).toEqual(skills);

    // A hand-rolled client sending the field as `null`. Refusing it would take the whole session off the hub, which
    // is worse than the one field the shape costs: a non-list reads as the field not being sent, so the list stands.
    const asNull = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, skills: null } });
    expect(asNull.status).toBe(200);
    expect(await stored()).toEqual(skills);
  });

  it("should store no skills when a new agent registers without any", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([]);
  });

  it("should store the features the client reported, sorted and de-duplicated", async () => {
    const body = { ...REGISTRATION, client_features: ["voice", "attachments", "voice"] };

    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body }));

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).clientFeatures).toEqual(["attachments", "voice"]);
  });

  it("should store no features at all when a client registers without reporting any, which is how an old client is known", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).clientFeatures).toBeNull();
  });

  it("should replace the stored features with what the latest registration reported, nothing included", async () => {
    const withFeatures = { ...REGISTRATION, client_features: ["attachments"] };
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: withFeatures }));
    const stored = async () => (await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).clientFeatures;

    expect(await stored()).toEqual(["attachments"]);

    // A current client that claims nothing is distinguishable from one that reported nothing at all.
    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, client_features: [] } });
    expect(await stored()).toEqual([]);

    // The session is running an older client now, whatever it ran before: the claim does not outlive the build.
    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION });
    expect(await stored()).toBeNull();
  });

  it("should keep a feature name it does not recognise, and drop one that is not a name, when a newer client registers", async () => {
    const body = { ...REGISTRATION, client_features: ["some-later-field", "Not A Name", 7, null] };

    const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body });

    expect(response.status).toBe(200);
    const { agent_id } = await jsonOf(response);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).clientFeatures).toEqual(["some-later-field"]);
  });

  it("should register the session as reporting no features when the features field is not a list", async () => {
    const reported = { ...REGISTRATION, client_features: ["attachments"] };
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: reported }));
    const stored = async () => (await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).clientFeatures;
    expect(await stored()).toEqual(["attachments"]);

    // A hand-rolled client sending the field as `null`, which its neighbour `conversation_id` has always allowed. The
    // field exists to leave a session one field short, so it must not be the thing that keeps a client off the hub.
    const asNull = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, client_features: null } });
    expect(asNull.status).toBe(200);
    expect(await stored()).toBeNull();

    await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: reported });
    expect(await stored()).toEqual(["attachments"]);
    const asText = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, client_features: "attachments" } });
    expect(asText.status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it("should refuse a registration reporting more features than the cap, which is what bounds the column", async () => {
    const body = { ...REGISTRATION, client_features: [...Array(51).keys()].map((index) => `f${index}`) };

    const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body });

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/client_features/);
    expect(await prisma.agent.count()).toBe(0);
  });

  it("should refuse a registration when a skill name is not valid", async () => {
    const response = await call(register, {
      as: ALICE,
      path: "/api/agent/register",
      method: "POST",
      body: { ...REGISTRATION, skills: [{ name: "Not Valid", description: "" }] }
    });

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/skills/);
    expect(await prisma.agent.count()).toBe(0);
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

/**
 * A session on the person's own laptop becomes a conversation in their Assistant: no pod behind it, and the
 * registering agent is the session of it.
 */
describe("a laptop session's conversation", () => {
  const CALLER = { oid: ALICE.oid, tid: "dev", name: ALICE.name, email: ALICE.email };

  async function registered(body: object = REGISTRATION): Promise<{ agent_id: string; name: string }> {
    const response = await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body });
    expect(response.status).toBe(200);
    return await jsonOf(response);
  }

  function session(sessionId: string, name = "a-session") {
    return { sessionId, name, cwd: null, repo: null, branch: null, host: null };
  }

  it("should create a conversation with no pod for the session, named after it, and link the agent to it", async () => {
    const { agent_id } = await registered();

    const conversation = await prisma.assistantConversation.findFirstOrThrow();
    expect(conversation).toMatchObject({
      ownerOid: ALICE.oid,
      virtualAgentId: null,
      agentId: agent_id,
      title: "alice-pcs-api",
      product: "general",
      // A laptop has no supervisor, so neither of the fields a pod's supervisor reports means anything here.
      sessionState: null,
      wakeRequestedAt: null
    });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).assistantConversationId).toBe(conversation.id);
    expect((await listConversations(prisma, ALICE.oid)).map((chat) => [chat.id, chat.title])).toEqual([[conversation.id, "alice-pcs-api"]]);
  });

  /**
   * The registration the relaxed conflict arm exists for. The bridge clears its stored agent id on a 404 from the
   * stream and registers the same session id again, sending no conversation of any kind; refusing that because the
   * hub's own link is on the row would take the session off the hub for good.
   */
  it("should keep the one conversation when the session registers again, and not refuse the registration", async () => {
    const first = await registered();
    const conversation = (await prisma.assistantConversation.findFirstOrThrow()).id;

    const second = await registered({ ...REGISTRATION, branch: "HDPI-1" });

    expect(second.agent_id).toBe(first.agent_id);
    expect(await prisma.assistantConversation.count()).toBe(1);
    expect((await prisma.assistantConversation.findFirstOrThrow()).id).toBe(conversation);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: first.agent_id } })).toMatchObject({
      assistantConversationId: conversation,
      branch: "HDPI-1"
    });
  });

  /**
   * Two registrations for one session id nobody has registered yet: a hand-run `agent-hub enable` and the auto-enable
   * worker. Without the advisory lock each inserts the agent — one of them through the conflict arm — and each then
   * finds no conversation on it and makes one.
   */
  it("should create exactly one conversation when two registrations race for one new session id", async () => {
    const [first, second] = await Promise.all([registered(), registered()]);

    expect(second.agent_id).toBe(first.agent_id);
    expect(await prisma.assistantConversation.count()).toBe(1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: first.agent_id } })).assistantConversationId).toBe(
      (await prisma.assistantConversation.findFirstOrThrow()).id
    );
  });

  /**
   * The conditional link on its own. No registration reaches this, because the advisory lock serialises the two that
   * could; the write is still conditional, since it is the thing that decides which of two conversations an agent
   * keeps rather than leaving it to whoever wrote last.
   */
  it("should keep the conversation the agent is already in and remove the one it just made", async () => {
    const { agent_id } = await registered();
    const theirs = (await prisma.assistantConversation.findFirstOrThrow()).id;

    expect(await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId: agent_id, name: "a second go" })).toBeUndefined();

    expect((await prisma.assistantConversation.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([theirs]);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).assistantConversationId).toBe(theirs);
  });

  it("should leave the chat untitled when the session's name is nothing but spaces, so the sidebar says New chat", async () => {
    const agentId = await insertAgent(ALICE, "spaces");

    expect(await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId, name: "   " })).toMatchObject({ title: null });
  });

  it("should refuse a launch token the session id of a laptop's chat, which is what the guard is for", async () => {
    const { agent_id } = await registered();
    const assistant = await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "gateway" });

    await expect(registerAgent(prisma, { ...CALLER, virtualAgentId: assistant.id }, session(REGISTRATION.session_id))).rejects.toThrow(SessionOwnedElsewhere);

    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ virtualAgentId: null, name: "alice-pcs-api" });
    expect(await prisma.assistantConversation.count()).toBe(1);
  });

  it("should refuse a laptop registration the session id of a pod conversation's agent", async () => {
    await insertUser(ALICE);
    await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "gateway" });
    const chat = await createConversation(prisma, ALICE.oid, { product: "general" });
    const pods = await prisma.agent.findUniqueOrThrow({ where: { id: chat.agentId! }, select: { sessionId: true } });

    const response = await call(register, {
      as: ALICE,
      path: "/api/agent/register",
      method: "POST",
      body: { ...REGISTRATION, session_id: pods.sessionId }
    });

    expect(response.status).toBe(409);
    expect(await prisma.assistantConversation.count()).toBe(1);
    expect((await prisma.assistantConversation.findFirstOrThrow()).virtualAgentId).not.toBeNull();
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

  /**
   * Registration is not where most laptop sessions get their conversation. The client registers only while it holds
   * no agent id and heartbeats ever after, so a session that was already running — and every agent row written before
   * conversations existed — arrives here instead, with nothing else that would ever create one.
   */
  it("should give a laptop session its conversation on a heartbeat when registration did not", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));
    // The state every agent row was in before this existed, and the state a session running across the deploy is in.
    // Detached before the conversation goes, because the column cascades — deleting it first takes the agent too,
    // which is the bug the feature's own delete path exists to avoid.
    await prisma.agent.update({ where: { id: agent_id }, data: { assistantConversationId: null } });
    await prisma.assistantConversation.deleteMany({});

    const response = await call(heartbeat, {
      as: ALICE,
      path: `/api/agent/${agent_id}/heartbeat`,
      method: "POST",
      params: { agentId: agent_id },
      body: { status: "idle", name: "alice-pcs-api" }
    });

    expect(response.status).toBe(204);
    const conversation = await prisma.assistantConversation.findFirstOrThrow();
    expect(conversation).toMatchObject({ ownerOid: ALICE.oid, virtualAgentId: null, agentId: agent_id, title: "alice-pcs-api" });
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ assistantConversationId: conversation.id });
  });

  it("should make only one conversation when a laptop session heartbeats again", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: REGISTRATION }));
    const params = { agentId: agent_id };
    const beat = () => call(heartbeat, { as: ALICE, path: `/api/agent/${agent_id}/heartbeat`, method: "POST", params, body: { status: "idle", name: "a" } });

    await beat();
    await beat();

    expect(await prisma.assistantConversation.count()).toBe(1);
  });

  it("should give a pod's session no conversation of its own on a heartbeat", async () => {
    await insertUser(ALICE);
    const assistant = await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "gateway" });
    const caller = { oid: ALICE.oid, tid: "dev", name: ALICE.name, email: ALICE.email, virtualAgentId: assistant.id };
    const { id } = await registerAgent(prisma, caller, { sessionId: "va-session-hb", name: "va", cwd: null, repo: null, branch: null, host: null });
    const before = await prisma.assistantConversation.count();

    const response = await call(heartbeat, {
      as: ALICE,
      path: `/api/agent/${id}/heartbeat`,
      method: "POST",
      params: { agentId: id },
      body: { status: "idle", name: "pcs-api" }
    });

    expect(response.status).toBe(204);
    expect(await prisma.assistantConversation.count()).toBe(before);
  });

  it("should replace the stored skills when a heartbeat sends them, and leave them when it does not", async () => {
    const { agent_id } = await jsonOf(
      await call(register, { as: ALICE, path: "/api/agent/register", method: "POST", body: { ...REGISTRATION, skills: [{ name: "old", description: "" }] } })
    );
    const beat = (body: object) =>
      call(heartbeat, { as: ALICE, path: `/api/agent/${agent_id}/heartbeat`, method: "POST", params: { agentId: agent_id }, body });

    expect((await beat({ status: "idle" })).status).toBe(204);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([{ name: "old", description: "" }]);

    expect((await beat({ status: "idle", skills: [{ name: "new", description: "Fresh" }] })).status).toBe(204);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).skills).toEqual([{ name: "new", description: "Fresh" }]);
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
