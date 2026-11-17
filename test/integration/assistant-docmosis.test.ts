import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as assetRoute from "../../src/app/api/agent/[agentId]/docmosis/assets/[sha256]/route.ts";
import * as docmosisRoute from "../../src/app/api/agent/[agentId]/docmosis/route.ts";
import * as pdfRoute from "../../src/app/api/agent/[agentId]/docmosis/versions/[version]/pdf/route.ts";
import { ASSET_GRACE_MS, type DocmosisPut, docxRef, KEEP_PDF, KEEP_VERSIONS, MAX_HELD_DOCX_BYTES } from "../../src/assistant/docmosis.ts";
import {
  docmosisSummary,
  docmosisView,
  listDocmosisVersions,
  putDocmosisAsset,
  putDocmosisPdf,
  readDocmosisDocx,
  readDocmosisPdf,
  storeDocmosisRender,
  writeAgentDocmosis,
  writeUserDocmosisData
} from "../../src/assistant/docmosis-store.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { conversationView } from "../../src/assistant/views.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { devUser, prisma } from "./database.ts";
import { ALICE, BOB, CAROL, type Chat, chat } from "./deck-chats.ts";
import { jsonOf } from "./routes.ts";

/**
 * A conversation's Docmosis template: the session writes versions through the agent API, the person's data saves
 * amend or extend them, and every write applies the retention in its own transaction.
 */

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

assistantSuite([ALICE, BOB, CAROL]);

const SCHEMA = {
  root: { kind: "object" as const, controls: [], notes: [], properties: { name: { kind: "string" as const, controls: [], notes: [] } } },
  warnings: []
};

function docx(seed: number, length = 32): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.writeUInt32BE(seed, 8);
  return bytes;
}
const PDF = Buffer.from("%PDF-1.7 rendered");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function held(of: Chat, bytes: Buffer, now?: Date): Promise<string> {
  const sha = digest(bytes);
  await putDocmosisAsset(prisma, of.id, sha, bytes, now);
  return sha;
}

function body(sha: string, overrides: Partial<DocmosisPut> = {}): DocmosisPut {
  return { name: "Claim form", docx: docxRef(sha), schema: SCHEMA, data: { name: "Ada" }, base_version: 0, ...overrides };
}

/** Every .docx the chat holds, made old enough that no kept version needs to name it to be deleted. */
const ageAssets = (of: Chat) =>
  prisma.assistantDocmosisAsset.updateMany({ where: { conversationId: of.id }, data: { createdAt: new Date(Date.now() - 2 * ASSET_GRACE_MS) } });

async function agentWrite(of: Chat, seed: number, overrides: Partial<DocmosisPut> = {}, now?: Date) {
  const sha = await held(of, docx(seed), now);
  return await writeAgentDocmosis(prisma, { conversationId: of.id, body: body(sha, overrides), ...(now === undefined ? {} : { now }) });
}

const personSave = (of: Chat, data: Record<string, unknown>, base: { version: number; revision: number }, editorOid = ALICE.oid, now?: Date) =>
  writeUserDocmosisData(prisma, {
    conversationId: of.id,
    editorOid,
    data,
    baseVersion: base.version,
    baseRevision: base.revision,
    ...(now === undefined ? {} : { now })
  });

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

async function agent<P>(handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown): Promise<Response> {
  const bytes = body instanceof Uint8Array;
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "x-dev-user": devUser(ALICE), ...(body === undefined ? {} : { "content-type": bytes ? "application/octet-stream" : "application/json" }) },
    ...(body === undefined ? {} : { body: bytes ? (body as Uint8Array).slice() : JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function conflictOf(call: Promise<unknown>) {
  const error = (await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  )) as { status: number; extra: { current: unknown } } | undefined;
  expect(error?.status).toBe(409);
  return error!.extra.current as { version: number; revision: number; by: string } | null;
}

describe("the docmosis routes", () => {
  it("should upload a .docx, write a version, read it back and refuse a stale version with the current one", async () => {
    const mine = await chat();
    const route = (method: string, payload?: unknown, query = "") =>
      agent(
        method === "GET" ? docmosisRoute.GET : docmosisRoute.PUT,
        `/api/agent/${mine.agentId}/docmosis${query}`,
        { agentId: mine.agentId },
        method,
        payload
      );
    const bytes = docx(1);
    const sha = digest(bytes);

    expect((await route("GET")).status).toBe(404);
    const stored = await agent(
      assetRoute.PUT,
      `/api/agent/${mine.agentId}/docmosis/assets/${sha}`,
      { agentId: mine.agentId, sha256: sha },
      "PUT",
      new Uint8Array(bytes)
    );
    expect(await jsonOf(stored)).toEqual({ asset: `sha256:${sha}` });
    const back = await agent(assetRoute.GET, `/api/agent/${mine.agentId}/docmosis/assets/${sha}`, { agentId: mine.agentId, sha256: sha });
    expect(Buffer.from(await back.arrayBuffer())).toEqual(bytes);

    expect(await jsonOf(await route("PUT", { ...body(sha), summary: "First draft" }))).toEqual({ version: 1, revision: 0 });
    const read = await jsonOf(await route("GET"));
    expect(read).toMatchObject({
      version: 1,
      revision: 0,
      name: "Claim form",
      docx: `sha256:${sha}`,
      by: "agent",
      summary: "First draft",
      has_pdf: false,
      render_error: null,
      data: { name: "Ada" }
    });
    expect(read.current_version).toBeUndefined();

    const stale = await route("PUT", body(sha, { base_version: 0 }));
    expect(stale.status).toBe(409);
    expect((await jsonOf(stale)).current).toMatchObject({ version: 1, by: "agent" });

    await route("PUT", body(sha, { base_version: 1, data: { name: "Bea" } }));
    expect(await jsonOf(await route("GET", undefined, "?version=1"))).toMatchObject({ version: 1, current_version: 2, data: { name: "Ada" } });
    expect((await route("GET", undefined, "?version=9")).status).toBe(404);
  });

  it("should refuse a missing .docx naming it, a bad body naming the field, and bytes that are not what they say", async () => {
    const mine = await chat();
    const put = (payload: unknown) => agent(docmosisRoute.PUT, `/api/agent/${mine.agentId}/docmosis`, { agentId: mine.agentId }, "PUT", payload);
    const missing = digest(docx(7));

    const unheld = await put(body(missing));
    expect(unheld.status).toBe(400);
    expect(await jsonOf(unheld)).toMatchObject({ missing_assets: [`sha256:${missing}`] });
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).docmosisVersion).toBe(0);

    const invalid = await put({ ...body(missing), schema: { root: {}, warnings: [] } });
    expect(invalid.status).toBe(400);
    expect((await jsonOf(invalid)).error).toMatch(/^schema\.root/);

    const notZip = await agent(
      assetRoute.PUT,
      `/api/agent/${mine.agentId}/docmosis/assets/${digest(Buffer.from("x"))}`,
      { agentId: mine.agentId, sha256: digest(Buffer.from("x")) },
      "PUT",
      new Uint8Array(Buffer.from("x"))
    );
    expect(notZip.status).toBe(400);
  });

  it("should take a PDF for a kept version and 404 for one that is not", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    const put = (version: number, bytes: Uint8Array) =>
      agent(pdfRoute.PUT, `/api/agent/${mine.agentId}/docmosis/versions/${version}/pdf`, { agentId: mine.agentId, version: String(version) }, "PUT", bytes);

    expect((await put(1, new Uint8Array(PDF))).status).toBe(204);
    expect(Buffer.from((await readDocmosisPdf(prisma, mine.id, 1))!)).toEqual(PDF);
    expect((await put(2, new Uint8Array(PDF))).status).toBe(404);
    expect((await put(1, new Uint8Array(Buffer.from("not a pdf")))).status).toBe(400);
  });
});

describe("the docmosis store's versions", () => {
  it("should write each agent version as the next, at revision 0, and announce the conversation's row", async () => {
    const mine = await chat();

    expect(await agentWrite(mine, 1)).toEqual({ version: 1, revision: 0 });
    expect(await agentWrite(mine, 2, { base_version: 1, base_revision: 0 })).toEqual({ version: 2, revision: 0 });

    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row).toMatchObject({ docmosisVersion: 2, docmosisRevision: 0, docmosisName: "Claim form", docmosisUpdatedBy: "agent" });
    expect(row.firstContentAt).not.toBeNull();
    expect(await listDocmosisVersions(prisma, mine.id)).toMatchObject([
      { version: 2, by: "agent" },
      { version: 1, by: "agent" }
    ]);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ docmosis_version: 2, docmosis_revision: 0, docmosis_updated_by: "agent" });
  });

  it("should refuse a stale version or revision with the current one, and write nothing", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    await personSave(mine, { name: "Bea" }, { version: 1, revision: 0 });
    const sha = await held(mine, docx(2));

    const staleVersion = await conflictOf(writeAgentDocmosis(prisma, { conversationId: mine.id, body: body(sha, { base_version: 0 }) }));
    const staleRevision = await conflictOf(writeAgentDocmosis(prisma, { conversationId: mine.id, body: body(sha, { base_version: 2, base_revision: 1 }) }));
    const none = await conflictOf(writeAgentDocmosis(prisma, { conversationId: (await chat()).id, body: body(sha, { base_version: 3 }) }));

    expect(staleVersion).toMatchObject({ version: 2, revision: 0, by: "user" });
    expect(staleRevision).toMatchObject({ version: 2 });
    expect(none).toBeNull();
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).docmosisVersion).toBe(2);
  });

  it("should write over the person's amend when the put sends no base_revision", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    await personSave(mine, { name: "Bea" }, { version: 1, revision: 0 });
    await personSave(mine, { name: "Cy" }, { version: 2, revision: 0 });

    expect(await agentWrite(mine, 2, { base_version: 2 })).toEqual({ version: 3, revision: 0 });
  });

  it("should amend the person's own latest version in place, clearing its PDF and error", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    expect(await personSave(mine, { name: "Bea" }, { version: 1, revision: 0 })).toEqual({ version: 2, revision: 0 });
    await putDocmosisPdf(prisma, mine.id, 2, PDF);

    expect(await personSave(mine, { name: "Cy" }, { version: 2, revision: 0 })).toEqual({ version: 2, revision: 1 });

    const view = await docmosisView(prisma, mine.id);
    expect(view).toMatchObject({ version: 2, revision: 1, by: "user", data: { name: "Cy" }, has_pdf: false, render_error: null, summary: "Edited form data" });
    expect(await readDocmosisPdf(prisma, mine.id, 2)).toBeNull();
    expect(await listDocmosisVersions(prisma, mine.id)).toHaveLength(2);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ docmosis_version: 2, docmosis_revision: 1, docmosis_updated_by: "user" });
    // The agent's own version is untouched.
    expect(await docmosisView(prisma, mine.id, 1)).toMatchObject({ data: { name: "Ada" }, by: "agent" });
  });

  it("should copy name, docx and schema into a new user version when the latest is the session's or another person's", async () => {
    const mine = await chat();
    await agentWrite(mine, 1, { name: "Letter" });
    await personSave(mine, { name: "Bea" }, { version: 1, revision: 0 }, BOB.oid);

    expect(await personSave(mine, { name: "Cy" }, { version: 2, revision: 0 }, ALICE.oid)).toEqual({ version: 3, revision: 0 });

    const [first, third] = [await docmosisView(prisma, mine.id, 1), await docmosisView(prisma, mine.id, 3)];
    expect(third).toMatchObject({ name: "Letter", docx: first!.docx, schema: SCHEMA, by: "user", data: { name: "Cy" } });
  });

  it("should refuse a person's save from a stale base with the current version, and from a conversation with none", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);

    expect(await conflictOf(personSave(mine, {}, { version: 1, revision: 5 }))).toMatchObject({ version: 1, revision: 0 });
    expect(await conflictOf(personSave(mine, {}, { version: 2, revision: 0 }))).toMatchObject({ version: 1 });
    await expect(personSave(await chat(), {}, { version: 0, revision: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(personSave(mine, [] as never, { version: 1, revision: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("should serve concurrent writes from one base as one write and one conflict", async () => {
    const mine = await chat();
    const results = await Promise.allSettled([agentWrite(mine, 1), agentWrite(mine, 2)]);

    expect(results.map((result) => result.status).sort((a, b) => a.localeCompare(b))).toEqual(["fulfilled", "rejected"]);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).docmosisVersion).toBe(1);
  });

  it("should carry the summary to the page", async () => {
    const mine = await chat();
    await agentWrite(mine, 1, { name: "Letter" });
    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });

    expect(docmosisSummary(row)).toEqual({ name: "Letter", version: 1, revision: 0, updatedBy: "agent", pdf: "pending" });
    expect((await conversationView(prisma, row as never, mine.agentId)).docmosis).toEqual({
      name: "Letter",
      version: 1,
      revision: 0,
      updatedBy: "agent",
      pdf: "pending"
    });
    expect(docmosisSummary({ docmosisName: null, docmosisVersion: 0, docmosisRevision: 0, docmosisUpdatedBy: null, docmosisPdfState: "pending" })).toBeNull();
  });
});

async function pdfState(id: string): Promise<string> {
  return (await prisma.assistantConversation.findUniqueOrThrow({ where: { id } })).docmosisPdfState;
}

describe("the docmosis store's renders", () => {
  it("should store a PDF against the version and revision it was made for, and clear an earlier error", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    expect(await storeDocmosisRender(prisma, { conversationId: mine.id, version: 1, revision: 0, error: { short: "bad", long: "worse" } })).toBe(true);
    expect(await docmosisView(prisma, mine.id)).toMatchObject({ has_pdf: false, render_error: { short: "bad", long: "worse" } });
    expect(await pdfState(mine.id)).toBe("failed");

    expect(await storeDocmosisRender(prisma, { conversationId: mine.id, version: 1, revision: 0, pdf: new Uint8Array(PDF) })).toBe(true);

    expect(await docmosisView(prisma, mine.id)).toMatchObject({ has_pdf: true, render_error: null });
    expect(await pdfState(mine.id)).toBe("ready");
    expect(Buffer.from((await readDocmosisPdf(prisma, mine.id, 1))!)).toEqual(PDF);
  });

  it("should ignore a render whose version or revision has moved on", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    await personSave(mine, { name: "Bea" }, { version: 1, revision: 0 });
    await personSave(mine, { name: "Cy" }, { version: 2, revision: 0 });

    expect(await storeDocmosisRender(prisma, { conversationId: mine.id, version: 2, revision: 0, pdf: new Uint8Array(PDF) })).toBe(false);
    expect(await storeDocmosisRender(prisma, { conversationId: mine.id, version: 1, revision: 0, pdf: new Uint8Array(PDF) })).toBe(false);
    expect((await docmosisView(prisma, mine.id))?.has_pdf).toBe(false);
  });

  it("should refuse a PDF over the cap", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);

    await expect(
      storeDocmosisRender(prisma, { conversationId: mine.id, version: 1, revision: 0, pdf: new Uint8Array(5 * 1024 * 1024 + 1) })
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("the docmosis store's retention", () => {
  it("should keep the latest versions, and the PDF of only the latest KEEP_PDF", async () => {
    const mine = await chat();
    const total = KEEP_VERSIONS + 2;
    for (let version = 1; version <= total; version += 1) {
      await agentWrite(mine, version, { base_version: version - 1 });
      await putDocmosisPdf(prisma, mine.id, version, PDF);
    }

    const versions = await listDocmosisVersions(prisma, mine.id);
    expect(versions).toHaveLength(KEEP_VERSIONS);
    expect(versions[0]?.version).toBe(total);
    expect(versions.at(-1)?.version).toBe(total - KEEP_VERSIONS + 1);
    expect(versions.filter((version) => version.has_pdf).map((version) => version.version)).toEqual(Array.from({ length: KEEP_PDF }, (_, at) => total - at));
    expect(await docmosisView(prisma, mine.id, 1)).toBeNull();
  });

  it("should move the PDF state with an uploaded PDF and reset it on the person's next write", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);
    expect(await pdfState(mine.id)).toBe("pending");
    await putDocmosisPdf(prisma, mine.id, 1, PDF);
    expect(await pdfState(mine.id)).toBe("ready");

    await personSave(mine, { a: 1 }, { version: 1, revision: 0 });
    expect(await pdfState(mine.id)).toBe("pending");
  });

  it("should refuse a PDF for a version older than the latest KEEP_PDF, or not yet written", async () => {
    const mine = await chat();
    for (let version = 1; version <= KEEP_PDF + 1; version += 1) {
      await agentWrite(mine, version, { base_version: version - 1 });
    }

    expect(await putDocmosisPdf(prisma, mine.id, 1, PDF)).toBe(false);
    expect(await putDocmosisPdf(prisma, mine.id, 2, PDF)).toBe(true);
    expect(await putDocmosisPdf(prisma, mine.id, KEEP_PDF + 2, PDF)).toBe(false);
  });

  it("should delete a .docx no kept version names once its grace is over, and keep the others", async () => {
    const mine = await chat();
    const start = new Date();
    const orphan = await held(mine, docx(100), new Date(start.getTime() - 2 * ASSET_GRACE_MS));
    const fresh = await held(mine, docx(101), start);
    await agentWrite(mine, 1, {}, start);

    expect(await readDocmosisDocx(prisma, mine.id, orphan)).toBeNull();
    expect(await readDocmosisDocx(prisma, mine.id, fresh)).not.toBeNull();
    expect(await readDocmosisDocx(prisma, mine.id, digest(docx(1)))).not.toBeNull();
  });

  it("should free a .docx when the version naming it is pruned", async () => {
    const mine = await chat();
    for (let version = 1; version <= KEEP_VERSIONS; version += 1) {
      await agentWrite(mine, version, { base_version: version - 1 });
    }
    await ageAssets(mine);
    await agentWrite(mine, KEEP_VERSIONS + 1, { base_version: KEEP_VERSIONS });

    expect(await readDocmosisDocx(prisma, mine.id, digest(docx(1)))).toBeNull();
    expect(await readDocmosisDocx(prisma, mine.id, digest(docx(2)))).not.toBeNull();
  });

  it("should make room for a .docx by dropping the oldest versions, never the latest KEEP_PDF, and refuse when only those would do", async () => {
    const mine = await chat();
    const big = (seed: number) => {
      const bytes = Buffer.alloc(5 * 1024 * 1024);
      bytes.set([0x50, 0x4b, 0x03, 0x04]);
      bytes.writeUInt32BE(seed, 8);
      return bytes;
    };
    const copies = Math.floor(MAX_HELD_DOCX_BYTES / (5 * 1024 * 1024));
    for (let version = 1; version <= copies; version += 1) {
      const sha = await held(mine, big(version));
      await writeAgentDocmosis(prisma, { conversationId: mine.id, body: body(sha, { base_version: version - 1 }) });
    }

    await ageAssets(mine);
    const versionsAfter = async () => (await listDocmosisVersions(prisma, mine.id)).map((entry) => entry.version);

    await held(mine, big(900));
    expect(await versionsAfter()).toEqual(Array.from({ length: copies - 1 }, (_, at) => copies - at));
    expect(await readDocmosisDocx(prisma, mine.id, digest(big(1)))).toBeNull();

    await held(mine, big(901));
    expect(await versionsAfter()).toEqual(Array.from({ length: copies - 2 }, (_, at) => copies - at));

    // What is left to drop is the latest KEEP_PDF, which are never deleted for room.
    await expect(held(mine, big(902))).rejects.toMatchObject({ status: 409 });
    expect(await versionsAfter()).toHaveLength(KEEP_PDF);
  });

  it("should hold the same .docx again without storing it twice", async () => {
    const mine = await chat();
    const bytes = docx(5);

    await putDocmosisAsset(prisma, mine.id, digest(bytes), bytes);
    await putDocmosisAsset(prisma, mine.id, digest(bytes), bytes);

    expect(await prisma.assistantDocmosisAsset.count({ where: { conversationId: mine.id } })).toBe(1);
  });

  it("should delete the template with the conversation", async () => {
    const mine = await chat();
    await agentWrite(mine, 1);

    await prisma.assistantConversation.delete({ where: { id: mine.id } });

    expect(await prisma.assistantDocmosisVersion.count({ where: { conversationId: mine.id } })).toBe(0);
    expect(await prisma.assistantDocmosisAsset.count({ where: { conversationId: mine.id } })).toBe(0);
  });
});
