import { describe, expect, it, vi } from "vitest";
import * as notifyRoute from "../../src/app/api/agent/[agentId]/notify/route.ts";
import { DELETE as deleteItem, GET as getItem, PUT as putItem } from "../../src/app/api/agent/[agentId]/notify-templates/[itemId]/route.ts";
import { GET as getList, POST as postList } from "../../src/app/api/agent/[agentId]/notify-templates/route.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { ITEMS_CREATE_REFUSED_NOTIFY, KEEP_NOTIFY_VERSIONS, type NotifyPut, type NotifySource } from "../../src/assistant/notify.ts";
import { NOTIFY_PULL } from "../../src/assistant/notify-jobs.ts";
import {
  listNotifySummaries,
  listNotifyVersions,
  type NotifyTarget,
  notifyView,
  primaryNotifyView,
  readPrimaryNotifyId,
  writeAgentNotify,
  writeUserNotify
} from "../../src/assistant/notify-store.ts";
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

/** A session's write of the primary template, or of `target`, without the id the store also answers. */
async function agentWrite(of: Chat, overrides: Partial<NotifyPut> = {}, target: NotifyTarget = "primary") {
  const { version, revision } = await writeAgentNotify(prisma, { conversationId: of.id, target, body: put(overrides) });
  return { version, revision };
}

/** A new template, whatever the conversation holds, answered by its id. */
async function newTemplate(of: Chat, overrides: Partial<NotifyPut> = {}): Promise<string> {
  return (await writeAgentNotify(prisma, { conversationId: of.id, target: "new", body: put(overrides) })).id;
}

const primaryId = async (of: Chat): Promise<string> => (await readPrimaryNotifyId(prisma, of.id)) as string;

const personSave = async (
  of: Chat,
  change: { subject?: string | null; body?: string; data?: unknown },
  base: { version: number; revision: number },
  editorOid = ALICE.oid,
  itemId?: string
) =>
  await writeUserNotify(prisma, {
    conversationId: of.id,
    itemId: itemId ?? (await readPrimaryNotifyId(prisma, of.id)) ?? "00000000-0000-4000-8000-000000000000",
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

    const row = await prisma.assistantNotify.findFirstOrThrow({ where: { conversationId: mine.id } });
    expect(row).toMatchObject({ version: 2, revision: 0, name: "Claim received", updatedBy: "agent" });
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).firstContentAt).not.toBeNull();
    expect(await listNotifyVersions(prisma, row.id)).toMatchObject([
      { version: 2, by: "agent", name: "Claim received", notify_version: 4 },
      { version: 1, by: "agent" }
    ]);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 2, notify_revision: 0, notify_updated_by: "agent" });
  });

  it("should record a load from the panel's picker as the person's, with no editor, so their next save is a version of its own", async () => {
    const mine = await chat();

    await agentWrite(mine, { by: "user" });

    expect(await primaryNotifyView(prisma, mine.id)).toMatchObject({ version: 1, by: "user" });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 1, notify_updated_by: "user" });
    expect(await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 })).toEqual({ version: 2, revision: 0, amended: false });
  });

  it("should take a new source as the template replaced, and keep the old version's", async () => {
    const mine = await chat();
    await agentWrite(mine);
    const other = { ...SOURCE, template_id: "ab1f3d4a-0000-4000-8000-000000000003", type: "sms" as const, name: "Reminder", notify_subject: null };

    await agentWrite(mine, { base_version: 1, subject: null, body: "Hi", source: other });

    expect(await primaryNotifyView(prisma, mine.id)).toMatchObject({ version: 2, type: "sms", name: "Reminder", subject: null });
    expect(await primaryNotifyView(prisma, mine.id, 1)).toMatchObject({ type: "email", name: "Claim received" });
    expect((await prisma.assistantNotify.findFirstOrThrow({ where: { conversationId: mine.id } })).name).toBe("Reminder");
  });

  it("should refuse a stale version or revision with the current one, and write nothing", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await personSave(mine, { body: "Mine" }, { version: 1, revision: 0 });

    const staleVersion = await conflictOf(agentWrite(mine, { base_version: 1 }));
    const staleRevision = await conflictOf(agentWrite(mine, { base_version: 2, base_revision: 1 }));
    const empty = await chat();
    const none = await conflictOf(writeAgentNotify(prisma, { conversationId: empty.id, target: "primary", body: put({ base_version: 3 }) }));

    expect(staleVersion).toMatchObject({ version: 2, revision: 0, by: "user" });
    expect(staleRevision).toMatchObject({ version: 2 });
    expect(none).toBeNull();
    expect((await prisma.assistantNotify.findFirstOrThrow({ where: { conversationId: mine.id } })).version).toBe(2);
    expect(await prisma.assistantNotify.count({ where: { conversationId: empty.id } })).toBe(0);
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

    expect(await primaryNotifyView(prisma, mine.id)).toMatchObject({
      version: 2,
      revision: 1,
      by: "user",
      body: "Mine again",
      data: { name: "Ada" },
      summary: "Edited the template",
      ...SOURCE
    });
    expect(await listNotifyVersions(prisma, await primaryId(mine))).toHaveLength(2);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 2, notify_revision: 1, notify_updated_by: "user" });
    expect(await primaryNotifyView(prisma, mine.id, 1)).toMatchObject({ body: "Dear ((name))", by: "agent" });
  });

  it("should copy the source into a new user version when the latest is the session's or another person's", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await personSave(mine, { body: "Bob's" }, { version: 1, revision: 0 }, BOB.oid);

    expect(await personSave(mine, { body: "Alice's" }, { version: 2, revision: 0 }, ALICE.oid)).toEqual({ version: 3, revision: 0, amended: false });
    expect(await primaryNotifyView(prisma, mine.id, 3)).toMatchObject({ ...SOURCE, by: "user", body: "Alice's" });
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
    expect((await prisma.assistantNotify.findFirstOrThrow({ where: { conversationId: mine.id } })).version).toBe(1);
    expect(await prisma.assistantNotify.count({ where: { conversationId: mine.id } })).toBe(1);
  });

  it("should keep the latest versions alone", async () => {
    const mine = await chat();
    for (let version = 0; version < KEEP_NOTIFY_VERSIONS + 2; version += 1) {
      await agentWrite(mine, { base_version: version, body: `v${version + 1}` });
    }

    const kept = await listNotifyVersions(prisma, await primaryId(mine));
    expect(kept).toHaveLength(KEEP_NOTIFY_VERSIONS);
    expect(kept[0]?.version).toBe(KEEP_NOTIFY_VERSIONS + 2);
    expect(kept.at(-1)?.version).toBe(3);
    expect(await primaryNotifyView(prisma, mine.id, 2)).toBeNull();
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

    const summary = { id: await primaryId(mine), name: "Claim received", version: 1, revision: 0, updatedBy: "agent" };
    expect(await listNotifySummaries(prisma, mine.id)).toEqual([summary]);
    expect((await conversationView(prisma, row as never, mine.agentId)).notifyTemplates).toEqual([summary]);
    expect((await sharedConversation(prisma, row as never, "reader"))?.notifyTemplates).toEqual([summary]);
    expect(await listNotifySummaries(prisma, (await chat()).id)).toEqual([]);
  });

  it("should delete the template with the conversation", async () => {
    const mine = await chat();
    await agentWrite(mine);

    await prisma.assistantConversation.delete({ where: { id: mine.id } });

    expect(await prisma.assistantNotifyVersion.count({ where: { conversationId: mine.id } })).toBe(0);
    expect(await prisma.assistantNotify.count({ where: { conversationId: mine.id } })).toBe(0);
  });
});

describe("who may read and change the Notify template", () => {
  it("should let the owner and a share's recipient read it, the owner alone change it, and nobody else see it", async () => {
    const mine = await chat();
    await agentWrite(mine);
    await prisma.assistantConversationShare.create({ data: { conversationId: mine.id, recipientOid: BOB.oid, sharedByOid: ALICE.oid } });

    const item = await primaryId(mine);

    expect(await notifyAccess(viewerOf(ALICE), mine.id, item)).toBe("owner");
    expect(await notifyAccess(viewerOf(BOB), mine.id, item)).toBe("reader");
    expect(await notifyAccess(viewerOf(CAROL), mine.id, item)).toBeUndefined();
    expect(await readableNotify(viewerOf(BOB), mine.id, item)).toMatchObject({ version: 1 });
    expect(await readableNotify(viewerOf(BOB), mine.id, item, 1)).toMatchObject({ version: 1 });
    expect(await readableNotify(viewerOf(CAROL), mine.id, item)).toBeUndefined();
    expect(await notifyVersions(viewerOf(BOB), mine.id, item)).toHaveLength(1);
    expect(await notifyVersions(viewerOf(CAROL), mine.id, item)).toBeUndefined();
  });

  it("should let a reader see every template of the chat, and refuse an id that is another chat's or not an id", async () => {
    const mine = await chat();
    const other = await chat();
    await agentWrite(other);
    await agentWrite(mine);
    const second = await newTemplate(mine, { source: { ...SOURCE, name: "Second" } });
    await prisma.assistantConversationShare.create({ data: { conversationId: mine.id, recipientOid: BOB.oid, sharedByOid: ALICE.oid } });

    expect(await notifyAccess(viewerOf(BOB), mine.id, second)).toBe("reader");
    expect(await notifyAccess(viewerOf(ALICE), mine.id, await primaryId(other))).toBeUndefined();
    expect(await notifyAccess(viewerOf(ALICE), mine.id, "not-an-id")).toBeUndefined();
    const shared = await sharedConversation(prisma, (await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })) as never, "reader");
    expect(shared?.notifyTemplates.map((template) => template.name)).toEqual(["Claim received", "Second"]);
  });

  it("should answer nothing to read for a chat with no Notify template", async () => {
    const mine = await chat();

    expect(await readableNotify(viewerOf(ALICE), mine.id, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect(await notifyVersions(viewerOf(ALICE), mine.id, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});

const OTHER_SOURCE: NotifySource = {
  ...SOURCE,
  template_id: "ab1f3d4a-0000-4000-8000-000000000003",
  type: "sms",
  name: "Hearing reminder",
  notify_subject: null
};
const otherPut = (overrides: Partial<NotifyPut> = {}): Partial<NotifyPut> => ({
  subject: null,
  body: "Your hearing is on ((date))",
  source: OTHER_SOURCE,
  ...overrides
});

async function itemCall(method: "GET" | "PUT" | "DELETE", of: Chat, id: string, query = "", body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/agent/${of.agentId}/notify-templates/${id}${query}`, {
    method,
    headers: { "x-dev-user": devUser(ALICE), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await (method === "GET" ? getItem : method === "PUT" ? putItem : deleteItem)(request, {
    params: Promise.resolve({ agentId: of.agentId, itemId: id })
  });
}

async function listCall(method: "GET" | "POST", of: Chat, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/agent/${of.agentId}/notify-templates`, {
    method,
    headers: { "x-dev-user": devUser(ALICE), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await (method === "GET" ? getList : postList)(request, { params: Promise.resolve({ agentId: of.agentId }) });
}

describe("several Notify templates in one conversation", () => {
  it("should list them oldest first, and keep the single route on the oldest, which the first write makes", async () => {
    const mine = await chat();
    const created = await listCall("POST", mine, put());
    const secondCreated = await listCall("POST", mine, { ...put(), ...otherPut() });

    expect(created.status).toBe(201);
    const first = (await jsonOf(created)) as { id: string; version: number; revision: number };
    const second = (await jsonOf(secondCreated)) as { id: string };
    expect(first).toMatchObject({ version: 1, revision: 0 });
    expect(await jsonOf(await listCall("GET", mine))).toEqual({
      notify_templates: [
        { id: first.id, name: "Claim received", version: 1, revision: 0, updated_by: "agent" },
        { id: second.id, name: "Hearing reminder", version: 1, revision: 0, updated_by: "agent" }
      ]
    });
    expect(await jsonOf(await agent("GET", mine))).toMatchObject({ name: "Claim received" });
    expect(await jsonOf(await agent("PUT", mine, "", { subject: "Edited", body: "Edited", data: {}, base_version: 1 }))).toEqual({ version: 2, revision: 0 });
    expect(await jsonOf(await itemCall("GET", mine, second.id))).toMatchObject({ name: "Hearing reminder", version: 1 });
    expect(await jsonOf(await itemCall("GET", mine, first.id))).toMatchObject({ version: 2, body: "Edited" });
  });

  it("should write, read at a version and conflict on one template without touching another", async () => {
    const mine = await chat();
    const first = await newTemplate(mine);
    const second = await newTemplate(mine, otherPut());

    const written = await itemCall("PUT", mine, second, "", { subject: null, body: "Moved", data: {}, base_version: 1 });
    const stale = await itemCall("PUT", mine, second, "", { subject: null, body: "Again", data: {}, base_version: 1 });
    const older = await itemCall("GET", mine, second, "?version=1");
    const bad = await itemCall("GET", mine, second, "?version=0");

    expect(await jsonOf(written)).toEqual({ version: 2, revision: 0 });
    expect(stale.status).toBe(409);
    expect(await jsonOf(stale)).toMatchObject({ current: { version: 2, body: "Moved" } });
    expect(await jsonOf(older)).toMatchObject({ version: 1, body: "Your hearing is on ((date))", current_version: 2 });
    expect(bad.status).toBe(400);
    expect(await jsonOf(await itemCall("GET", mine, first))).toMatchObject({ version: 1 });
  });

  it("should answer 404 for an id that is not a template of the conversation, another conversation's included", async () => {
    const mine = await chat();
    const other = await chat();
    await agentWrite(mine);
    const foreign = await newTemplate(other);

    expect((await itemCall("GET", mine, foreign)).status).toBe(404);
    expect((await itemCall("PUT", mine, foreign, "", put({ base_version: 1 }))).status).toBe(404);
    expect((await itemCall("DELETE", mine, foreign)).status).toBe(404);
    expect((await itemCall("GET", mine, "nope")).status).toBe(404);
    expect(await prisma.assistantNotify.count({ where: { id: foreign } })).toBe(1);
  });

  it("should refuse a post at any base but 0", async () => {
    const mine = await chat();

    const response = await listCall("POST", mine, put({ base_version: 2 }));

    expect(response.status).toBe(400);
    expect(await prisma.assistantNotify.count({ where: { conversationId: mine.id } })).toBe(0);
  });

  it("should remove a template with its versions, and make the next oldest the primary", async () => {
    const mine = await chat();
    const first = await newTemplate(mine);
    const second = await newTemplate(mine, otherPut());
    await agentWrite(mine, { base_version: 1, source: undefined, body: "v2" });

    const removed = await itemCall("DELETE", mine, first);

    expect(removed.status).toBe(204);
    expect(await prisma.assistantNotifyVersion.count({ where: { itemId: first } })).toBe(0);
    expect(await readPrimaryNotifyId(prisma, mine.id)).toBe(second);
    expect(await jsonOf(await agent("GET", mine))).toMatchObject({ name: "Hearing reminder" });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 1, notify_templates: [{ id: second, name: "Hearing reminder" }] });
  });

  it("should keep each template's own latest versions, whatever the others hold", async () => {
    const mine = await chat();
    const first = await newTemplate(mine);
    const second = await newTemplate(mine, otherPut());
    for (let version = 1; version < KEEP_NOTIFY_VERSIONS + 2; version += 1) {
      await agentWrite(mine, { base_version: version, source: undefined, body: `v${version + 1}` }, { item: first });
    }

    expect(await listNotifyVersions(prisma, first)).toHaveLength(KEEP_NOTIFY_VERSIONS);
    expect(await listNotifyVersions(prisma, second)).toHaveLength(1);
    expect(await notifyView(prisma, mine.id, second, 1)).toMatchObject({ version: 1 });
  });

  it("should refuse a second template for a pod whose client does not claim items, and allow the first and any with the claim", async () => {
    const mine = await chat();
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { status: "running", clientFeatures: ["lookups"] } });

    const first = await listCall("POST", mine, put());
    const second = await listCall("POST", mine, { ...put(), ...otherPut() });
    const primaryWrite = await agent("PUT", mine, "", { subject: "Edited", body: "Edited", data: {}, base_version: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await jsonOf(second)).toEqual({ error: ITEMS_CREATE_REFUSED_NOTIFY });
    expect(primaryWrite.status).toBe(200);
    expect(await prisma.assistantNotify.count({ where: { conversationId: mine.id } })).toBe(1);

    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { clientFeatures: ["lookups", "items", "item-templates"] } });

    expect((await listCall("POST", mine, { ...put(), ...otherPut() })).status).toBe(201);
  });
});

describe("the notify.pull pod job's target", () => {
  const precheck = (of: Chat, args: Record<string, unknown>) =>
    NOTIFY_PULL.precheck?.(prisma, { viewerOid: ALICE.oid, conversationId: of.id, args: { product: "pcs", template_id: SOURCE.template_id, ...args } });

  it("should take a load that makes the first template, or one into the primary, whatever the pod claims", async () => {
    const mine = await chat();
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { status: "running", clientFeatures: ["lookups"] } });

    expect(await precheck(mine, {})).toBeUndefined();
    const first = await newTemplate(mine);
    expect(await precheck(mine, { item_id: first })).toBeUndefined();
  });

  it("should refuse a load into a new template, or into one that is not the primary, for a pod that does not claim items", async () => {
    const mine = await chat();
    await agentWrite(mine);
    const second = await newTemplate(mine, otherPut());
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { status: "running", clientFeatures: ["lookups"] } });

    expect(await precheck(mine, {})).toEqual({ status: 409, error: ITEMS_CREATE_REFUSED_NOTIFY });
    expect(await precheck(mine, { item_id: second })).toEqual({ status: 409, error: ITEMS_CREATE_REFUSED_NOTIFY });

    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { clientFeatures: ["lookups", "items", "item-templates"] } });

    expect(await precheck(mine, {})).toBeUndefined();
    expect(await precheck(mine, { item_id: second })).toBeUndefined();
  });

  it("should refuse a target the conversation does not hold with 404", async () => {
    const mine = await chat();
    const other = await chat();
    await agentWrite(mine);
    const foreign = await newTemplate(other);

    expect(await precheck(mine, { item_id: foreign })).toMatchObject({ status: 404 });
    expect(await precheck(mine, { item_id: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ status: 404 });
  });

  it("should write a load by the person into a target as that template's next version, and into a new template when none is named", async () => {
    const mine = await chat();
    const first = await newTemplate(mine);

    const next = await writeAgentNotify(prisma, { conversationId: mine.id, target: { item: first }, body: put({ base_version: 1, by: "user" }) });
    const fresh = await writeAgentNotify(prisma, { conversationId: mine.id, target: "new", body: put({ by: "user", ...otherPut() }) });

    expect(next).toMatchObject({ id: first, version: 2 });
    expect(fresh.id).not.toBe(first);
    expect(await listNotifySummaries(prisma, mine.id)).toMatchObject([
      { id: first, version: 2, updatedBy: "user" },
      { id: fresh.id, version: 1, updatedBy: "user" }
    ]);
  });
});

describe("the frame's Notify templates", () => {
  it("should list every template oldest first, and report the oldest's fields for a client that reads one", async () => {
    const mine = await chat();
    const first = await newTemplate(mine);
    const second = await newTemplate(mine, otherPut());
    await personSave(mine, { subject: null, body: "Mine" }, { version: 1, revision: 0 }, ALICE.oid, second);

    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({
      notify_version: 1,
      notify_updated_by: "agent",
      notify_templates: [
        { id: first, name: "Claim received", version: 1, revision: 0, updated_by: "agent" },
        { id: second, name: "Hearing reminder", version: 2, revision: 0, updated_by: "user" }
      ]
    });
  });

  it("should say no template before there is one", async () => {
    const mine = await chat();

    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ notify_version: 0, notify_revision: 0, notify_updated_by: null, notify_templates: [] });
  });
});
