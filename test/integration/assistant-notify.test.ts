import { describe, expect, it, vi } from "vitest";
import * as notifyRoute from "../../src/app/api/agent/[agentId]/notify/route.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { KEEP_NOTIFY_VERSIONS, type NotifyPut, type NotifySource } from "../../src/assistant/notify.ts";
import { listNotifyVersions, notifySummary, notifyView, writeAgentNotify, writeUserNotify } from "../../src/assistant/notify-store.ts";
import { sharedConversation } from "../../src/assistant/sharing.ts";
import { conversationView } from "../../src/assistant/views.ts";
import { notifyAccess, notifyVersions, readableNotify } from "../../src/web/data.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { devUser, prisma } from "./database.ts";
import { ALICE, BOB, CAROL, type Chat, chat, viewerOf } from "./deck-chats.ts";
import { jsonOf } from "./routes.ts";

/**
 * A conversation's GOV.UK Notify template: the session writes versions through the agent API, the person's saves amend
 * or extend them, and every write keeps the newest versions.
 */

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

assistantSuite([ALICE, BOB, CAROL]);

const SOURCE: NotifySource = {
  product: "pcs",
  template_id: "ab1f3d4a-0000-4000-8000-000000000002",
  service_id: "5c1f3d4a-0000-4000-8000-000000000001",
  type: "email",
  name: "Claim received",
  notify_version: 4,
  notify_subject: "Claim ((ref))",
  notify_body: "Dear ((name))",
  notify_preview: "<p>Dear ((name))</p>"
};

const put = (overrides: Partial<NotifyPut> = {}): NotifyPut => ({
  subject: SOURCE.notify_subject,
  body: SOURCE.notify_body,
  data: {},
  base_version: 0,
  source: SOURCE,
  ...overrides
});

const agentWrite = (of: Chat, overrides: Partial<NotifyPut> = {}) => writeAgentNotify(prisma, { conversationId: of.id, body: put(overrides) });

const personSave = (
  of: Chat,
  change: { subject?: string | null; body?: string; data?: unknown },
  base: { version: number; revision: number },
  editorOid = ALICE.oid
) =>
  writeUserNotify(prisma, {
    conversationId: of.id,
    editorOid,
    subject: change.subject === undefined ? SOURCE.notify_subject : change.subject,
    body: change.body ?? SOURCE.notify_body,
    data: change.data ?? {},
    baseVersion: base.version,
    baseRevision: base.revision
  });

async function conflictOf(call: Promise<unknown>) {
  const error = (await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  )) as { status: number; extra: { current: unknown } } | undefined;
  expect(error?.status).toBe(409);
  return error!.extra.current as { version: number; revision: number; by: string } | null;
}

async function agent(method: "GET" | "PUT", of: Chat, query = "", body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/agent/${of.agentId}/notify${query}`, {
    method,
    headers: { "x-dev-user": devUser(ALICE), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await (method === "GET" ? notifyRoute.GET : notifyRoute.PUT)(request, { params: Promise.resolve({ agentId: of.agentId }) });
}

describe("the notify route", () => {
  it("should write a version, read it back, and refuse a stale base with the current one", async () => {
    const mine = await chat();

    expect((await agent("GET", mine)).status).toBe(404);
    const written = await agent("PUT", mine, "", { ...put(), source: { ...SOURCE, template_id: SOURCE.template_id.toUpperCase() } });
    expect(await jsonOf(written)).toEqual({ version: 1, revision: 0 });

    const read = await agent("GET", mine);
    expect(await jsonOf(read)).toMatchObject({
      version: 1,
      revision: 0,
      ...SOURCE,
      subject: "Claim ((ref))",
      body: "Dear ((name))",
      data: {},
      by: "agent",
      summary: null
    });

    const stale = await agent("PUT", mine, "", put());
    expect(stale.status).toBe(409);
    expect(await jsonOf(stale)).toMatchObject({ current: { version: 1 } });

    const edit = await agent("PUT", mine, "", { subject: "Your claim", body: "Hello", data: { name: "Ada" }, base_version: 1, summary: "Shorter" });
    expect(await jsonOf(edit)).toEqual({ version: 2, revision: 0 });
    expect(await jsonOf(await agent("GET", mine, "?version=1"))).toMatchObject({ version: 1, body: "Dear ((name))", current_version: 2 });
    expect(await jsonOf(await agent("GET", mine))).toMatchObject({ version: 2, body: "Hello", data: { name: "Ada" }, summary: "Shorter", ...SOURCE });
  });

  it("should refuse a first version with no source, a subject that does not fit, and a version that is not one", async () => {
    const mine = await chat();

    const noSource = await agent("PUT", mine, "", { subject: "x", body: "y", data: {}, base_version: 0 });
    const textWithSubject = await agent("PUT", mine, "", put({ source: { ...SOURCE, type: "sms", notify_subject: null } }));
    const badVersion = await agent("GET", mine, "?version=0");
    await agentWrite(mine);
    const missing = await agent("GET", mine, "?version=7");

    expect(noSource.status).toBe(400);
    expect(await jsonOf(noSource)).toMatchObject({ error: expect.stringMatching(/source is needed/) });
    expect(textWithSubject.status).toBe(400);
    expect(badVersion.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});

describe("the notify store", () => {
  it("should write each agent version as the next, at revision 0, onto the conversation's row and frame", async () => {
    const mine = await chat();

    expect(await agentWrite(mine)).toEqual({ version: 1, revision: 0 });
    expect(await agentWrite(mine, { base_version: 1, base_revision: 0, source: undefined, body: "Edited" })).toEqual({ version: 2, revision: 0 });

    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row).toMatchObject({ notifyVersion: 2, notifyRevision: 0, notifyName: "Claim received", notifyUpdatedBy: "agent" });
    expect(row.firstContentAt).not.toBeNull();
    expect(await listNotifyVersions(prisma, mine.id)).toMatchObject([
      { version: 2, by: "agent", name: "Claim received", notify_version: 4 },
      { version: 1, by: "agent" }
    ]);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 2, notify_revision: 0, notify_updated_by: "agent" });
  });

  it("should record a load from the panel's picker as the person's, with no editor, so their next save is a version of its own", async () => {
    const mine = await chat();

    await agentWrite(mine, { by: "user" });

    expect(await notifyView(prisma, mine.id)).toMatchObject({ version: 1, by: "user" });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 1, notify_updated_by: "user" });
    expect(await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 })).toEqual({ version: 2, revision: 0, amended: false });
  });

  it("should take a new source as the template replaced, and keep the old version's", async () => {
    const mine = await chat();
    await agentWrite(mine);
    const other = { ...SOURCE, template_id: "ab1f3d4a-0000-4000-8000-000000000003", type: "sms" as const, name: "Reminder", notify_subject: null };

    await agentWrite(mine, { base_version: 1, subject: null, body: "Hi", source: other });

    expect(await notifyView(prisma, mine.id)).toMatchObject({ version: 2, type: "sms", name: "Reminder", subject: null });
    expect(await notifyView(prisma, mine.id, 1)).toMatchObject({ type: "email", name: "Claim received" });
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).notifyName).toBe("Reminder");
  });

  it("should refuse a stale version or revision with the current one, and write nothing", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 });

    const staleVersion = await conflictOf(agentWrite(mine, { base_version: 1 }));
    const staleRevision = await conflictOf(agentWrite(mine, { base_version: 2, base_revision: 1 }));
    const none = await conflictOf(writeAgentNotify(prisma, { conversationId: (await chat()).id, body: put({ base_version: 3 }) }));

    expect(staleVersion).toMatchObject({ version: 2, revision: 0, by: "user" });
    expect(staleRevision).toMatchObject({ version: 2 });
    expect(none).toBeNull();
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).notifyVersion).toBe(2);
  });

  it("should refuse an edit whose subject does not fit the template it keeps", async () => {
    const mine = await chat();
    await agentWrite(mine);

    await expect(agentWrite(mine, { base_version: 1, source: undefined, subject: null })).rejects.toMatchObject({ status: 400 });
    await expect(personSave(mine, { subject: null }, { version: 1, revision: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("should write over the person's amend when the put sends no base_revision", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 });
    await personSave(mine, { body: "Mine again" }, { version: 2, revision: 0 });

    expect(await agentWrite(mine, { base_version: 2, source: undefined })).toEqual({ version: 3, revision: 0 });
  });

  it("should amend the person's own latest version in place", async () => {
    const mine = await chat();
    await agentWrite(mine);
    expect(await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 })).toEqual({ version: 2, revision: 0, amended: false });

    expect(await personSave(mine, { body: "Mine again", data: { name: "Ada" } }, { version: 2, revision: 0 })).toEqual({
      version: 2,
      revision: 1,
      amended: true
    });

    expect(await notifyView(prisma, mine.id)).toMatchObject({
      version: 2,
      revision: 1,
      by: "user",
      body: "Mine again",
      data: { name: "Ada" },
      summary: "Edited the template",
      ...SOURCE
    });
    expect(await listNotifyVersions(prisma, mine.id)).toHaveLength(2);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 2, notify_revision: 1, notify_updated_by: "user" });
    expect(await notifyView(prisma, mine.id, 1)).toMatchObject({ body: "Dear ((name))", by: "agent" });
  });

  it("should copy the source into a new user version when the latest is the session's or another person's", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await personSave(mine, { body: "Bob's" }, { version: 1, revision: 0 }, BOB.oid);

    expect(await personSave(mine, { body: "Alice's" }, { version: 2, revision: 0 }, ALICE.oid)).toEqual({ version: 3, revision: 0, amended: false });
    expect(await notifyView(prisma, mine.id, 3)).toMatchObject({ ...SOURCE, by: "user", body: "Alice's" });
  });

  it("should refuse a person's save from a stale base, from a conversation with none, and of data it cannot hold", async () => {
    const mine = await chat();
    await agentWrite(mine);

    expect(await conflictOf(personSave(mine, {}, { version: 1, revision: 5 }))).toMatchObject({ version: 1, revision: 0 });
    expect(await conflictOf(personSave(mine, {}, { version: 2, revision: 0 }))).toMatchObject({ version: 1 });
    await expect(personSave(await chat(), {}, { version: 1, revision: 0 })).rejects.toMatchObject({ status: 404 });
    await expect(personSave(mine, { data: [] }, { version: 1, revision: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("should serve concurrent writes from one base as one write and one conflict", async () => {
    const mine = await chat();
    const results = await Promise.allSettled([agentWrite(mine), agentWrite(mine)]);

    expect(results.map((result) => result.status).sort((a, b) => a.localeCompare(b))).toEqual(["fulfilled", "rejected"]);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).notifyVersion).toBe(1);
  });

  it("should keep the latest versions alone", async () => {
    const mine = await chat();
    for (let version = 0; version < KEEP_NOTIFY_VERSIONS + 2; version += 1) {
      await agentWrite(mine, { base_version: version, body: `v${version + 1}` });
    }

    const kept = await listNotifyVersions(prisma, mine.id);
    expect(kept).toHaveLength(KEEP_NOTIFY_VERSIONS);
    expect(kept[0]?.version).toBe(KEEP_NOTIFY_VERSIONS + 2);
    expect(kept.at(-1)?.version).toBe(3);
    expect(await notifyView(prisma, mine.id, 2)).toBeNull();
  });

  it("should refuse what the migration's checks refuse even when a caller skips the body's checks", async () => {
    const mine = await chat();

    await expect(agentWrite(mine, { source: { ...SOURCE, product: "-x" } })).rejects.toThrow();
    await expect(agentWrite(mine, { body: "x".repeat(40_001) })).rejects.toThrow();
  });

  it("should carry the summary to the owner's page and a shared chat's", async () => {
    const mine = await chat();
    await agentWrite(mine);
    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });

    const summary = { name: "Claim received", version: 1, revision: 0, updatedBy: "agent" };
    expect(notifySummary(row)).toEqual(summary);
    expect((await conversationView(prisma, row as never, mine.agentId)).notify).toEqual(summary);
    expect((await sharedConversation(prisma, row as never, "reader"))?.notify).toEqual(summary);
    expect(notifySummary({ notifyName: null, notifyVersion: 0, notifyRevision: 0, notifyUpdatedBy: null })).toBeNull();
  });

  it("should delete the template with the conversation", async () => {
    const mine = await chat();
    await agentWrite(mine);

    await prisma.assistantConversation.delete({ where: { id: mine.id } });

    expect(await prisma.assistantNotifyVersion.count({ where: { conversationId: mine.id } })).toBe(0);
  });
});

describe("who may read and change the Notify template", () => {
  it("should let the owner and a share's recipient read it, the owner alone change it, and nobody else see it", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await prisma.assistantConversationShare.create({ data: { conversationId: mine.id, recipientOid: BOB.oid, sharedByOid: ALICE.oid } });

    expect(await notifyAccess(viewerOf(ALICE), mine.id)).toBe("owner");
    expect(await notifyAccess(viewerOf(BOB), mine.id)).toBe("reader");
    expect(await notifyAccess(viewerOf(CAROL), mine.id)).toBeUndefined();
    expect(await readableNotify(viewerOf(BOB), mine.id)).toMatchObject({ version: 1 });
    expect(await readableNotify(viewerOf(BOB), mine.id, 1)).toMatchObject({ version: 1 });
    expect(await readableNotify(viewerOf(CAROL), mine.id)).toBeUndefined();
    expect(await notifyVersions(viewerOf(BOB), mine.id)).toHaveLength(1);
    expect(await notifyVersions(viewerOf(CAROL), mine.id)).toBeUndefined();
  });

  it("should answer nothing to read for a chat with no Notify template", async () => {
    const mine = await chat();

    expect(await readableNotify(viewerOf(ALICE), mine.id)).toBeUndefined();
    expect(await notifyVersions(viewerOf(ALICE), mine.id)).toBeUndefined();
  });
});
