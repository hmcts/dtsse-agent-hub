import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { OLDEST_FIRST, podLacksItems } from "./artefact-store.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { versionParam } from "./deck-build.ts";
import { lockConversation } from "./deck-store.ts";
import {
  checkNotifyData,
  ITEMS_CREATE_REFUSED_NOTIFY,
  KEEP_NOTIFY_VERSIONS,
  type NotifyAuthor,
  type NotifyPut,
  type NotifySource,
  type NotifyType,
  subjectFits,
  subjectRefusal
} from "./notify.ts";

/**
 * A conversation's GOV.UK Notify templates, any number of them, each written in versions the way its Docmosis template
 * is (`docmosis-store.ts`): a write names the version and revision it was made from, and a newer one refuses it with
 * what is there now. Every write keeps the template's newest `KEEP_NOTIFY_VERSIONS` versions, in its own transaction,
 * and locks the conversation's row. The primary template is the conversation's oldest, which `/api/agent/{id}/notify`
 * and every client older than several templates read. See "Notify templates" in docs/agent-api.md.
 */

type Conversation = Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">;

export interface NotifyResponse {
  version: number;
  revision: number;
  product: string;
  template_id: string;
  service_id: string;
  type: NotifyType;
  name: string;
  subject: string | null;
  body: string;
  notify_version: number;
  notify_subject: string | null;
  notify_body: string;
  notify_preview: string | null;
  data: Record<string, unknown>;
  by: NotifyAuthor;
  summary: string | null;
  updated_at: string;
  /** Only when a version other than the latest was asked for. */
  current_version?: number;
}

export interface NotifyVersionEntry {
  version: number;
  by: NotifyAuthor;
  name: string;
  notify_version: number;
  summary: string | null;
  updated_at: string;
}

export const NOTIFY_SELECT = { id: true, name: true, version: true, revision: true, updatedBy: true } as const;

const author = (value: string | null): NotifyAuthor | null => (value === "user" || value === "agent" ? value : null);

export function notifyAuthor(row: { updatedBy: string | null }): NotifyAuthor | null {
  return author(row.updatedBy);
}

/** What a page carries about the latest version of a Notify template; the panel reads the rest itself. */
export interface NotifySummary {
  id: string;
  name: string;
  version: number;
  revision: number;
  updatedBy: NotifyAuthor;
}

/** From a template's row (`NOTIFY_SELECT`); `null` for one with no version. */
export function notifySummary(row: { id: string; name: string | null; version: number; revision: number; updatedBy: string | null }): NotifySummary | null {
  const updatedBy = author(row.updatedBy);
  if (row.version === 0 || row.name === null || updatedBy === null) {
    return null;
  }
  return { id: row.id, name: row.name, version: row.version, revision: row.revision, updatedBy };
}

/** Every Notify template of the conversation, oldest first, which is the order the switcher lists them in. */
export async function listNotifySummaries(db: Database, conversationId: string): Promise<NotifySummary[]> {
  const rows = await db.assistantNotify.findMany({ where: { conversationId }, select: NOTIFY_SELECT, orderBy: [...OLDEST_FIRST] });
  return rows.flatMap((row) => notifySummary(row) ?? []);
}

/** The conversation's primary Notify template: its oldest, which `/notify` and an older client read. */
export async function readPrimaryNotifyId(db: Database, conversationId: string): Promise<string | undefined> {
  const row = await db.assistantNotify.findFirst({ where: { conversationId }, select: { id: true }, orderBy: [...OLDEST_FIRST] });
  return row?.id;
}

interface VersionRow {
  version: number;
  revision: number;
  product: string;
  template_id: string;
  service_id: string;
  type: string;
  name: string;
  subject: string | null;
  body: string;
  notify_version: number;
  notify_subject: string | null;
  notify_body: string;
  notify_preview: string | null;
  data: Record<string, unknown>;
  by: string;
  summary: string | null;
  updated_at: Date;
}

const typeOf = (value: string): NotifyType => (value === "sms" || value === "letter" ? value : "email");

const responseOf = (row: VersionRow): NotifyResponse => ({
  version: row.version,
  revision: row.revision,
  product: row.product,
  template_id: row.template_id,
  service_id: row.service_id,
  type: typeOf(row.type),
  name: row.name,
  subject: row.subject,
  body: row.body,
  notify_version: row.notify_version,
  notify_subject: row.notify_subject,
  notify_body: row.notify_body,
  notify_preview: row.notify_preview,
  data: row.data,
  by: row.by === "user" ? "user" : "agent",
  summary: row.summary,
  updated_at: row.updated_at.toISOString()
});

/** The template's latest version, 0 when the conversation has no template of that id. */
async function latestVersion(db: Database, conversationId: string, itemId: string): Promise<number> {
  const row = await db.assistantNotify.findFirst({ where: { id: itemId, conversationId }, select: { version: true } });
  return row?.version ?? 0;
}

async function versionRow(db: Database, itemId: string, version: number): Promise<VersionRow | undefined> {
  const [row] = await db.$queryRaw<VersionRow[]>`
    SELECT version, revision, product, template_id::text AS template_id, service_id::text AS service_id, type, name, subject, body,
           notify_version, notify_subject, notify_body, notify_preview, data, by, summary, updated_at
      FROM assistant_notify_version
     WHERE item_id = ${itemId}::uuid AND version = ${version}::int
  `;
  return row;
}

/** The latest version of the template, or `version` when it is kept; `null` for a conversation without that template and for a version not kept. */
export async function notifyView(db: Database, conversationId: string, itemId: string, version?: number): Promise<NotifyResponse | null> {
  const latest = await latestVersion(db, conversationId, itemId);
  if (latest === 0) {
    return null;
  }
  const row = await versionRow(db, itemId, version ?? latest);
  if (row === undefined) {
    return null;
  }
  return version === undefined || version === latest ? responseOf(row) : { ...responseOf(row), current_version: latest };
}

/** What `/notify` answers: the primary template, as `notifyView` answers it; `null` for a conversation with none. */
export async function primaryNotifyView(db: Database, conversationId: string, version?: number): Promise<NotifyResponse | null> {
  const id = await readPrimaryNotifyId(db, conversationId);
  return id === undefined ? null : await notifyView(db, conversationId, id, version);
}

/** Every kept version of the template, newest first. */
export async function listNotifyVersions(db: Database, itemId: string): Promise<NotifyVersionEntry[]> {
  const rows = await db.$queryRaw<Pick<VersionRow, "version" | "by" | "name" | "notify_version" | "summary" | "updated_at">[]>`
    SELECT version, by, name, notify_version, summary, updated_at
      FROM assistant_notify_version WHERE item_id = ${itemId}::uuid ORDER BY version DESC
  `;
  return rows.map((row) => ({
    version: row.version,
    by: row.by === "user" ? "user" : "agent",
    name: row.name,
    notify_version: row.notify_version,
    summary: row.summary,
    updated_at: row.updated_at.toISOString()
  }));
}

async function prune(db: Database, itemId: string, latest: number): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_notify_version WHERE item_id = ${itemId}::uuid AND version <= ${latest - KEEP_NOTIFY_VERSIONS}::int
  `;
}

async function conversationOf(db: Database, conversationId: string): Promise<Conversation> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { id: true, virtualAgentId: true, ownerOid: true } });
  if (row === null) {
    throw new HttpError(404, "no such conversation");
  }
  return row;
}

async function conflict(db: Database, conversationId: string, itemId: string): Promise<HttpError> {
  return new HttpError(409, "the Notify template has changed since that version", { current: await notifyView(db, conversationId, itemId) });
}

const MISSING = "the conversation has no such Notify template";

/** The source of `version`, which a write without a source of its own takes on. */
async function sourceOf(db: Database, itemId: string, version: number): Promise<NotifySource> {
  const row = await versionRow(db, itemId, version);
  if (row === undefined) {
    throw new HttpError(404, MISSING);
  }
  return {
    product: row.product,
    template_id: row.template_id,
    service_id: row.service_id,
    type: typeOf(row.type),
    name: row.name,
    notify_version: row.notify_version,
    notify_subject: row.notify_subject,
    notify_body: row.notify_body,
    notify_preview: row.notify_preview
  };
}

async function insertVersion(
  db: Database,
  {
    conversationId,
    itemId,
    version,
    source,
    subject,
    body,
    data,
    by,
    editorOid,
    summary,
    now
  }: {
    conversationId: string;
    itemId: string;
    version: number;
    source: NotifySource;
    subject: string | null;
    body: string;
    data: string;
    by: NotifyAuthor;
    editorOid: string | null;
    summary: string | null;
    now: Date;
  }
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO assistant_notify_version (conversation_id, item_id, version, revision, product, template_id, service_id, type, name, subject, body,
                                          notify_version, notify_subject, notify_body, notify_preview, data, by, editor_oid, summary, updated_at)
    VALUES (${conversationId}::uuid, ${itemId}::uuid, ${version}::int, 0, ${source.product}, ${source.template_id}::uuid, ${source.service_id}::uuid, ${source.type},
            ${source.name}, ${subject}, ${body}, ${source.notify_version}::int, ${source.notify_subject}, ${source.notify_body}, ${source.notify_preview},
            ${data}::jsonb, ${by}, ${editorOid}, ${summary}, ${now})
  `;
}

/** Which template a session's write is of: one by id, the primary (made when there is none), or a new one. */
export type NotifyTarget = { item: string } | "primary" | "new";

/** A new template's row, at version 0 until the write that makes it has run in the same transaction. Refused for a second one on a pod that reads only the primary. */
async function insertNotify(tx: Database, conversation: Conversation, now: Date): Promise<string> {
  if ((await tx.assistantNotify.count({ where: { conversationId: conversation.id } })) > 0 && (await podLacksItems(tx, conversation))) {
    throw new HttpError(409, ITEMS_CREATE_REFUSED_NOTIFY);
  }
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO assistant_notify (conversation_id, version, created_at) VALUES (${conversation.id}::uuid, 0, ${now}) RETURNING id::text AS id
  `;
  return (row as { id: string }).id;
}

/**
 * Writes a new version by the session, or by the person for a put with `by: "user"`, if `base_version` is still the
 * template's version, and `base_revision`, when given, its revision; otherwise `HttpError(409, {current})`. A put
 * with no `source` keeps the latest version's, so an edit of the draft names only what it changes. `target` is the
 * template: one by id, the primary, which a write at base 0 makes while there is none, or a new one, which a pod that
 * reads only the primary is refused (`ITEMS_CREATE_REFUSED_NOTIFY`). Announced.
 */
export async function writeAgentNotify(
  prisma: PrismaClient,
  { conversationId, target, body, now = new Date() }: { conversationId: string; target: NotifyTarget; body: NotifyPut; now?: Date }
): Promise<{ id: string; version: number; revision: number }> {
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    let id: string | undefined;
    if (target === "new") {
      id = await insertNotify(tx, conversation, now);
    } else if (target === "primary") {
      id = (await readPrimaryNotifyId(tx, conversationId)) ?? (await insertNotify(tx, conversation, now));
    } else {
      id = (await tx.assistantNotify.findFirst({ where: { id: target.item, conversationId }, select: { id: true } }))?.id;
      if (id === undefined) {
        throw new HttpError(404, MISSING);
      }
    }
    const held = await tx.assistantNotify.findUniqueOrThrow({ where: { id }, select: { version: true, revision: true } });
    if (held.version !== body.base_version || (body.base_revision !== undefined && held.revision !== body.base_revision)) {
      throw await conflict(tx, conversationId, id);
    }
    const source = body.source ?? (await sourceOf(tx, id, held.version));
    if (!subjectFits(source.type, body.subject)) {
      throw new HttpError(400, subjectRefusal(source.type));
    }
    const version = held.version + 1;
    await insertVersion(tx, {
      conversationId,
      itemId: id,
      version,
      source,
      subject: body.subject,
      body: body.body,
      data: JSON.stringify(body.data),
      by: body.by ?? "agent",
      editorOid: null,
      summary: body.summary ?? null,
      now
    });
    await tx.$executeRaw`
      UPDATE assistant_notify
         SET version = ${version}::int, revision = 0, name = ${source.name}, updated_by = ${body.by ?? "agent"}, updated_at = ${now}
       WHERE id = ${id}::uuid
    `;
    await touchConversation(tx, conversationId, now);
    await prune(tx, id, version);
    await announce(tx, conversation);
    return { id, version, revision: 0 };
  });
}

/** A template is something in the chat, so the first write of one records the conversation's first content. */
async function touchConversation(tx: Database, conversationId: string, now: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE assistant_conversation SET first_content_at = COALESCE(first_content_at, ${now}), updated_at = ${now} WHERE id = ${conversationId}::uuid
  `;
}

export const EDITED_NOTIFY_SUMMARY = "Edited the template";

/**
 * The person's save of the draft of template `itemId`, if it is still at `baseVersion` and `baseRevision`; otherwise
 * `HttpError(409, {current})`. It amends the latest version in place when that is this person's own, and otherwise
 * writes the next version, `by: user`, from the latest one's source. Announced.
 */
export async function writeUserNotify(
  prisma: PrismaClient,
  {
    conversationId,
    itemId,
    editorOid,
    subject,
    body,
    data,
    baseVersion,
    baseRevision,
    now = new Date()
  }: {
    conversationId: string;
    itemId: string;
    editorOid: string;
    subject: string | null;
    body: string;
    data: unknown;
    baseVersion: number;
    baseRevision: number;
    now?: Date;
  }
): Promise<{ version: number; revision: number; amended: boolean }> {
  const checked = checkNotifyData(data);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const stored = JSON.stringify(checked.value);
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const held = await tx.assistantNotify.findFirst({ where: { id: itemId, conversationId }, select: { version: true, revision: true } });
    if (held === null || held.version === 0) {
      throw new HttpError(404, MISSING);
    }
    if (held.version !== baseVersion || held.revision !== baseRevision) {
      throw await conflict(tx, conversationId, itemId);
    }
    const latest = await tx.assistantNotifyVersion.findUniqueOrThrow({
      where: { itemId_version: { itemId, version: baseVersion } },
      select: { by: true, editorOid: true, type: true }
    });
    const type = typeOf(latest.type);
    if (!subjectFits(type, subject)) {
      throw new HttpError(400, subjectRefusal(type));
    }
    if (latest.by === "user" && latest.editorOid === editorOid) {
      const revision = baseRevision + 1;
      await tx.$executeRaw`
        UPDATE assistant_notify_version
           SET subject = ${subject}, body = ${body}, data = ${stored}::jsonb, revision = ${revision}::int, updated_at = ${now}
         WHERE item_id = ${itemId}::uuid AND version = ${baseVersion}::int
      `;
      await tx.$executeRaw`
        UPDATE assistant_notify SET revision = ${revision}::int, updated_by = 'user', updated_at = ${now} WHERE id = ${itemId}::uuid
      `;
      await tx.$executeRaw`UPDATE assistant_conversation SET updated_at = ${now} WHERE id = ${conversationId}::uuid`;
      await announce(tx, conversation);
      return { version: baseVersion, revision, amended: true };
    }
    const source = await sourceOf(tx, itemId, baseVersion);
    const version = baseVersion + 1;
    await insertVersion(tx, {
      conversationId,
      itemId,
      version,
      source,
      subject,
      body,
      data: stored,
      by: "user",
      editorOid,
      summary: EDITED_NOTIFY_SUMMARY,
      now
    });
    await tx.$executeRaw`
      UPDATE assistant_notify
         SET version = ${version}::int, revision = 0, name = ${source.name}, updated_by = 'user', updated_at = ${now}
       WHERE id = ${itemId}::uuid
    `;
    await tx.$executeRaw`UPDATE assistant_conversation SET updated_at = ${now} WHERE id = ${conversationId}::uuid`;
    await prune(tx, itemId, version);
    await announce(tx, conversation);
    return { version, revision: 0, amended: false };
  });
}

/** Removes a template and its versions. */
export async function removeNotify(prisma: PrismaClient, conversation: Conversation, itemId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantNotify.deleteMany({ where: { id: itemId, conversationId: conversation.id } });
    if (count === 0) {
      throw new HttpError(404, MISSING);
    }
    await announce(tx, conversation);
  });
}

/** One entry of `GET /notify-templates`: a template without its text. */
export function notifySummaryJson(summary: NotifySummary) {
  return { id: summary.id, name: summary.name, version: summary.version, revision: summary.revision, updated_by: summary.updatedBy };
}

/** The `?version=N` of a read: `undefined` for the latest, and a 400 for anything that is not a version number. */
export function askedNotifyVersion(request: Request): number | undefined {
  const asked = new URL(request.url).searchParams.get("version");
  if (asked === null) {
    return undefined;
  }
  const version = versionParam(asked);
  if (version === undefined) {
    throw new HttpError(400, "the version must be a whole number from 1");
  }
  return version;
}
