import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as questionRoute from "../../src/app/api/agent/[agentId]/question/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import { createConversation, ensureAssistant } from "../../src/assistant/store.ts";
import { realtime } from "../../src/realtime/process.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const { answerAgentQuestion } = await import("../../src/app/_actions/questions.ts");
const { assistantConversation } = await import("../../src/web/data.ts");

const ALICE: Person = person("alice");
const BOB: Person = person("bob");
const VIEWER = { ...ALICE, tid: "dev", modelRoute: "own-licence" as const };

/**
 * The question Claude Code v2.1.304 sends a `PreToolUse` hook for `AskUserQuestion`, as the client forwards it.
 */
const QUESTION = {
  session_id: "sid-question",
  tool_use_id: "toolu_bdrk_01TNH",
  questions: [
    {
      question: "Do you prefer red or blue?",
      header: "Colour",
      options: [
        { label: "Red", description: "You prefer red." },
        { label: "Blue", description: "You prefer blue." }
      ],
      multiSelect: false
    }
  ]
};

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, method = "GET", body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
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

/** Alice's assistant, claimed and started by the orchestrator, with the launch token its pod sends. */
async function startedAssistant(): Promise<{ id: string; token: string }> {
  await insertUser(ALICE);
  const assistant = await ensureAssistant(prisma, VIEWER);
  const claim = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, { cluster: "preview-01" });
  const claimed = (await jsonOf<{ virtual_agents: { id: string; generation: number; launch_token: string | null }[] }>(claim)).virtual_agents.find(
    (entry) => entry.id === assistant.id
  )!;
  await orchestrator(
    observedRoute.POST,
    `/api/orchestrator/virtual-agents/${assistant.id}/observed`,
    { id: assistant.id },
    { generation: claimed.generation, replicas_ready: 1, pod_phase: "Running" }
  );
  return { id: assistant.id, token: claimed.launch_token! };
}

/** One of Alice's conversations with a registered session, which is the agent a question is asked against. */
async function conversationSession(): Promise<{ conversationId: string; agentId: string; token: string }> {
  const assistant = await startedAssistant();
  const conversation = await createConversation(prisma, ALICE.oid, { product: "general" });
  await pod(registerRoute.POST, assistant.token, "/api/agent/register", {}, "POST", {
    session_id: `session-${conversation.id}`,
    name: "session",
    conversation_id: conversation.id,
    client_features: []
  });
  const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { agentId: true } });
  return { conversationId: conversation.id, agentId: row.agentId!, token: assistant.token };
}

function ask(token: string, agentId: string, body: unknown = QUESTION): Promise<Response> {
  return pod(questionRoute.POST, token, `/api/agent/${agentId}/question`, { agentId }, "POST", body);
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

describe("POST /api/agent/{agent_id}/question", () => {
  it("should record the question for the owner to answer when a session's hook intercepted one", async () => {
    const { agentId, token } = await conversationSession();

    const response = await ask(token, agentId);

    expect(response.status).toBe(204);
    expect(await prisma.agentQuestion.findMany({ where: { agentId }, select: { toolUseId: true, questions: true, answeredAt: true } })).toEqual([
      { toolUseId: QUESTION.tool_use_id, questions: QUESTION.questions, answeredAt: null }
    ]);
  });

  // The client denies the tool whether or not this call answered, so a retry after a lost response is routine.
  it("should leave one question on screen when the same tool use is posted again", async () => {
    const { agentId, token } = await conversationSession();

    expect((await ask(token, agentId)).status).toBe(204);
    expect((await ask(token, agentId)).status).toBe(204);

    expect(await prisma.agentQuestion.count({ where: { agentId } })).toBe(1);
  });

  it("should keep the question the session is waiting on when a retry carries different words", async () => {
    const { agentId, token } = await conversationSession();
    await ask(token, agentId);

    await ask(token, agentId, { ...QUESTION, questions: [{ ...QUESTION.questions[0], question: "Changed my mind?" }] });

    const [stored] = await prisma.agentQuestion.findMany({ where: { agentId }, select: { questions: true } });
    expect(stored?.questions).toEqual(QUESTION.questions);
  });

  it.each([
    ["no questions at all", { ...QUESTION, questions: [] }],
    ["more questions than the tool allows", { ...QUESTION, questions: Array.from({ length: 5 }, () => QUESTION.questions[0]) }],
    ["a question offering one option", { ...QUESTION, questions: [{ ...QUESTION.questions[0], options: [{ label: "Red", description: "" }] }] }],
    ["no tool use id", { ...QUESTION, tool_use_id: "" }]
  ])("should refuse a body with %s", async (_label, body) => {
    const { agentId, token } = await conversationSession();

    const response = await ask(token, agentId, body);

    expect(response.status).toBe(400);
    expect(await prisma.agentQuestion.count()).toBe(0);
  });

  it("should refuse a launch token acting for an agent its own virtual agent did not register", async () => {
    const { token } = await conversationSession();
    const other = await insertAgent(ALICE, "laptop");

    const response = await ask(token, other);

    expect(response.status).toBe(403);
  });

  it("should answer 404 for an agent that does not exist, which the client re-registers on", async () => {
    const { token } = await conversationSession();

    expect((await ask(token, "11111111-1111-1111-1111-111111111111")).status).toBe(404);
  });
});

describe("the question in the conversation's view", () => {
  it("should hand the chat the question with its options, unanswered, once a session has asked one", async () => {
    const { conversationId, agentId, token } = await conversationSession();
    await ask(token, agentId);

    const view = await assistantConversation(VIEWER, conversationId);

    expect(view?.questions).toEqual([{ id: expect.any(String), agentId, askedAt: expect.any(String), questions: QUESTION.questions, answer: null }]);
  });
});

describe("answering a question", () => {
  async function asked(): Promise<{ conversationId: string; agentId: string; questionId: string }> {
    const session = await conversationSession();
    await ask(session.token, session.agentId);
    const row = await prisma.agentQuestion.findFirstOrThrow({ where: { agentId: session.agentId }, select: { id: true } });
    return { conversationId: session.conversationId, agentId: session.agentId, questionId: row.id };
  }

  it("should send the choice as an ordinary direct message and record it on the question", async () => {
    const { conversationId, agentId, questionId } = await asked();

    expect(await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Red"], text: null }] } })).toEqual({ ok: true });

    const messages = await prisma.message.findMany({ where: { targetAgentId: agentId }, select: { id: true, kind: true, body: true, authorOid: true } });
    expect(messages).toEqual([
      { id: expect.anything(), kind: "direct", body: "Answering your question.\n\nDo you prefer red or blue?\nRed", authorOid: ALICE.oid }
    ]);
    const stored = await prisma.agentQuestion.findUniqueOrThrow({
      where: { id: questionId },
      select: { answer: true, answeredAt: true, answerMessageId: true }
    });
    expect(stored.answer).toEqual({ answers: [{ labels: ["Red"], text: null }] });
    expect(stored.answeredAt).toBeInstanceOf(Date);
    expect(stored.answerMessageId).toBe(messages[0]?.id);
    // The same delivery the composer's send gets, so nothing new has to carry the answer to the session, and the
    // conversation counts the answer as activity.
    expect(await prisma.delivery.count({ where: { agentId, state: "queued" } })).toBe(1);
    const conversation = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conversation.lastActiveAt.getTime()).toBeGreaterThan(conversation.createdAt.getTime() - 1);
    // Nothing to wake: this conversation's session registered and reads `idle`.
    expect(conversation.wakeRequestedAt).toBeNull();
  });

  it("should ask for a wake when the conversation's session has gone, as the composer's send does", async () => {
    const { conversationId, agentId, questionId } = await asked();
    await prisma.agent.update({ where: { id: agentId }, data: { status: "offline" } });

    expect(await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Red"], text: null }] } })).toEqual({ ok: true });

    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId } })).wakeRequestedAt).toBeInstanceOf(Date);
  });

  it("should show the card as answered once the answer is in, so it offers nothing", async () => {
    const { conversationId, questionId } = await asked();
    await answerAgentQuestion({ questionId, answers: { answers: [{ labels: [], text: "amber, actually" }] } });

    const view = await assistantConversation(VIEWER, conversationId);

    expect(view?.questions[0]?.answer).toEqual({ answers: [{ labels: [], text: "amber, actually" }], at: expect.any(String) });
  });

  it("should refuse a second answer and send no second message, so the session is told once", async () => {
    const { agentId, questionId } = await asked();
    await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Red"], text: null }] } });

    expect(await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Blue"], text: null }] } })).toEqual({
      ok: false,
      error: "that question has already been answered"
    });
    expect(await prisma.message.count({ where: { targetAgentId: agentId } })).toBe(1);
  });

  it("should refuse a label the question did not offer, and send nothing", async () => {
    const { agentId, questionId } = await asked();

    expect(await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Green"], text: null }] } })).toEqual({
      ok: false,
      error: "that is not one of the options offered"
    });
    expect(await prisma.message.count({ where: { targetAgentId: agentId } })).toBe(0);
  });

  it("should report someone else's question as no longer waiting, confirming nothing about the id", async () => {
    const { questionId } = await asked();
    await insertUser(BOB);
    actAs("bob");

    expect(await answerAgentQuestion({ questionId, answers: { answers: [{ labels: ["Red"], text: null }] } })).toEqual({
      ok: false,
      error: "that question is no longer waiting for an answer"
    });
    expect((await prisma.agentQuestion.findUniqueOrThrow({ where: { id: questionId } })).answeredAt).toBeNull();
  });

  it("should report a question that never existed the same way", async () => {
    await insertUser(ALICE);

    expect(await answerAgentQuestion({ questionId: "11111111-1111-1111-1111-111111111111", answers: { answers: [] } })).toEqual({
      ok: false,
      error: "that question is no longer waiting for an answer"
    });
  });

  it("should answer an ordinary agent's question as a direct message, with no conversation to wake", async () => {
    const agentId = await insertAgent(ALICE, "laptop");
    const response = await call(questionRoute.POST, {
      as: ALICE,
      path: `/api/agent/${agentId}/question`,
      params: { agentId },
      method: "POST",
      body: QUESTION
    });
    expect(response.status).toBe(204);
    const row = await prisma.agentQuestion.findFirstOrThrow({ where: { agentId }, select: { id: true } });

    expect(await answerAgentQuestion({ questionId: row.id, answers: { answers: [{ labels: ["Blue"], text: null }] } })).toEqual({ ok: true });

    expect(await prisma.message.count({ where: { targetAgentId: agentId } })).toBe(1);
    expect((await prisma.agentQuestion.findUniqueOrThrow({ where: { id: row.id } })).answeredAt).toBeInstanceOf(Date);
  });
});
