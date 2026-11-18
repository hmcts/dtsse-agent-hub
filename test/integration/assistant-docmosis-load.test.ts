// Loading a template from the person's template library through Postgres: the panel's request for a `docmosis.load`
// job and the hub's check of it against their own index, and the pod's publish naming the job as `pick`, which the
// hub records as the person's own and finishes the job with. The pod's half is the client package's
// `src/assistant/docmosis-load.test.ts`.
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as docmosisRoute from "../../src/app/api/agent/[agentId]/docmosis/route.ts";
import * as itemRoute from "../../src/app/api/agent/[agentId]/docmosis-templates/[itemId]/route.ts";
import * as templatesRoute from "../../src/app/api/agent/[agentId]/docmosis-templates/route.ts";
import * as podJobsRoute from "../../src/app/api/ui/assistant/pod-jobs/[conversationId]/route.ts";
import { docxRef, ITEMS_CREATE_REFUSED_DOCMOSIS } from "../../src/assistant/docmosis.ts";
import { DOCMOSIS_LIBRARY_ID, type IndexEntry } from "../../src/assistant/docmosis-library.ts";
import { STALE_PICK } from "../../src/assistant/docmosis-load.ts";
import { PICK_LOADED, putDocmosisAsset, writeAgentDocmosis } from "../../src/assistant/docmosis-store.ts";
import { gitBlobSha1 } from "../../src/assistant/git-blob.ts";
import { readPodJob } from "../../src/assistant/pod-job-store.ts";
import { ALICE, podFixture } from "./assistant-pod.ts";
import { type Person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const SCHEMA = {
  root: { kind: "object" as const, controls: [], notes: [], properties: { name: { kind: "string" as const, controls: [], notes: [] } } },
  warnings: []
};
const PATH = "Templates/Base/Claim form.docx";

function docx(seed: number, length = 64): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.writeUInt32BE(seed, 8);
  return bytes;
}

const TEMPLATE = docx(1);
const BLOB = gitBlobSha1(TEMPLATE);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const withMainSession = podFixture([]);

interface Chat {
  conversation: string;
  agent: string;
}

/**
 * A conversation of the person's on their running pod, which claims the kind, with the session agent its pod's
 * session would publish through.
 */
async function chatOf(who: Person, assistant?: string): Promise<Chat> {
  const virtualAgent = assistant ?? (await withMainSession(who));
  const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: virtualAgent }, select: { generation: true } });
  await prisma.virtualAgent.update({
    where: { id: virtualAgent },
    data: { observedGeneration: row.generation, clientFeatures: ["pod-job:docmosis.load", "items"] }
  });
  const conversation = await prisma.assistantConversation.create({ data: { ownerOid: who.oid, virtualAgentId: virtualAgent }, select: { id: true } });
  const agent = await prisma.agent.create({
    data: {
      ownerOid: who.oid,
      sessionId: `session-${conversation.id}`,
      name: "chat",
      virtualAgentId: virtualAgent,
      assistantConversationId: conversation.id
    },
    select: { id: true }
  });
  await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { agentId: agent.id } });
  return { conversation: conversation.id, agent: agent.id };
}

async function indexOf(who: Person, entries: IndexEntry[] = [[PATH, BLOB, TEMPLATE.byteLength]]): Promise<void> {
  await prisma.assistantDocmosisLibrary.create({
    data: { ownerOid: who.oid, libraryId: DOCMOSIS_LIBRARY_ID, commitSha: "c".repeat(40), entries, entryCount: entries.length, checkedAt: new Date() }
  });
}

const args = (overrides: Record<string, unknown> = {}) => ({ path: PATH, blob_sha: BLOB, base_version: 0, base_revision: 0, ...overrides });

function ask(conversation: string, body: unknown, persona = "alice"): Promise<Response> {
  return podJobsRoute.POST(
    new NextRequest(`http://localhost:3000/api/ui/assistant/pod-jobs/${conversation}`, {
      method: "POST",
      headers: { cookie: `ah_dev_persona=${persona}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ conversationId: conversation }) }
  );
}

async function loadJob(chat: Chat, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await ask(chat.conversation, { kind: "docmosis.load", args: args(overrides) });
  const body = await jsonOf<{ status: string; job_id: string }>(response);
  expect(body.status).toBe("pending");
  return body.job_id;
}

/**
 * What the pod's publish does: the .docx, then the version naming the pick, through `agent`, the chat's own by default.
 * Without `to` it writes the primary template; `to: {item}` writes that one and `to: "new"` makes another.
 */
async function publish(
  chat: Chat,
  pick: string,
  bytes: Buffer = TEMPLATE,
  base = { base_version: 0, base_revision: 0 },
  agent: string = chat.agent,
  to: { item: string } | "new" | undefined = undefined
): Promise<Response> {
  await putDocmosisAsset(prisma, chat.conversation, sha256(bytes), bytes);
  const body = { name: "Claim form.docx", docx: docxRef(sha256(bytes)), schema: SCHEMA, data: {}, ...base, summary: "Loaded Claim form.docx", pick };
  if (to === "new") {
    return await call(templatesRoute.POST, { as: ALICE, path: `/api/agent/${agent}/docmosis-templates`, params: { agentId: agent }, method: "POST", body });
  }
  if (to !== undefined) {
    return await call(itemRoute.PUT, {
      as: ALICE,
      path: `/api/agent/${agent}/docmosis-templates/${to.item}`,
      params: { agentId: agent, itemId: to.item },
      method: "PUT",
      body
    });
  }
  return await call(docmosisRoute.PUT, { as: ALICE, path: `/api/agent/${agent}/docmosis`, params: { agentId: agent }, method: "PUT", body });
}

const itemsOf = (conversation: string) =>
  prisma.assistantDocmosis.findMany({
    where: { conversationId: conversation },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, version: true, updatedBy: true }
  });

const versionsOf = (conversation: string) =>
  prisma.assistantDocmosisVersion.findMany({
    where: { conversationId: conversation },
    orderBy: { version: "asc" },
    select: { version: true, by: true, editorOid: true, summary: true, sourcePath: true, sourceBlobSha: true }
  });

const LIBRARY = { owner: "hmcts", repo: "rdo-docmosis", folder: "Templates" };

const statusOf = async (chat: Chat, job: string) => (await readPodJob(prisma, ALICE.oid, chat.conversation, job))?.status;

describe("asking for a docmosis.load", () => {
  it("should start a load when the pick is in the person's own index", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);

    const job = await loadJob(chat);

    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should send the pod the library with the pick when the request is accepted", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);

    const job = await loadJob(chat);

    const row = await prisma.assistantPodJob.findUniqueOrThrow({ where: { id: job }, select: { args: true } });
    expect(row.args).toEqual({ ...LIBRARY, ...args() });
  });

  it("should refuse a stale pick without waking the pod when the pod is stopped", async () => {
    // Arrange
    const chat = await chatOf(ALICE);
    const { virtualAgentId } = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } });
    await prisma.virtualAgent.update({ where: { id: virtualAgentId as string }, data: { desired: "stopped", status: "stopped" } });

    // Act
    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args() });

    // Assert
    expect(response.status).toBe(409);
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: virtualAgentId as string }, select: { desired: true } })).desired).toBe("stopped");
  });

  it("should wake the pod when the pod is stopped and the pick is in the index", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const { virtualAgentId } = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } });
    await prisma.virtualAgent.update({ where: { id: virtualAgentId as string }, data: { desired: "stopped", status: "stopped" } });

    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args() });

    expect(await jsonOf(response)).toEqual({ status: "waking" });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: virtualAgentId as string }, select: { desired: true } })).desired).toBe("running");
  });

  it("should refuse with 409 when the person's index no longer holds the pick", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE, [[PATH, "a".repeat(40), TEMPLATE.byteLength]]);

    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args() });

    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toEqual({ error: STALE_PICK });
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should refuse with 409 when the person has no index at all", async () => {
    const chat = await chatOf(ALICE);

    expect((await ask(chat.conversation, { kind: "docmosis.load", args: args() })).status).toBe(409);
  });

  it("should refuse with 413 when the picked template is over 5 MiB", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE, [[PATH, BLOB, 5 * 1024 * 1024 + 1]]);

    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args() });

    expect(response.status).toBe(413);
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should not count refused picks against the rate limit when the index refuses them", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    for (let at = 0; at < 20; at += 1) {
      expect((await ask(chat.conversation, { kind: "docmosis.load", args: args({ blob_sha: "e".repeat(40) }) })).status).toBe(409);
    }

    expect(await statusOf(chat, await loadJob(chat))).toBe("pending");
  });

  it("should join the same pick and refuse another when a load is already pending in the conversation", async () => {
    const chat = await chatOf(ALICE);
    const other: IndexEntry = ["Templates/Base/Defence.docx", "d".repeat(40), 900];
    await indexOf(ALICE, [[PATH, BLOB, TEMPLATE.byteLength], other]);
    const first = await loadJob(chat);

    const again = await jsonOf(await ask(chat.conversation, { kind: "docmosis.load", args: args() }));
    const different = await ask(chat.conversation, { kind: "docmosis.load", args: args({ path: other[0], blob_sha: other[1] }) });

    expect(again).toEqual({ status: "pending", job_id: first });
    expect(different.status).toBe(409);
    expect(await jsonOf(different)).toMatchObject({ job_id: first });
  });
});

describe("publishing a pick", () => {
  it("should record the version as the person's, with where it came from, and finish the job when the pick is published", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);

    const response = await publish(chat, job);

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ version: 1, revision: 0 });
    expect(await versionsOf(chat.conversation)).toEqual([
      { version: 1, by: "user", editorOid: ALICE.oid, summary: "Loaded Claim form.docx", sourcePath: PATH, sourceBlobSha: BLOB }
    ]);
    const [item] = await itemsOf(chat.conversation);
    expect(item?.updatedBy).toBe("user");
    expect(await readPodJob(prisma, ALICE.oid, chat.conversation, job)).toEqual({
      job_id: job,
      kind: "docmosis.load",
      status: "done",
      result: { item: item?.id, version: 1, revision: 0 }
    });
    const read = await call(docmosisRoute.GET, { as: ALICE, path: `/api/agent/${chat.agent}/docmosis`, params: { agentId: chat.agent } });
    expect(await jsonOf(read)).toMatchObject({ by: "user", source_path: PATH });
  });

  it("should refuse the .docx and leave the job pending when it is not the picked blob", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);

    const response = await publish(chat, job, docx(2));

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should refuse a pick when it was asked for in another conversation", async () => {
    const chat = await chatOf(ALICE);
    const assistant = (await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } }))
      .virtualAgentId as string;
    const elsewhere = await chatOf(ALICE, assistant);
    await indexOf(ALICE);
    const job = await loadJob(elsewhere);

    const response = await publish(chat, job);

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
    expect(await statusOf(elsewhere, job)).toBe("pending");
  });

  it("should refuse a pick and leave the job pending when the conversation has left the job's assistant", async () => {
    // Arrange
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await prisma.assistantConversation.update({ where: { id: chat.conversation }, data: { virtualAgentId: null } });

    // Act
    const response = await publish(chat, job);

    // Assert
    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
    expect((await prisma.assistantPodJob.findUniqueOrThrow({ where: { id: job }, select: { status: true } })).status).toBe("pending");
  });

  it("should refuse a pick when the agent writing it is not one the job's assistant registered", async () => {
    // Arrange
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    const laptop = await prisma.agent.create({
      data: { ownerOid: ALICE.oid, sessionId: "laptop-session", name: "laptop", assistantConversationId: chat.conversation },
      select: { id: true }
    });

    // Act
    const response = await publish(chat, job, TEMPLATE, { base_version: 0, base_revision: 0 }, laptop.id);

    // Assert
    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should refuse a pick when it is written with no agent named", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await putDocmosisAsset(prisma, chat.conversation, sha256(TEMPLATE), TEMPLATE);

    const thrown = await writeAgentDocmosis(prisma, {
      conversationId: chat.conversation,
      body: { name: "Claim form.docx", docx: docxRef(sha256(TEMPLATE)), schema: SCHEMA, data: {}, base_version: 0, base_revision: 0, pick: job }
    }).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ status: 400 });
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should refuse a pick when its job ran out of time", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await prisma.assistantPodJob.update({
      where: { id: job },
      data: { createdAt: new Date(Date.now() - 3 * 60_000), expiresAt: new Date(Date.now() - 60_000) }
    });

    const response = await publish(chat, job);

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
  });

  it("should refuse a pick when it names no job", async () => {
    const chat = await chatOf(ALICE);

    const response = await publish(chat, crypto.randomUUID());

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
  });

  it.each([
    ["the base it was asked with", { base_version: 0, base_revision: 0 }],
    ["the version it wrote as its base", { base_version: 1, base_revision: 0 }]
  ])("should answer 409 with the version already written, and write no second, when a loaded pick is published again on %s", async (_label, base) => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await publish(chat, job);

    const response = await publish(chat, job, TEMPLATE, base);

    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toEqual({ error: PICK_LOADED, loaded: { item: (await itemsOf(chat.conversation))[0]?.id, version: 1, revision: 0 } });
    expect((await versionsOf(chat.conversation)).length).toBe(1);
    expect(await statusOf(chat, job)).toBe("done");
  });

  it("should refuse a loaded pick with 400 when it is published again in another conversation", async () => {
    const chat = await chatOf(ALICE);
    const assistant = (await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } }))
      .virtualAgentId as string;
    const elsewhere = await chatOf(ALICE, assistant);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await publish(chat, job);

    const response = await publish(elsewhere, job);

    expect(response.status).toBe(400);
    expect(await versionsOf(elsewhere.conversation)).toEqual([]);
  });

  it("should refuse a pick with 400 when its job failed", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await prisma.assistantPodJob.update({ where: { id: job }, data: { status: "failed", error: "schema_failed", finishedAt: new Date() } });

    const response = await publish(chat, job);

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
  });

  it("should roll back and leave the job pending for the pod to answer when the base is stale", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const held = docx(3);
    await putDocmosisAsset(prisma, chat.conversation, sha256(held), held);
    await writeAgentDocmosis(prisma, {
      conversationId: chat.conversation,
      body: { name: "Mine", docx: docxRef(sha256(held)), schema: SCHEMA, data: {}, base_version: 0 }
    });
    const job = await loadJob(chat);

    const response = await publish(chat, job);

    expect(response.status).toBe(409);
    expect(await versionsOf(chat.conversation)).toEqual([expect.objectContaining({ version: 1, by: "agent", sourcePath: null })]);
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should write the agent's version with no source when there is no pick", async () => {
    const chat = await chatOf(ALICE);
    await putDocmosisAsset(prisma, chat.conversation, sha256(TEMPLATE), TEMPLATE);

    await writeAgentDocmosis(prisma, {
      conversationId: chat.conversation,
      body: { name: "Mine", docx: docxRef(sha256(TEMPLATE)), schema: SCHEMA, data: {}, base_version: 0, summary: "Made it" }
    });

    expect(await versionsOf(chat.conversation)).toEqual([
      { version: 1, by: "agent", editorOid: null, summary: "Made it", sourcePath: null, sourceBlobSha: null }
    ]);
  });
});

describe("a load's target template", () => {
  async function chatWithTemplate(): Promise<{ chat: Chat; item: string }> {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const held = docx(3);
    await putDocmosisAsset(prisma, chat.conversation, sha256(held), held);
    const written = await writeAgentDocmosis(prisma, {
      conversationId: chat.conversation,
      body: { name: "Mine", docx: docxRef(sha256(held)), schema: SCHEMA, data: {}, base_version: 0 }
    });
    return { chat, item: written.id };
  }

  it("should write into the template the job names and finish the job with its id when the pick is published to it", async () => {
    const { chat, item } = await chatWithTemplate();
    const job = await loadJob(chat, { item, base_version: 1 });

    const response = await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 }, chat.agent, { item });

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ version: 2, revision: 0 });
    expect(await itemsOf(chat.conversation)).toEqual([{ id: item, version: 2, updatedBy: "user" }]);
    expect((await readPodJob(prisma, ALICE.oid, chat.conversation, job))?.result).toEqual({ item, version: 2, revision: 0 });
  });

  it("should refuse a pick published to another template than the job names, and to the primary when the job names an item", async () => {
    const { chat, item } = await chatWithTemplate();
    const held = docx(4);
    await putDocmosisAsset(prisma, chat.conversation, sha256(held), held);
    const second = await writeAgentDocmosis(prisma, {
      conversationId: chat.conversation,
      create: true,
      body: { name: "Other", docx: docxRef(sha256(held)), schema: SCHEMA, data: {}, base_version: 0 }
    });
    const job = await loadJob(chat, { item: second.id, base_version: 1 });

    const elsewhere = await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 }, chat.agent, { item });
    const primary = await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 });

    expect([elsewhere.status, primary.status]).toEqual([400, 400]);
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should make a new template, leave the others alone and finish the job with its id when the job names no item", async () => {
    const { chat, item } = await chatWithTemplate();
    const job = await loadJob(chat);

    const response = await publish(chat, job, TEMPLATE, { base_version: 0, base_revision: 0 }, chat.agent, "new");

    expect(response.status).toBe(201);
    const made = await jsonOf<{ id: string; version: number }>(response);
    expect(made).toMatchObject({ version: 1, revision: 0 });
    expect((await itemsOf(chat.conversation)).map((row) => row.id)).toEqual([item, made.id]);
    expect((await readPodJob(prisma, ALICE.oid, chat.conversation, job))?.result).toEqual({ item: made.id, version: 1, revision: 0 });
  });

  it("should answer 409 with the template an earlier run made, and make no second, when a new template's pick is published again", async () => {
    const { chat } = await chatWithTemplate();
    const job = await loadJob(chat);
    const first = await jsonOf<{ id: string }>(await publish(chat, job, TEMPLATE, { base_version: 0, base_revision: 0 }, chat.agent, "new"));

    const again = await publish(chat, job, TEMPLATE, { base_version: 0, base_revision: 0 }, chat.agent, "new");

    expect(again.status).toBe(409);
    expect(await jsonOf(again)).toEqual({ error: PICK_LOADED, loaded: { item: first.id, version: 1, revision: 0 } });
    expect(await itemsOf(chat.conversation)).toHaveLength(2);
  });

  it("should answer 409 with the template an earlier run wrote, and write no second version, when a targeted pick is published again", async () => {
    const { chat, item } = await chatWithTemplate();
    const job = await loadJob(chat, { item, base_version: 1 });
    await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 }, chat.agent, { item });

    const again = await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 }, chat.agent, { item });

    expect(again.status).toBe(409);
    expect(await jsonOf(again)).toEqual({ error: PICK_LOADED, loaded: { item, version: 2, revision: 0 } });
    expect((await versionsOf(chat.conversation)).map((version) => version.version)).toEqual([1, 2]);
  });

  it("should refuse a load into a template the conversation does not hold with 404, starting no job", async () => {
    const { chat } = await chatWithTemplate();

    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args({ item: crypto.randomUUID() }) });

    expect(response.status).toBe(404);
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should refuse a load that would make a second template with 409, starting no job, when the pod's client is older than items", async () => {
    const { chat } = await chatWithTemplate();
    const { virtualAgentId } = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } });
    await prisma.virtualAgent.update({ where: { id: virtualAgentId as string }, data: { clientFeatures: ["pod-job:docmosis.load"] } });

    const response = await ask(chat.conversation, { kind: "docmosis.load", args: args() });

    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toEqual({ error: ITEMS_CREATE_REFUSED_DOCMOSIS });
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should send a pod older than items the load of the primary without its item, which that pod would refuse as unknown", async () => {
    const { chat, item } = await chatWithTemplate();
    const { virtualAgentId } = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } });
    await prisma.virtualAgent.update({ where: { id: virtualAgentId as string }, data: { clientFeatures: ["pod-job:docmosis.load"] } });

    const job = await loadJob(chat, { item, base_version: 1 });

    const row = await prisma.assistantPodJob.findUniqueOrThrow({ where: { id: job }, select: { args: true } });
    expect(row.args).toEqual({ ...LIBRARY, ...args({ base_version: 1 }) });
    const response = await publish(chat, job, TEMPLATE, { base_version: 1, base_revision: 0 });
    expect(response.status).toBe(200);
    expect(await itemsOf(chat.conversation)).toEqual([{ id: item, version: 2, updatedBy: "user" }]);
  });

  it("should let a pod older than items load the first template, which it writes as the primary", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const { virtualAgentId } = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { virtualAgentId: true } });
    await prisma.virtualAgent.update({ where: { id: virtualAgentId as string }, data: { clientFeatures: ["pod-job:docmosis.load"] } });

    const job = await loadJob(chat);
    const response = await publish(chat, job);

    expect(response.status).toBe(200);
    expect(await itemsOf(chat.conversation)).toHaveLength(1);
  });
});
