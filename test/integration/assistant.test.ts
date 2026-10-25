import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import * as artefactRoute from "../../src/app/api/agent/[agentId]/artefact/route.ts";
import * as heartbeatRoute from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import * as streamRoute from "../../src/app/api/agent/[agentId]/stream/route.ts";
import * as transcriptRoute from "../../src/app/api/agent/[agentId]/transcript/route.ts";
import * as agentsRoute from "../../src/app/api/agent/agents/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as sessionsRoute from "../../src/app/api/virtual/[virtualAgentId]/sessions/route.ts";
import { createConversation, ensureAssistant, findConversation, linkSession, pendingWakes } from "../../src/assistant/store.ts";
import { directAsPerson } from "../../src/messages/send.ts";
import { expireDeliveries } from "../../src/messages/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import { MAX_VIRTUAL_AGENTS_PER_USER } from "../../src/virtual-agents/limits.ts";
import { type ClaimedVirtualAgent, type ClaimResult, createVirtualAgent, setDesired } from "../../src/virtual-agents/store.ts";
import { sweepVirtualAgents } from "../../src/virtual-agents/sweep.ts";
import { insertUser, type Person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/assistant.ts");
const { agentRoute, assistantConversation, openAssistant } = await import("../../src/web/data.ts");

const ALICE: Person = { oid: "dev-alice", name: "Dev alice (sign-in disabled)", email: "alice@dev.invalid" };
const BOB: Person = { oid: "dev-bob", name: "Dev bob (sign-in disabled)", email: "bob@dev.invalid" };
const VIEWER = { ...ALICE, tid: "dev", modelRoute: "own-licence" as const };

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    signal,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function orchestrator<P>(handler: Handler<P>, path: string, params: P, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "x-dev-orchestrator": "preview-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await handler(request, { params: Promise.resolve(params) });
}

/** The person's assistant, claimed and started by the orchestrator, with its pod's launch token. */
async function startedAssistant(): Promise<{ id: string; token: string; claimed: ClaimedVirtualAgent }> {
  await insertUser(ALICE);
  const assistant = await ensureAssistant(prisma, VIEWER);
  const response = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, { cluster: "preview-01" });
  const claimed = (await jsonOf<ClaimResult>(response)).virtual_agents.find((entry) => entry.id === assistant.id)!;
  await orchestrator(
    observedRoute.POST,
    `/api/orchestrator/virtual-agents/${assistant.id}/observed`,
    { id: assistant.id },
    {
      generation: claimed.generation,
      replicas_ready: 1,
      pod_phase: "Running"
    }
  );
  return { id: assistant.id, token: claimed.launch_token!, claimed };
}

function register(token: string, sessionId: string, conversationId?: string): Promise<Response> {
  return pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", {
    session_id: sessionId,
    name: "session",
    ...(conversationId === undefined ? {} : { conversation_id: conversationId })
  });
}

async function sessionOf(conversationId: string): Promise<{ agentId: string; sessionId: string }> {
  const conversation = await prisma.assistantConversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { agent: { select: { id: true, sessionId: true } } }
  });
  return { agentId: conversation.agent!.id, sessionId: conversation.agent!.sessionId };
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  await resetDatabase();
  actAs("alice");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("the person's assistant", () => {
  it("should create a virtual agent on the first visit of someone who has none, and reuse it on the next", async () => {
    await insertUser(ALICE);
    const first = await openAssistant(VIEWER);
    const second = await openAssistant(VIEWER);

    expect(second.assistant.id).toBe(first.assistant.id);
    expect(await prisma.virtualAgent.findMany({ where: { ownerOid: ALICE.oid }, select: { name: true } })).toEqual([{ name: "assistant" }]);
    expect(first.assistant).toMatchObject({ needed: ["github", "azure", "claude"], onboarded: false, readiness: { percent: 10 } });
  });

  it("should use the person's first virtual agent when they already have several", async () => {
    await insertUser(ALICE);
    const first = await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "bedrock", name: "pcs-api" });
    await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "bedrock", name: "ccd" });

    expect((await ensureAssistant(prisma, VIEWER)).id).toBe(first.id);
    expect(await prisma.virtualAgent.count({ where: { ownerOid: ALICE.oid } })).toBe(2);
  });

  it("should count the virtual agent it creates towards the person's limit", async () => {
    await insertUser(ALICE);
    await ensureAssistant(prisma, VIEWER);
    for (let index = 1; index < MAX_VIRTUAL_AGENTS_PER_USER; index += 1) {
      await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "bedrock", name: `agent-${index}` });
    }

    await expect(createVirtualAgent(prisma, { owner: ALICE, modelRoute: "bedrock", name: "one-too-many" })).rejects.toMatchObject({ status: 409 });
  });

  it("should move to the next virtual agent when the first is being deleted", async () => {
    await insertUser(ALICE);
    const first = await ensureAssistant(prisma, VIEWER);
    const second = await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "bedrock", name: "second" });
    await setDesired(prisma, ALICE.oid, first.id, "deleted");

    expect((await ensureAssistant(prisma, VIEWER)).id).toBe(second.id);
  });

  it("should create one virtual agent when two tabs race to open the Assistant", async () => {
    await insertUser(ALICE);
    const [one, two] = await Promise.all([ensureAssistant(prisma, VIEWER), ensureAssistant(prisma, VIEWER)]);

    expect(one.id).toBe(two.id);
    expect(await prisma.virtualAgent.count({ where: { ownerOid: ALICE.oid } })).toBe(1);
  });

  it("should start a stopped assistant when the person comes back", async () => {
    await insertUser(ALICE);
    const assistant = await ensureAssistant(prisma, VIEWER);
    await setDesired(prisma, ALICE.oid, assistant.id, "stopped");

    expect((await ensureAssistant(prisma, VIEWER)).desired).toBe("running");
  });
});

describe("conversations", () => {
  it("should start a conversation with its first message queued for an agent that waits for a session", async () => {
    await startedAssistant();
    const started = await actions.startConversation({ product: "ccd", body: "Help me write a user story about listing" });
    expect(started).toMatchObject({ ok: true });
    const id = (started as { id: string }).id;

    const conversation = (await findConversation(prisma, ALICE.oid, id))!;
    expect(conversation).toMatchObject({ product: "ccd", title: "Help me write a user story about listing" });
    expect(conversation.wakeRequestedAt).not.toBeNull();
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: conversation.agentId! } });
    expect(agent).toMatchObject({ status: "offline", assistantConversationId: id, virtualAgentId: conversation.virtualAgentId, name: "assistant" });
    expect(await prisma.delivery.count({ where: { agentId: agent.id, state: "queued" } })).toBe(1);
  });

  it("should refuse a product it does not offer when starting a conversation", async () => {
    await startedAssistant();

    expect(await actions.startConversation({ product: "nonsense", body: "hi" })).toEqual({ ok: false, error: "pick a product from the list" });
  });

  it("should adopt the conversation's agent and clear its wake when the pod's session registers for it", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hello" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);

    const response = await register(token, sessionId, id);

    expect(response.status).toBe(200);
    expect((await jsonOf(response)).agent_id).toBe(agentId);
    expect(await findConversation(prisma, ALICE.oid, id)).toMatchObject({ agentId, wakeRequestedAt: null, sessionState: "live" });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistantId } })).agentId).toBeNull();
    expect(await pendingWakes(prisma, assistantId)).toEqual([]);
  });

  it("should move the conversation to the new session's agent when a /clear registers a new session id", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hello" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);

    const cleared = await jsonOf(await register(token, "after-clear", id));

    expect(cleared.agent_id).not.toBe(agentId);
    expect((await findConversation(prisma, ALICE.oid, id))!.agentId).toBe(cleared.agent_id);
  });

  it("should refuse a registration naming another assistant's conversation", async () => {
    const { token } = await startedAssistant();
    await insertUser(BOB);
    const bobs = await ensureAssistant(prisma, { oid: BOB.oid, modelRoute: "bedrock" });
    const conversation = await createConversation(prisma, BOB.oid, { product: "general" });

    expect(bobs.id).not.toBe(conversation.id);
    expect((await register(token, "stray", conversation.id)).status).toBe(409);
    expect((await register(token, "stray", "not-a-uuid")).status).toBe(409);
  });

  it("should replay the queued message to the session once its stream connects", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "nfdiv", body: "What is a conditional order?" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);

    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();

    const data = JSON.parse(direct!.data!);
    expect(data).toMatchObject({
      from_owner: true,
      message: { body: "What is a conditional order?" },
      assistant: { conversation_id: id, product: "nfdiv", product_label: "No Fault Divorce (NFDIV)", artefact_version: 0, artefact_updated_by: null }
    });
  });

  it("should not expire a new message to a conversation whose agent has been offline for days", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "old" })) as { id: string }).id;
    const { agentId } = await sessionOf(id);
    await prisma.agent.update({ where: { id: agentId }, data: { lastHeartbeatAt: new Date(Date.now() - 3 * 86_400_000) } });

    await prisma.$transaction(async (tx) => {
      await expireDeliveries(tx, 86_400, 100);
    });

    expect(await prisma.delivery.count({ where: { agentId, state: "queued" } })).toBe(1);

    await prisma.delivery.updateMany({ where: { agentId }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await prisma.$transaction(async (tx) => {
      await expireDeliveries(tx, 86_400, 100);
    });
    expect(await prisma.delivery.count({ where: { agentId, state: "expired" } })).toBe(1);
  });

  it("should keep a conversation's agent from the person's grantees and the messageable list", async () => {
    await startedAssistant();
    await insertUser(BOB);
    await setGrant(prisma, ALICE.oid, BOB.oid, "write");
    const id = ((await actions.startConversation({ product: "general", body: "private" })) as { id: string }).id;
    const { agentId } = await sessionOf(id);

    await expect(directAsPerson(prisma, BOB.oid, agentId, "peek")).rejects.toMatchObject({ status: 404 });
    const listed = await call(agentsRoute.GET, { as: ALICE, path: "/api/agent/agents", params: {} });
    expect((await jsonOf(listed)).agents.map((agent: { id: string }) => agent.id)).not.toContain(agentId);
  });

  it("should send the hub's agent page for a conversation's agent to the conversation", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId } = await sessionOf(id);

    expect(await agentRoute(VIEWER, agentId)).toEqual({ variant: "moved", to: `/assistant/${id}` });
  });

  it("should show only the owner their conversation, and nobody else", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "probate", body: "hi" })) as { id: string }).id;

    expect(await assistantConversation(VIEWER, id)).toMatchObject({ id, productLabel: "Probate", agentStatus: "offline" });
    expect(await assistantConversation({ ...BOB, tid: "dev", modelRoute: "bedrock" }, id)).toBeUndefined();
    actAs("bob");
    expect(await actions.sendAssistantMessage({ conversationId: id, body: "hi" })).toEqual({ ok: false, error: "that conversation no longer exists" });
  });

  it("should record each change of product, and leave it alone when it is the same", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;

    expect(await actions.setConversationProduct({ conversationId: id, product: "ccd" })).toEqual({ ok: true });
    await actions.setConversationProduct({ conversationId: id, product: "ccd" });

    const conversation = (await findConversation(prisma, ALICE.oid, id))!;
    expect(conversation.product).toBe("ccd");
    expect(conversation.productHistory.map((change) => change.product)).toEqual(["ccd"]);
  });

  it("should rename and delete a conversation with everything it holds", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId } = await sessionOf(id);

    expect(await actions.renameConversation({ conversationId: id, title: "  Listing   notes " })).toEqual({ ok: true });
    expect((await findConversation(prisma, ALICE.oid, id))!.title).toBe("Listing notes");
    expect(await actions.deleteConversation({ conversationId: id })).toEqual({ ok: true });

    expect(await prisma.assistantConversation.count()).toBe(0);
    expect(await prisma.agent.count({ where: { id: agentId } })).toBe(0);
    expect(await prisma.message.count({ where: { kind: "direct" } })).toBe(0);
  });

  it("should wake a conversation when its composer is focused and the session is offline", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await prisma.agent.updateMany({ where: { sessionId }, data: { status: "offline" } });

    expect(await actions.warmConversation({ conversationId: id })).toEqual({ ok: true });

    expect((await pendingWakes(prisma, assistantId)).map((wake) => wake.conversation_id)).toEqual([id]);
  });
});

describe("the sessions stream and report", () => {
  it("should replay pending wakes, then send a close when a conversation is deleted", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "pcs", body: "hi" })) as { id: string }).id;
    const { sessionId } = await sessionOf(id);

    const abort = new AbortController();
    const stream = frames(
      await pod(sessionsRoute.GET, token, `/api/virtual/${assistantId}/sessions`, { virtualAgentId: assistantId }, "GET", undefined, abort.signal)
    );
    const [wake] = await stream.named("wake", 1);
    expect(JSON.parse(wake!.data!)).toEqual({ conversation_id: id, session_id: sessionId, resume: false, product: "pcs" });

    await actions.deleteConversation({ conversationId: id });
    const [close] = await stream.named("close", 1);
    abort.abort();
    await stream.cancel();

    expect(JSON.parse(close!.data!)).toEqual({ conversation_id: id });
  });

  it("should ask the pod to resume a session that has sent its transcript", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await pod(transcriptRoute.POST, token, `/api/agent/${agentId}/transcript`, { agentId }, "POST", {
      session_id: sessionId,
      entries: [{ key: "e1", role: "assistant", content: { text: "Hello" }, occurred_at: new Date().toISOString() }]
    });
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "idle" });
    await prisma.agent.update({ where: { id: agentId }, data: { status: "offline" } });

    await actions.sendAssistantMessage({ conversationId: id, body: "again" });

    expect(await pendingWakes(prisma, assistantId)).toEqual([{ conversation_id: id, session_id: sessionId, resume: true, product: "general" }]);
  });

  it("should store what the supervisor reports, and clear a conversation it leaves out", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const first = ((await actions.startConversation({ product: "general", body: "one" })) as { id: string }).id;
    const second = ((await actions.startConversation({ product: "general", body: "two" })) as { id: string }).id;
    const put = (body: unknown) => pod(sessionsRoute.PUT, token, `/api/virtual/${assistantId}/sessions`, { virtualAgentId: assistantId }, "PUT", body);

    expect(
      (
        await put({
          sessions: [
            { conversation_id: first, state: "live" },
            { conversation_id: second, state: "queued", detail: "2 of 2 busy" }
          ],
          max: 2
        })
      ).status
    ).toBe(204);
    expect(await findConversation(prisma, ALICE.oid, second)).toMatchObject({ sessionState: "queued", sessionDetail: "2 of 2 busy" });

    await put({
      sessions: [
        { conversation_id: second, state: "live" },
        { conversation_id: "unknown", state: "live" }
      ],
      max: 2
    });
    expect(await findConversation(prisma, ALICE.oid, first)).toMatchObject({ sessionState: null });
    expect((await put({ sessions: [], max: 0 })).status).toBe(400);
  });

  it("should refuse the sessions routes to another virtual agent's launch token", async () => {
    const { token } = await startedAssistant();
    await insertUser(BOB);
    const bobs = await createVirtualAgent(prisma, { owner: BOB, modelRoute: "bedrock", name: "bobs" });

    expect((await pod(sessionsRoute.PUT, token, `/api/virtual/${bobs.id}/sessions`, { virtualAgentId: bobs.id }, "PUT", { sessions: [], max: 1 })).status).toBe(
      403
    );
  });
});

describe("artefacts", () => {
  it("should let the session write the document against its version and refuse a stale one", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "draft it" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    const route = (method: string, body?: unknown) =>
      pod(method === "GET" ? artefactRoute.GET : artefactRoute.PUT, token, `/api/agent/${agentId}/artefact`, { agentId }, method, body);

    expect(await jsonOf(await route("GET"))).toEqual({ title: null, markdown: "", version: 0, updated_by: null, updated_at: null });
    expect(await jsonOf(await route("PUT", { title: "User story", markdown: "# As a clerk", base_version: 0 }))).toEqual({ version: 1 });

    const stale = await route("PUT", { markdown: "# Mine", base_version: 0 });
    expect(stale.status).toBe(409);
    expect((await jsonOf(stale)).current).toMatchObject({ title: "User story", markdown: "# As a clerk", version: 1, updated_by: "agent" });
  });

  it("should save the person's edit, and hand back the assistant's newer version when theirs is stale", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "draft it" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);

    expect(await actions.saveArtefact({ conversationId: id, title: "Plan", markdown: "one\r\ntwo", baseVersion: 0 })).toEqual({
      ok: true,
      saved: true,
      version: 1
    });
    await pod(artefactRoute.PUT, token, `/api/agent/${agentId}/artefact`, { agentId }, "PUT", { markdown: "agent", base_version: 1 });

    expect(await actions.saveArtefact({ conversationId: id, title: "Plan", markdown: "mine", baseVersion: 1 })).toEqual({
      ok: true,
      saved: false,
      current: { title: "Plan", markdown: "agent", version: 2, updatedBy: "agent" }
    });
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id } })).artefactMarkdown).toBe("agent");
  });

  it("should answer 404 for the document of an agent that is not a conversation's", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const registered = await jsonOf(await register(token, "not-a-conversation"));

    expect(assistantId).toBeDefined();
    expect((await pod(artefactRoute.GET, token, `/api/agent/${registered.agent_id}/artefact`, { agentId: registered.agent_id })).status).toBe(404);
  });
});

describe("the idle sweep", () => {
  const MORNING = new Date("2026-10-21T07:00:00.000Z");

  it("should keep an assistant running while any of its sessions is busy", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "busy" });
    await prisma.virtualAgent.update({
      where: { id: assistantId },
      data: { status: "running", startedAt: MORNING, statusChangedAt: MORNING, lastActiveAt: MORNING }
    });
    // Three hours after a weekday morning start, well before the evening stop.
    const options = { now: new Date("2026-10-21T10:00:00.000Z"), idleMinutes: 120, eveningStop: { hour: 19, minute: 0 } };

    expect((await sweepVirtualAgents(prisma, options))?.idle).toEqual([]);

    await prisma.agent.update({ where: { id: agentId }, data: { status: "idle" } });
    await prisma.transcriptEntry.deleteMany();
    expect((await sweepVirtualAgents(prisma, options))?.idle).toEqual([assistantId]);
  });

  it("should refuse to link a session when called for a conversation that is not there", async () => {
    await expect(
      prisma.$transaction(async (tx) =>
        linkSession(tx, { conversationId: "00000000-0000-0000-0000-000000000000", virtualAgentId: "x", ownerOid: "o", agentId: "a" })
      )
    ).rejects.toBeDefined();
  });
});
