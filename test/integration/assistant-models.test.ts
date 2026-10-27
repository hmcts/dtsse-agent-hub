// Which models a person is offered, end to end through Postgres: their pod's report of what their credential answered,
// what is stored and what is not, and the offer the pages and the actions read from it.
//
// The pod's own half — asking each model and classifying the answer — is in the client package's
// `src/assistant/model-check.test.ts`; the offer from a set of answers is in `src/assistant/models.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelsRoute from "../../src/app/api/virtual/[virtualAgentId]/models/route.ts";
import { readModelOffer, reportModelAccess } from "../../src/assistant/model-access-store.ts";
import { assistantFrame, findConversation } from "../../src/assistant/store.ts";
import { claimVirtualAgents, observeVirtualAgent } from "../../src/virtual-agents/store.ts";
import { ALICE, BOB, podFixture } from "./assistant-pod.ts";
import { prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/assistant.ts");

beforeEach(async () => {
  await resetDatabase();
  actAs("alice");
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
});

const assistantOf = podFixture(["model-check"]);

async function launchToken(id: string): Promise<string> {
  const claimed = await claimVirtualAgents(prisma, "preview-01", { limit: 20 });
  const mine = claimed.virtual_agents.find((agent) => agent.id === id);
  if (mine?.launch_token === undefined || mine.launch_token === null) {
    throw new Error("the assistant was not claimed with a launch token");
  }
  await observeVirtualAgent(prisma, id, { generation: mine.generation, replicasReady: 1, podPhase: "Running" });
  return mine.launch_token;
}

async function post(id: string, token: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/virtual/${id}/models`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await modelsRoute.POST(request, { params: Promise.resolve({ virtualAgentId: id }) });
}

const offered = async (id: string) => (await readModelOffer(prisma, id)).models.map((model) => model.id);

describe("the models a pod reports", () => {
  it("should offer what the owner's credential answered when the pod reports its check", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    const response = await post(assistant, token, {
      models: [
        { model: "claude-sonnet-5-5", status: "available" },
        { model: "claude-opus-5-5", status: "unavailable" },
        { model: "claude-haiku-5-5", status: "available" },
        { model: "claude-fable-5-1", status: "unavailable" }
      ]
    });

    expect(response.status).toBe(204);
    expect(await offered(assistant)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    const rows = await prisma.assistantModelAccess.findMany({ where: { ownerOid: ALICE.oid }, orderBy: { model: "asc" } });
    expect(rows.map((row) => [row.model, row.modelRoute, row.status])).toEqual([
      ["claude-fable-5-1", "own_licence", "unavailable"],
      ["claude-haiku-5-5", "own_licence", "available"],
      ["claude-opus-5-5", "own_licence", "unavailable"],
      ["claude-sonnet-5-5", "own_licence", "available"]
    ]);
  });

  it("should keep the last known answer when a later check could not tell", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);
    await post(assistant, token, { models: [{ model: "claude-opus-5-5", status: "available" }] });

    await post(assistant, token, { models: [{ model: "claude-opus-5-5", status: "unknown" }] });

    expect(await offered(assistant)).toEqual(["claude-opus-5-5"]);
  });

  it("should take a model away when a later check is refused it", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);
    await post(assistant, token, {
      models: [
        { model: "claude-sonnet-5-5", status: "available" },
        { model: "claude-opus-5-5", status: "available" }
      ]
    });

    await post(assistant, token, { models: [{ model: "claude-opus-5-5", status: "unavailable" }] });

    expect(await offered(assistant)).toEqual(["claude-sonnet-5-5"]);
  });

  it("should ignore a model the catalogue does not hold, and store the rest, when a newer pod reports one", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    const response = await post(assistant, token, {
      models: [
        { model: "claude-next-6", status: "available" },
        { model: "claude-haiku-5-5", status: "available" }
      ]
    });

    expect(response.status).toBe(204);
    expect(await prisma.assistantModelAccess.count({ where: { model: "claude-next-6" } })).toBe(0);
    expect(await offered(assistant)).toEqual(["claude-haiku-5-5"]);
  });

  it.each([
    ["a status it does not know", { models: [{ model: "claude-sonnet-5-5", status: "maybe" }] }],
    ["a model that is not the shape of an id", { models: [{ model: "claude-sonnet-5-5 --x", status: "available" }] }],
    ["no list", {}]
  ])("should refuse a report with %s and store nothing", async (_what, body) => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    expect((await post(assistant, token, body)).status).toBe(400);
    expect(await prisma.assistantModelAccess.count()).toBe(0);
  });

  it("should refuse another virtual agent's launch token and store nothing", async () => {
    const mine = await assistantOf(ALICE);
    const theirs = await assistantOf(BOB);
    const token = await launchToken(theirs);

    expect((await post(mine, token, { models: [{ model: "claude-opus-5-5", status: "available" }] })).status).toBe(403);
    expect(await prisma.assistantModelAccess.count()).toBe(0);
  });

  it("should answer 404 when virtual agents are off", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    expect((await post(assistant, token, { models: [] })).status).toBe(404);
  });
});

describe("what a person is offered", () => {
  it("should offer only Sonnet 5.5 before any check has answered", async () => {
    const assistant = await assistantOf(ALICE);

    expect(await readModelOffer(prisma, assistant)).toMatchObject({ defaultModel: "claude-sonnet-5-5" });
    expect(await offered(assistant)).toEqual(["claude-sonnet-5-5"]);
  });

  it("should offer only Sonnet 5.5, whatever was stored, when the pod's client does not claim model-check", async () => {
    const assistant = await assistantOf(ALICE, null);
    await reportModelAccess(prisma, { id: assistant, ownerOid: ALICE.oid, modelRoute: "own-licence" }, [{ model: "claude-opus-5-5", status: "available" }]);

    expect(await offered(assistant)).toEqual(["claude-sonnet-5-5"]);
  });

  it("should offer only what was answered on the virtual agent's own route when the person has answers on both", async () => {
    const assistant = await assistantOf(ALICE);
    await reportModelAccess(prisma, { id: assistant, ownerOid: ALICE.oid, modelRoute: "bedrock" }, [{ model: "claude-haiku-5-5", status: "available" }]);
    await reportModelAccess(prisma, { id: assistant, ownerOid: ALICE.oid, modelRoute: "own-licence" }, [{ model: "claude-opus-5-5", status: "available" }]);

    expect(await offered(assistant)).toEqual(["claude-opus-5-5"]);
    expect((await readModelOffer(prisma, assistant)).defaultModel).toBe("claude-opus-5-5");
  });

  it("should offer the default for a virtual agent that does not exist", async () => {
    expect(await offered("00000000-0000-4000-8000-000000000000")).toEqual(["claude-sonnet-5-5"]);
  });

  it("should store nothing and announce nothing when every answer was unknown", async () => {
    const assistant = await assistantOf(ALICE);

    await reportModelAccess(prisma, { id: assistant, ownerOid: ALICE.oid, modelRoute: "own-licence" }, [{ model: "claude-opus-5-5", status: "unknown" }]);

    expect(await prisma.assistantModelAccess.count()).toBe(0);
  });
});

describe("the actions and what is offered", () => {
  const grant = (assistant: string, models: string[]) =>
    reportModelAccess(
      prisma,
      { id: assistant, ownerOid: ALICE.oid, modelRoute: "own-licence" },
      models.map((model) => ({ model, status: "available" as const }))
    );

  it("should refuse to start a chat on a model the person's credential has not answered, and accept it once it has", async () => {
    const assistant = await assistantOf(ALICE);

    expect(await actions.startConversation({ product: "general", model: "claude-opus-5-5", body: "hi" })).toEqual({
      ok: false,
      error: "pick a model from the list"
    });
    await grant(assistant, ["claude-opus-5-5"]);
    const started = await actions.startConversation({ product: "general", model: "claude-opus-5-5", body: "hi" });

    expect(started).toMatchObject({ ok: true });
    expect((await findConversation(prisma, ALICE.oid, (started as { id: string }).id))!.model).toBe("claude-opus-5-5");
  });

  it("should start a chat on the person's default when they pick nothing and Sonnet 5.5 is not offered", async () => {
    const assistant = await assistantOf(ALICE);
    await grant(assistant, ["claude-haiku-5-5"]);

    const started = (await actions.startConversation({ product: "general", body: "hi" })) as { id: string };

    expect((await findConversation(prisma, ALICE.oid, started.id))!.model).toBe("claude-haiku-5-5");
  });

  it("should refuse to change a chat to a model the person is not offered", async () => {
    const assistant = await assistantOf(ALICE);
    await grant(assistant, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    const { id } = (await actions.startConversation({ product: "general", body: "hi" })) as { id: string };

    expect(await actions.setConversationModel({ conversationId: id, model: "claude-opus-5-5" })).toEqual({ ok: false, error: "pick a model from the list" });
    expect(await actions.setConversationModel({ conversationId: id, model: "claude-haiku-5-5" })).toEqual({ ok: true });
  });

  it("should tell the session the default when its model has stopped being offered", async () => {
    const assistant = await assistantOf(ALICE);
    await grant(assistant, ["claude-sonnet-5-5", "claude-opus-5-5"]);
    const { id } = (await actions.startConversation({ product: "general", model: "claude-opus-5-5", body: "hi" })) as { id: string };
    const conversation = (await findConversation(prisma, ALICE.oid, id))!;

    await reportModelAccess(prisma, { id: assistant, ownerOid: ALICE.oid, modelRoute: "own-licence" }, [{ model: "claude-opus-5-5", status: "unavailable" }]);

    expect(await assistantFrame(prisma, conversation.agentId!)).toMatchObject({ model: "claude-sonnet-5-5" });
  });
});
