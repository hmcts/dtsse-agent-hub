// Loading a template from the person's template library through Postgres: the panel's request for a `docmosis.load`
// job and the hub's check of it against their own index, and the pod's publish naming the job as `pick`, which the
// hub records as the person's own and finishes the job with. The pod's half is the client package's
// `src/assistant/docmosis-load.test.ts`.
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as docmosisRoute from "../../src/app/api/agent/[agentId]/docmosis/route.ts";
import * as podJobsRoute from "../../src/app/api/ui/assistant/pod-jobs/[conversationId]/route.ts";
import { docxRef } from "../../src/assistant/docmosis.ts";
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
  await prisma.virtualAgent.update({ where: { id: virtualAgent }, data: { observedGeneration: row.generation, clientFeatures: ["pod-job:docmosis.load"] } });
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

/** What the pod's publish does: the .docx, then the version naming the pick. */
async function publish(chat: Chat, pick: string, bytes: Buffer = TEMPLATE, base = { base_version: 0, base_revision: 0 }): Promise<Response> {
  await putDocmosisAsset(prisma, chat.conversation, sha256(bytes), bytes);
  return await call(docmosisRoute.PUT, {
    as: ALICE,
    path: `/api/agent/${chat.agent}/docmosis`,
    params: { agentId: chat.agent },
    method: "PUT",
    body: { name: "Claim form.docx", docx: docxRef(sha256(bytes)), schema: SCHEMA, data: {}, ...base, summary: "Loaded Claim form.docx", pick }
  });
}

const versionsOf = (conversation: string) =>
  prisma.assistantDocmosisVersion.findMany({
    where: { conversationId: conversation },
    orderBy: { version: "asc" },
    select: { version: true, by: true, editorOid: true, summary: true, sourcePath: true, sourceBlobSha: true }
  });

const statusOf = async (chat: Chat, job: string) => (await readPodJob(prisma, ALICE.oid, chat.conversation, job))?.status;

describe("asking for a docmosis.load", () => {
  it("should start a load when the pick is in the person's own index", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);

    const job = await loadJob(chat);

    expect(await statusOf(chat, job)).toBe("pending");
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

  it("should not count refused picks against the rate limit", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    for (let at = 0; at < 20; at += 1) {
      expect((await ask(chat.conversation, { kind: "docmosis.load", args: args({ blob_sha: "e".repeat(40) }) })).status).toBe(409);
    }

    expect(await statusOf(chat, await loadJob(chat))).toBe("pending");
  });

  it("should hold one pending load per conversation, joining the same pick and refusing another", async () => {
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
  it("should record the version as the person's, with where it came from, and finish the job", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);

    const response = await publish(chat, job);

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ version: 1, revision: 0 });
    expect(await versionsOf(chat.conversation)).toEqual([
      { version: 1, by: "user", editorOid: ALICE.oid, summary: "Loaded Claim form.docx", sourcePath: PATH, sourceBlobSha: BLOB }
    ]);
    const conversation = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: chat.conversation }, select: { docmosisUpdatedBy: true } });
    expect(conversation.docmosisUpdatedBy).toBe("user");
    expect(await readPodJob(prisma, ALICE.oid, chat.conversation, job)).toEqual({
      job_id: job,
      kind: "docmosis.load",
      status: "done",
      result: { version: 1, revision: 0 }
    });
    const read = await call(docmosisRoute.GET, { as: ALICE, path: `/api/agent/${chat.agent}/docmosis`, params: { agentId: chat.agent } });
    expect(await jsonOf(read)).toMatchObject({ by: "user", source_path: PATH });
  });

  it("should refuse a .docx that is not the picked blob and leave the job pending", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);

    const response = await publish(chat, job, docx(2));

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
    expect(await statusOf(chat, job)).toBe("pending");
  });

  it("should refuse a pick asked for in another conversation", async () => {
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

  it("should refuse a pick whose job ran out of time", async () => {
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

  it("should refuse a pick that is not a job", async () => {
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
    expect(await jsonOf(response)).toEqual({ error: PICK_LOADED, loaded: { version: 1, revision: 0 } });
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

  it("should refuse with 400 a pick whose job failed", async () => {
    const chat = await chatOf(ALICE);
    await indexOf(ALICE);
    const job = await loadJob(chat);
    await prisma.assistantPodJob.update({ where: { id: job }, data: { status: "failed", error: "schema_failed", finishedAt: new Date() } });

    const response = await publish(chat, job);

    expect(response.status).toBe(400);
    expect(await versionsOf(chat.conversation)).toEqual([]);
  });

  it("should roll back a stale base and leave the job pending for the pod to answer", async () => {
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
