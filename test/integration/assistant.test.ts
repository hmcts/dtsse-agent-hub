import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import * as artefactRoute from "../../src/app/api/agent/[agentId]/artefact/route.ts";
import * as heartbeatRoute from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import * as jiraRoute from "../../src/app/api/agent/[agentId]/jira/route.ts";
import * as streamRoute from "../../src/app/api/agent/[agentId]/stream/route.ts";
import * as transcriptRoute from "../../src/app/api/agent/[agentId]/transcript/route.ts";
import * as agentsRoute from "../../src/app/api/agent/agents/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as uiTranscriptRoute from "../../src/app/api/ui/agents/[id]/transcript/route.ts";
import * as sessionsRoute from "../../src/app/api/virtual/[virtualAgentId]/sessions/route.ts";
import { JIRA_EXPORT_TIMEOUT_MS } from "../../src/assistant/jira.ts";
import { assistantFrame, createConversation, ensureAssistant, findConversation, linkSession, pendingWakes } from "../../src/assistant/store.ts";
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

function register(
  token: string,
  sessionId: string,
  conversationId?: string,
  reported: { skills?: { name: string; description: string }[]; clientFeatures?: string[] } = {}
): Promise<Response> {
  return pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", {
    session_id: sessionId,
    name: "session",
    ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
    ...(reported.skills === undefined ? {} : { skills: reported.skills }),
    // Left out unless a test is a newer client: a pod runs whatever client version its image booted with.
    ...(reported.clientFeatures === undefined ? {} : { client_features: reported.clientFeatures })
  });
}

/** The browser's own read of a session's transcript, as the person named by `persona`. */
function uiTranscript(persona: string, agentId: string): Promise<Response> {
  const request = new NextRequest(`http://localhost:3000/api/ui/agents/${agentId}/transcript`, { headers: { cookie: `ah_dev_persona=${persona}` } });
  return uiTranscriptRoute.GET(request, { params: Promise.resolve({ id: agentId }) });
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

  it("should offer the plugins the hub is configured with, and the ones the assistant loads", async () => {
    await insertUser(ALICE);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "pcs=PCS team workflows,dtsse");

    expect((await openAssistant(VIEWER)).plugins).toEqual({
      available: [
        { name: "pcs", description: "PCS team workflows" },
        { name: "dtsse", description: "" }
      ],
      checked: []
    });
  });

  it("should offer an empty list of plugins when the hub is configured with none", async () => {
    await insertUser(ALICE);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "");

    expect((await openAssistant(VIEWER)).plugins).toEqual({ available: [], checked: [] });
  });

  // A malformed configuration hides the plugins section and leaves the rest of the Assistant working, because it is
  // someone's whole chat surface and they can neither see the configuration nor fix it. Both halves of that are load
  // bearing: the section hides because `pluginOffer` catches, and the first visit gets that far at all because
  // `createVirtualAgent` reads the offer list only when plugins are ticked. The hub's own plugin surfaces read the
  // same catch and name the fault in place of their plugin form, which is where it is actionable.
  it("should create the assistant and hide the plugins section on a first visit when the configuration is malformed", async () => {
    await insertUser(ALICE);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    const home = await openAssistant(VIEWER);

    expect(home.plugins).toBeNull();
    expect(await prisma.virtualAgent.findMany({ where: { ownerOid: ALICE.oid }, select: { name: true, plugins: true } })).toEqual([
      { name: "assistant", plugins: [] }
    ]);
  });

  it("should hide the plugins section on a return visit when the configuration is malformed", async () => {
    await insertUser(ALICE);
    const existing = await ensureAssistant(prisma, VIEWER);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    const home = await openAssistant(VIEWER);

    expect(home.plugins).toBeNull();
    expect(home.assistant.id).toBe(existing.id);
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

  // `ensureAssistant` leaves an existing row's `model_route` alone, and the pod boots on it, so an `AIGateway.User`
  // app role granted after the row was made puts the viewer on a different route from their own assistant. What
  // `/assistant` asks for must then be storable: it asks for the row's credentials, and the only Claude token the
  // hub will ever hand that pod is the one this page can take.
  it.each([
    ["bedrock", "own-licence", ["github", "azure", "claude"], true],
    ["own-licence", "bedrock", ["github", "azure", "bedrock"], true],
    ["own-licence", "own-licence", ["github", "azure", "claude"], true],
    ["bedrock", "bedrock", ["github", "azure", "bedrock"], false]
  ] as const)("should ask for the assistant's own credentials and allow every one of them when the viewer is on %s and the row on %s", async (viewerRoute, rowRoute, needed, claudeTokenUsable) => {
    await insertUser(ALICE);
    await createVirtualAgent(prisma, { owner: ALICE, modelRoute: rowRoute, name: "assistant" });

    const home = await openAssistant({ ...ALICE, tid: "dev", modelRoute: viewerRoute });

    expect(home.assistant.needed).toEqual(needed);
    expect(home.credentials).toMatchObject({ modelRoute: viewerRoute, claudeTokenUsable });
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

  /**
   * The activity line, including how many subagents the answer is waiting on, is derived in the browser from these
   * entries. Nothing says so on the wire, so what keeps it from a non-owner is the transcript read itself.
   */
  it("should send a session's tool calls to the owner and to nobody else, so only they see what it is doing", async () => {
    const { token } = await startedAssistant();
    await insertUser(BOB);
    await setGrant(prisma, ALICE.oid, BOB.oid, "write");
    const id = ((await actions.startConversation({ product: "general", body: "look into this" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await pod(transcriptRoute.POST, token, `/api/agent/${agentId}/transcript`, { agentId }, "POST", {
      session_id: sessionId,
      entries: [{ key: "e1", role: "tool_use", content: { id: "t1", name: "Agent", input: { description: "dig" } }, occurred_at: new Date().toISOString() }]
    });

    const owner = await uiTranscript("alice", agentId);
    expect(owner.status).toBe(200);
    expect((await jsonOf(owner)).entries).toMatchObject([{ role: "tool_use", content: { id: "t1", name: "Agent" } }]);

    expect((await uiTranscript("bob", agentId)).status).toBe(404);
    expect(await assistantConversation({ ...BOB, tid: "dev", modelRoute: "bedrock" }, id)).toBeUndefined();
  });

  it("should carry the session's skills to the conversation page, and none before a session registers", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { sessionId } = await sessionOf(id);

    expect((await assistantConversation(VIEWER, id))?.skills).toEqual([]);
    await register(token, sessionId, id, {
      skills: [
        { name: "cft-how-to", description: "Find a how-to recipe" },
        { name: "cft-explain", description: "Answer a what is X question" }
      ]
    });

    expect((await assistantConversation(VIEWER, id))?.skills).toEqual([
      { name: "cft-explain", description: "Answer a what is X question" },
      { name: "cft-how-to", description: "Find a how-to recipe" }
    ]);
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

  it("should store and record the pick when the product picked is the default a retired slug reads as", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "ccd", body: "hi" })) as { id: string }).id;
    await prisma.$executeRaw`UPDATE assistant_conversation SET product = 'other' WHERE id = ${id}::uuid`;

    expect(await actions.setConversationProduct({ conversationId: id, product: "general" })).toEqual({ ok: true });

    const [row] = await prisma.$queryRaw<{ product: string }[]>`SELECT product FROM assistant_conversation WHERE id = ${id}::uuid`;
    expect(row!.product).toBe("general");
    expect((await findConversation(prisma, ALICE.oid, id))!.productHistory.map((change) => change.product)).toEqual(["general"]);
  });

  it("should read as the default on every page when a conversation is on a product no longer offered", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "ccd", body: "hi" })) as { id: string }).id;
    // What a replica still on the previous bundle writes during a rolling deploy, and what a retirement leaves.
    await prisma.$executeRaw`UPDATE assistant_conversation SET product = 'other' WHERE id = ${id}::uuid`;

    const view = (await assistantConversation(VIEWER, id))!;

    expect(view).toMatchObject({ product: "general", productLabel: "General" });
    expect((await findConversation(prisma, ALICE.oid, id))!.product).toBe("general");
    expect((await openAssistant(VIEWER)).conversations.flatMap((group) => group.items)).toMatchObject([{ id, product: "general", productLabel: "General" }]);
  });

  it("should tell the session the stored product when a conversation is on one no longer offered", async () => {
    const { id: assistantId } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "ccd", body: "hi" })) as { id: string }).id;
    await prisma.$executeRaw`UPDATE assistant_conversation SET product = 'other' WHERE id = ${id}::uuid`;

    const { agentId } = await sessionOf(id);

    // The session keeps the subject it was started in; its label is the slug, since the list has no name for it.
    expect(await assistantFrame(prisma, agentId)).toMatchObject({ product: "other", product_label: "other" });
    expect((await pendingWakes(prisma, assistantId)).map((wake) => wake.product)).toEqual(["other"]);
  });

  it("should carry attachments on a frame built for a delivery and leave them out of one built for a wake", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { sessionId } = await sessionOf(id);
    // A client from before client features existed: it reports none, so it claims none. No frame field is gated on
    // the claim yet, so what decides `attachments` is the message, not the session — see `AssistantFrame`.
    await register(token, sessionId, id);
    const { agentId } = await sessionOf(id);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).clientFeatures).toBeNull();

    const { id: messageId } = await prisma.message.findFirstOrThrow({ where: { kind: "direct" }, select: { id: true } });
    const frame = { conversation_id: id, product: "general", product_label: "General", artefact_version: 0, artefact_updated_by: null };

    // A wake is "this conversation needs a session", so there is no message whose files the field could name.
    expect(await assistantFrame(prisma, agentId)).toEqual(frame);
    expect(await assistantFrame(prisma, agentId, messageId)).toEqual({ ...frame, attachments: [] });
  });

  it("should offer the conversation what its session's client claimed, so the composer can act on it", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { sessionId } = await sessionOf(id);

    // Before any session has registered, and after an old client's, the conversation claims nothing.
    expect((await assistantConversation(VIEWER, id))!.clientFeatures).toBeNull();
    await register(token, sessionId, id);
    expect((await assistantConversation(VIEWER, id))!.clientFeatures).toBeNull();

    // The pod is restarted on a newer client, which re-registers the same session.
    await register(token, sessionId, id, { clientFeatures: ["attachments"] });

    expect((await assistantConversation(VIEWER, id))!.clientFeatures).toEqual(["attachments"]);
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

  it("should answer the wake when the supervisor reports a session live, and keep it while one is still starting", async () => {
    // A conversation resumed on a new pod never registers again, so the report is the only thing that can answer its
    // wake. Left pending, it is replayed on every stream the pod opens and keeps taking a newer conversation's slot.
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const put = (body: unknown) => pod(sessionsRoute.PUT, token, `/api/virtual/${assistantId}/sessions`, { virtualAgentId: assistantId }, "PUT", body);

    await put({ sessions: [{ conversation_id: id, state: "starting", detail: "resuming the conversation" }], max: 5 });
    expect((await pendingWakes(prisma, assistantId)).map((wake) => wake.conversation_id)).toEqual([id]);

    await put({ sessions: [{ conversation_id: id, state: "live" }], max: 5 });

    expect(await pendingWakes(prisma, assistantId)).toEqual([]);
  });

  it("should send the pod an interrupt, and record the stop, when the person stops the answer", async () => {
    const { id: assistantId, token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id, { clientFeatures: ["stop"] });
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "busy" });

    const abort = new AbortController();
    const stream = frames(
      await pod(sessionsRoute.GET, token, `/api/virtual/${assistantId}/sessions`, { virtualAgentId: assistantId }, "GET", undefined, abort.signal)
    );

    const result = await actions.stopAssistantAnswer({ conversationId: id });
    const [interrupt] = await stream.named("interrupt", 1);
    abort.abort();
    await stream.cancel();

    expect(result).toEqual({ ok: true, stopped: true });
    expect(JSON.parse(interrupt!.data!)).toEqual({ conversation_id: id });
    expect((await assistantConversation(VIEWER, id))?.stopHistory).toHaveLength(1);
  });

  it("should do nothing when there is no answer running to stop", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id, { clientFeatures: ["stop"] });
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "idle" });

    // Pressing stop as the answer lands is a race nobody can be expected to win, so it is not a refusal — but
    // `stopped: false` is what keeps the caller from saying it stopped, and nothing goes in the thread either.
    expect(await actions.stopAssistantAnswer({ conversationId: id })).toEqual({ ok: true, stopped: false });
    expect((await assistantConversation(VIEWER, id))?.stopHistory).toEqual([]);
  });

  it("should refuse to stop, and record nothing, when the session's client cannot act on an interrupt", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "busy" });

    expect(await actions.stopAssistantAnswer({ conversationId: id })).toMatchObject({ ok: false });
    expect((await assistantConversation(VIEWER, id))?.stopHistory).toEqual([]);
  });

  it("should not let anyone but the owner stop a conversation's answer", async () => {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id, { clientFeatures: ["stop"] });
    await pod(heartbeatRoute.POST, token, `/api/agent/${agentId}/heartbeat`, { agentId }, "POST", { status: "busy" });
    await insertUser(BOB);
    // A write grant is the most anyone else can hold, and it lets them message any other agent of Alice's. The
    // refusal comes from the owner-scoped read rather than from `canStopAssistantAnswer`, which the action names
    // after it and `rules.test.ts` covers; this is the end of it that the person would meet.
    await setGrant(prisma, ALICE.oid, BOB.oid, "write");
    actAs("bob");

    expect(await actions.stopAssistantAnswer({ conversationId: id })).toMatchObject({ ok: false });
    actAs("alice");
    expect((await assistantConversation(VIEWER, id))?.stopHistory).toEqual([]);
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

describe("jira export", () => {
  async function written(): Promise<{ token: string; id: string; agentId: string }> {
    const { token } = await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "write a story" })) as { id: string }).id;
    const { agentId, sessionId } = await sessionOf(id);
    await register(token, sessionId, id);
    await actions.saveArtefact({ conversationId: id, title: "Flags for caseworkers", markdown: "# Problem\n\nFlags are hidden.", baseVersion: 0 });
    return { token, id, agentId };
  }

  function report(token: string, agentId: string, body: unknown): Promise<Response> {
    return pod(jiraRoute.PUT, token, `/api/agent/${agentId}/jira`, { agentId }, "PUT", body);
  }

  async function currentExport(id: string): Promise<string> {
    return (await prisma.assistantConversation.findUniqueOrThrow({ where: { id }, select: { jiraExportId: true } })).jiraExportId!;
  }

  it("should ask the session in the chat, with the export in the message's frame, and show the ticket once it reports the key", async () => {
    const { token, id, agentId } = await written();

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({ ok: true });
    const exportId = await currentExport(id);
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const sent = await stream.named("direct", 2);
    abort.abort();
    await stream.cancel();
    const request = JSON.parse(sent[1]!.data!);

    expect(request).toMatchObject({
      message: { body: "Please export this document to the VIBE backlog in Jira." },
      assistant: { conversation_id: id, jira_export: { export_id: exportId, project: "VIBE", issue_type: "Story", labels: ["hmcts-assistant"] } }
    });
    expect((await assistantConversation(VIEWER, id))?.jira).toMatchObject({ status: "pending", project: "VIBE", requestedAt: expect.any(String) });

    expect((await report(token, agentId, { export_id: exportId, key: "VIBE-701" })).status).toBe(204);
    expect((await assistantConversation(VIEWER, id))?.jira).toEqual({
      status: "done",
      project: "VIBE",
      key: "VIBE-701",
      url: "https://hmcts.atlassian.net/browse/VIBE-701"
    });
  });

  it("should leave the export out of the frame once it is reported or has timed out", async () => {
    const { token, id, agentId } = await written();
    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });
    expect((await assistantFrame(prisma, agentId))?.jira_export?.export_id).toBe(await currentExport(id));

    await prisma.assistantConversation.update({ where: { id }, data: { jiraRequestedAt: new Date(Date.now() - JIRA_EXPORT_TIMEOUT_MS - 1000) } });
    expect((await assistantFrame(prisma, agentId))?.jira_export).toBeUndefined();

    await prisma.assistantConversation.update({ where: { id }, data: { jiraRequestedAt: new Date() } });
    await report(token, agentId, { export_id: await currentExport(id), key: "VIBE-702" });
    expect((await assistantFrame(prisma, agentId))?.jira_export).toBeUndefined();
  });

  it("should refuse a second export while one is pending, and any once the document is in Jira", async () => {
    const { token, id, agentId } = await written();
    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({
      ok: false,
      error: "this document is already being exported"
    });

    await report(token, agentId, { export_id: await currentExport(id), key: "VIBE-701" });

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({
      ok: false,
      error: "this document is already in Jira as VIBE-701"
    });
  });

  it("should let the person try again under a new export id, and ignore the old one's late report, when the export failed", async () => {
    const { token, id, agentId } = await written();
    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });
    const first = await currentExport(id);
    await report(token, agentId, { export_id: first, error: "Story is not an issue type of VIBE" });
    expect((await assistantConversation(VIEWER, id))?.jira).toEqual({ status: "failed", project: "VIBE", error: "Story is not an issue type of VIBE" });

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({ ok: true });
    expect(await currentExport(id)).not.toBe(first);

    expect((await report(token, agentId, { export_id: first, key: "VIBE-1" })).status).toBe(204);
    expect((await assistantConversation(VIEWER, id))?.jira).toMatchObject({ status: "pending", project: "VIBE", requestedAt: expect.any(String) });
  });

  it("should allow a new export once the session has not answered in time", async () => {
    const { id } = await written();
    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });
    await prisma.assistantConversation.update({ where: { id }, data: { jiraRequestedAt: new Date(Date.now() - JIRA_EXPORT_TIMEOUT_MS - 1000) } });

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({ ok: true });
  });

  it("should refuse an export of a document nobody has written, or to a board not on offer", async () => {
    await startedAssistant();
    const id = ((await actions.startConversation({ product: "general", body: "hi" })) as { id: string }).id;

    expect(await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" })).toEqual({ ok: false, error: "write the document before exporting it" });
    expect(await actions.exportArtefactToJira({ conversationId: id, project: "CCD" })).toEqual({ ok: false, error: "pick a Jira board from the list" });
  });

  it("should start a stopped assistant when the person exports", async () => {
    const { id } = await written();
    const assistantId = (await findConversation(prisma, ALICE.oid, id))!.virtualAgentId;
    await prisma.agent.updateMany({ where: { assistantConversationId: id }, data: { status: "offline" } });
    await setDesired(prisma, ALICE.oid, assistantId, "stopped");

    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });

    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistantId }, select: { desired: true } })).desired).toBe("running");
  });

  it("should refuse a report from an agent that is not a conversation's, and one that breaks the contract", async () => {
    const { token, id, agentId } = await written();
    await actions.exportArtefactToJira({ conversationId: id, project: "VIBE" });
    const exportId = await currentExport(id);
    const { agent_id: plain } = await jsonOf<{ agent_id: string }>(await register(token, "plain-session"));

    expect((await report(token, plain, { export_id: exportId, key: "VIBE-1" })).status).toBe(404);
    expect((await report(token, agentId, { export_id: exportId, key: "not a key" })).status).toBe(400);
  });
});
