import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { lockConversation } from "./deck-store.ts";
import {
  checkNotifyData,
  KEEP_NOTIFY_VERSIONS,
  type NotifyAuthor,
  type NotifyPut,
  type NotifySource,
  type NotifyType,
  subjectFits,
  subjectRefusal
} from "./notify.ts";

/**
 * A conversation's GOV.UK Notify template, written in versions the way its Docmosis template is (`docmosis-store.ts`):
 * a write names the version and revision it was made from, and a newer one refuses it with what is there now. Every
 * write keeps the newest `KEEP_NOTIFY_VERSIONS` versions, in its own transaction, and locks the conversation's row. See
 * "Notify templates" in docs/agent-api.md.
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

export const NOTIFY_SELECT = { notifyName: true, notifyVersion: true, notifyRevision: true, notifyUpdatedBy: true } as const;

const author = (value: string | null): NotifyAuthor | null => (value === "user" || value === "agent" ? value : null);

export function notifyAuthor(row: { notifyUpdatedBy: string | null }): NotifyAuthor | null {
  return author(row.notifyUpdatedBy);
}

/** What a page carries about the latest version of a Notify template; the panel reads the rest itself. */
export interface NotifySummary {
  name: string;
  version: number;
  revision: number;
  updatedBy: NotifyAuthor;
}

/** From the conversation's Notify columns (`NOTIFY_SELECT`); `null` for a conversation with no Notify template. */
export function notifySummary(row: {
  notifyName: string | null;
  notifyVersion: number;
  notifyRevision: number;
  notifyUpdatedBy: string | null;
}): NotifySummary | null {
  const updatedBy = author(row.notifyUpdatedBy);
  if (row.notifyVersion === 0 || row.notifyName === null || updatedBy === null) {
    return null;
  }
  return { name: row.notifyName, version: row.notifyVersion, revision: row.notifyRevision, updatedBy };
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

async function latestVersion(db: Database, conversationId: string): Promise<number> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { notifyVersion: true } });
  return row?.notifyVersion ?? 0;
}

async function versionRow(db: Database, conversationId: string, version: number): Promise<VersionRow | undefined> {
  const [row] = await db.$queryRaw<VersionRow[]>`
    SELECT version, revision, product, template_id::text AS template_id, service_id::text AS service_id, type, name, subject, body,
           notify_version, notify_subject, notify_body, notify_preview, data, by, summary, updated_at
      FROM assistant_notify_version
     WHERE conversation_id = ${conversationId}::uuid AND version = ${version}::int
  `;
  return row;
}

/** The latest version, or `version` when it is kept; `null` for a conversation with no Notify template and for a version not kept. */
export async function notifyView(db: Database, conversationId: string, version?: number): Promise<NotifyResponse | null> {
  const latest = await latestVersion(db, conversationId);
  if (latest === 0) {
    return null;
  }
  const row = await versionRow(db, conversationId, version ?? latest);
  if (row === undefined) {
    return null;
  }
  return version === undefined || version === latest ? responseOf(row) : { ...responseOf(row), current_version: latest };
}

/** Every kept version, newest first. */
export async function listNotifyVersions(db: Database, conversationId: string): Promise<NotifyVersionEntry[]> {
  const rows = await db.$queryRaw<Pick<VersionRow, "version" | "by" | "name" | "notify_version" | "summary" | "updated_at">[]>`
    SELECT version, by, name, notify_version, summary, updated_at
      FROM assistant_notify_version WHERE conversation_id = ${conversationId}::uuid ORDER BY version DESC
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

async function prune(db: Database, conversationId: string, latest: number): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_notify_version WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_NOTIFY_VERSIONS}::int
  `;
}

async function conversationOf(db: Database, conversationId: string): Promise<Conversation> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { id: true, virtualAgentId: true, ownerOid: true } });
  if (row === null) {
    throw new HttpError(404, "no such conversation");
  }
  return row;
}

async function conflict(db: Database, conversationId: string): Promise<HttpError> {
  return new HttpError(409, "the Notify template has changed since that version", { current: await notifyView(db, conversationId) });
}

/** The source of `version`, which a write without a source of its own takes on. */
async function sourceOf(db: Database, conversationId: string, version: number): Promise<NotifySource> {
  const row = await versionRow(db, conversationId, version);
  if (row === undefined) {
    throw new HttpError(404, "the conversation has no Notify template");
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
    INSERT INTO assistant_notify_version (conversation_id, version, revision, product, template_id, service_id, type, name, subject, body,
                                          notify_version, notify_subject, notify_body, notify_preview, data, by, editor_oid, summary, updated_at)
    VALUES (${conversationId}::uuid, ${version}::int, 0, ${source.product}, ${source.template_id}::uuid, ${source.service_id}::uuid, ${source.type},
            ${source.name}, ${subject}, ${body}, ${source.notify_version}::int, ${source.notify_subject}, ${source.notify_body}, ${source.notify_preview},
            ${data}::jsonb, ${by}, ${editorOid}, ${summary}, ${now})
  `;
}

/**
 * Writes a new version by the session if `base_version` is still the template's version, and `base_revision`, when
 * given, its revision; otherwise `HttpError(409, {current})`. A put with no `source` keeps the latest version's, so
 * an edit of the draft names only what it changes. Announced.
 */
export async function writeAgentNotify(
  prisma: PrismaClient,
  { conversationId, body, now = new Date() }: { conversationId: string; body: NotifyPut; now?: Date }
): Promise<{ version: number; revision: number }> {
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const held = await tx.assistantConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { notifyVersion: true, notifyRevision: true } });
    if (held.notifyVersion !== body.base_version || (body.base_revision !== undefined && held.notifyRevision !== body.base_revision)) {
      throw await conflict(tx, conversationId);
    }
    const source = body.source ?? (await sourceOf(tx, conversationId, held.notifyVersion));
    if (!subjectFits(source.type, body.subject)) {
      throw new HttpError(400, subjectRefusal(source.type));
    }
    const version = held.notifyVersion + 1;
    await insertVersion(tx, {
      conversationId,
      version,
      source,
      subject: body.subject,
      body: body.body,
      data: JSON.stringify(body.data),
      by: "agent",
      editorOid: null,
      summary: body.summary ?? null,
      now
    });
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET notify_version = ${version}::int, notify_revision = 0, notify_name = ${source.name}, notify_updated_by = 'agent',
             notify_updated_at = ${now}, first_content_at = COALESCE(first_content_at, ${now}), updated_at = ${now}
       WHERE id = ${conversationId}::uuid
    `;
    await prune(tx, conversationId, version);
    await announce(tx, conversation);
    return { version, revision: 0 };
  });
}

export const EDITED_NOTIFY_SUMMARY = "Edited the template";

/**
 * The person's save of the draft, if the template is still at `baseVersion` and `baseRevision`; otherwise
 * `HttpError(409, {current})`. It amends the latest version in place when that is this person's own, and otherwise
 * writes the next version, `by: user`, from the latest one's source. Announced.
 */
export async function writeUserNotify(
  prisma: PrismaClient,
  {
    conversationId,
    editorOid,
    subject,
    body,
    data,
    baseVersion,
    baseRevision,
    now = new Date()
  }: { conversationId: string; editorOid: string; subject: string | null; body: string; data: unknown; baseVersion: number; baseRevision: number; now?: Date }
): Promise<{ version: number; revision: number; amended: boolean }> {
  const checked = checkNotifyData(data);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const stored = JSON.stringify(checked.value);
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const held = await tx.assistantConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { notifyVersion: true, notifyRevision: true } });
    if (held.notifyVersion === 0) {
      throw new HttpError(404, "the conversation has no Notify template");
    }
    if (held.notifyVersion !== baseVersion || held.notifyRevision !== baseRevision) {
      throw await conflict(tx, conversationId);
    }
    const latest = await tx.assistantNotifyVersion.findUniqueOrThrow({
      where: { conversationId_version: { conversationId, version: baseVersion } },
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
         WHERE conversation_id = ${conversationId}::uuid AND version = ${baseVersion}::int
      `;
      await tx.$executeRaw`
        UPDATE assistant_conversation
           SET notify_revision = ${revision}::int, notify_updated_by = 'user', notify_updated_at = ${now}, updated_at = ${now}
         WHERE id = ${conversationId}::uuid
      `;
      await announce(tx, conversation);
      return { version: baseVersion, revision, amended: true };
    }
    const source = await sourceOf(tx, conversationId, baseVersion);
    const version = baseVersion + 1;
    await insertVersion(tx, {
      conversationId,
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
      UPDATE assistant_conversation
         SET notify_version = ${version}::int, notify_revision = 0, notify_name = ${source.name}, notify_updated_by = 'user',
             notify_updated_at = ${now}, updated_at = ${now}
       WHERE id = ${conversationId}::uuid
    `;
    await prune(tx, conversationId, version);
    await announce(tx, conversation);
    return { version, revision: 0, amended: false };
  });
}
