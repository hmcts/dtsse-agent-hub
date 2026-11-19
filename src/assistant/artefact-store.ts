import { HttpError } from "../agent-api/http.ts";
import { podLacks } from "../agents/client-features.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { type DocumentKind, documentExports, ITEMS_CREATE_REFUSED, ITEMS_EXPORT_REFUSED, isDocumentKind, UNTITLED_DOCUMENT } from "./documents.ts";
import { hasPod } from "./pods.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConversationRef = Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">;

export interface Artefact {
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: "user" | "agent" | null;
  updatedAt: Date | null;
}

export interface StoredDocument extends Artefact {
  id: string;
  kind: DocumentKind;
}

export const EMPTY_ARTEFACT: Artefact = { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null };

export const DOCUMENT_SELECT = { id: true, kind: true, title: true, markdown: true, version: true, updatedBy: true, updatedAt: true } as const;

/** Oldest first, which is the order the switcher lists them in and what makes the first `document` the primary. */
export const OLDEST_FIRST = [{ createdAt: "asc" }, { id: "asc" }] as const;

export function toDocument(row: {
  id: string;
  kind: string;
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}): StoredDocument {
  const by = row.updatedBy;
  return {
    id: row.id,
    kind: isDocumentKind(row.kind) ? row.kind : "document",
    title: row.title,
    markdown: row.markdown,
    version: row.version,
    updatedBy: by === "user" || by === "agent" ? by : null,
    updatedAt: row.updatedAt
  };
}

export async function listDocuments(db: Database, conversationId: string): Promise<StoredDocument[]> {
  const rows = await db.assistantDocument.findMany({ where: { conversationId }, select: DOCUMENT_SELECT, orderBy: [...OLDEST_FIRST] });
  return rows.map(toDocument);
}

export async function readDocument(db: Database, conversationId: string, id: string): Promise<StoredDocument | undefined> {
  const row = await db.assistantDocument.findFirst({ where: { id, conversationId }, select: DOCUMENT_SELECT });
  return row === null ? undefined : toDocument(row);
}

export async function readPrimaryDocument(db: Database, conversationId: string): Promise<StoredDocument | undefined> {
  const row = await db.assistantDocument.findFirst({ where: { conversationId, kind: "document" }, select: DOCUMENT_SELECT, orderBy: [...OLDEST_FIRST] });
  return row === null ? undefined : toDocument(row);
}

/** The primary document, or an empty one at version 0 while the conversation has none: what `/artefact` answers. */
export async function readArtefact(db: Database, conversationId: string): Promise<Artefact> {
  return (await readPrimaryDocument(db, conversationId)) ?? EMPTY_ARTEFACT;
}

export class ArtefactConflict extends Error {
  readonly current: Artefact;

  constructor(current: Artefact) {
    super("the document has changed since that version");
    this.current = current;
  }
}

const MISSING = "that document no longer exists";

/** A document is something in the chat, so the first write of one records the conversation's first content. */
async function touchConversation(tx: Database, conversationId: string, now: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE assistant_conversation SET first_content_at = COALESCE(first_content_at, ${now}), updated_at = ${now} WHERE id = ${conversationId}::uuid
  `;
}

/**
 * Whether the conversation's pod is running a client that reads only the primary document (`items`), or, with
 * `item-templates`, only the primary deck, Docmosis template and Notify template.
 */
export async function podLacksItems(tx: Database, conversation: ConversationRef, feature: "items" | "item-templates" = "items"): Promise<boolean> {
  if (!hasPod(conversation)) {
    return false;
  }
  const pod = await tx.virtualAgent.findUnique({
    where: { id: conversation.virtualAgentId },
    select: { status: true, clientFeatures: true, agent: { select: { clientFeatures: true } } }
  });
  return pod !== null && podLacks(pod, feature);
}

type DocumentWrite = { title: string | null; markdown: string; baseVersion: number; by: "user" | "agent" };

/** The compare-and-set every write of an existing document is: written only while `baseVersion` is still its version. */
async function updateDocument(tx: Database, conversationId: string, id: string, write: DocumentWrite, now: Date): Promise<number | undefined> {
  const [row] = await tx.$queryRaw<{ version: number }[]>`
    UPDATE assistant_document
       SET title = COALESCE(${write.title}, title, ${UNTITLED_DOCUMENT}),
           markdown = ${write.markdown},
           version = version + 1,
           updated_by = ${write.by},
           updated_at = ${now}
     WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND version = ${write.baseVersion}::int
    RETURNING version
  `;
  return row?.version;
}

/**
 * Makes a document at version 1, refused for a kind or a count the conversation's pod cannot read (`ITEMS_CREATE_REFUSED`)
 * and, for a ticket or a Confluence page, for a chat with no pod, which has no way to export one. The conversation's
 * row is locked first, so two creates at once count each other. `id` is the browser's own for the document it opened,
 * which is what makes a repeated first save find the document the first one made rather than make another: answered
 * `undefined` when a document of that id is already there.
 */
async function insertDocument(
  tx: Database,
  conversation: ConversationRef,
  create: { id?: string; kind: DocumentKind; title: string | null; markdown: string; by: "user" | "agent" },
  now: Date
): Promise<string | undefined> {
  await tx.$executeRaw`SELECT 1 FROM assistant_conversation WHERE id = ${conversation.id}::uuid FOR UPDATE`;
  if (create.kind !== "document" && !hasPod(conversation)) {
    throw new HttpError(409, "this chat is a session on your own computer, which cannot export, so it holds plain documents only");
  }
  if (create.kind !== "document" || (await tx.assistantDocument.count({ where: { conversationId: conversation.id } })) > 0) {
    if (await podLacksItems(tx, conversation)) {
      throw new HttpError(409, ITEMS_CREATE_REFUSED);
    }
  }
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO assistant_document (id, conversation_id, kind, title, markdown, version, updated_by, updated_at, created_at)
    VALUES (COALESCE(${create.id ?? null}::uuid, gen_random_uuid()), ${conversation.id}::uuid, ${create.kind}, ${create.title ?? UNTITLED_DOCUMENT},
            ${create.markdown}, 1, ${create.by}, ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
    RETURNING id::text AS id
  `;
  if (row === undefined) {
    return undefined;
  }
  await touchConversation(tx, conversation.id, now);
  await announce(tx, conversation);
  return row.id;
}

/** A new document, for the agent API's create, which has no version to compare with. */
export async function createDocument(
  prisma: PrismaClient,
  conversation: ConversationRef,
  create: { kind: DocumentKind; title: string | null; markdown: string; by: "user" | "agent" },
  now: Date = new Date()
): Promise<{ id: string; version: number }> {
  const id = await prisma.$transaction((tx) => insertDocument(tx, conversation, create, now));
  return { id: id as string, version: 1 };
}

/**
 * Writes one document if `baseVersion` is still its version, and answers the new one. Otherwise nothing is written and
 * `ArtefactConflict` carries what is there now, for the writer to merge into. A title left `null` keeps the current one.
 *
 * `create` is the kind of a document the browser opened and has not saved yet: its first save, at base 0, makes it under
 * the browser's id. Without it, or for an id the conversation does not hold at any other base, the write is a `404`.
 */
export async function writeDocument(
  prisma: PrismaClient,
  conversation: ConversationRef,
  id: string,
  write: DocumentWrite & { create?: DocumentKind },
  now: Date = new Date()
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const version = await updateDocument(tx, conversation.id, id, write, now);
    if (version !== undefined) {
      await touchConversation(tx, conversation.id, now);
      await announce(tx, conversation);
      return version;
    }
    const current = await readDocument(tx, conversation.id, id);
    if (current !== undefined) {
      throw new ArtefactConflict(current);
    }
    if (write.create === undefined || write.baseVersion !== 0) {
      throw new HttpError(404, MISSING);
    }
    const made = await insertDocument(tx, conversation, { id, kind: write.create, title: write.title, markdown: write.markdown, by: write.by }, now);
    if (made === undefined) {
      // The id is another conversation's document.
      throw new HttpError(404, MISSING);
    }
    return 1;
  });
}

/**
 * What `PUT /artefact` runs: writes the conversation's primary document as `writeDocument` does, and creates it at base 0
 * while there is none, so a client that knows one document keeps working.
 */
export async function writeArtefact(prisma: PrismaClient, conversation: ConversationRef, write: DocumentWrite, now: Date = new Date()): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    // Locked so two first writes at once make one primary between them.
    await tx.$executeRaw`SELECT 1 FROM assistant_conversation WHERE id = ${conversation.id}::uuid FOR UPDATE`;
    const primary = await readPrimaryDocument(tx, conversation.id);
    if (primary === undefined) {
      if (write.baseVersion !== 0) {
        throw new ArtefactConflict(EMPTY_ARTEFACT);
      }
      await insertDocument(tx, conversation, { kind: "document", title: write.title, markdown: write.markdown, by: write.by }, now);
      return 1;
    }
    const version = await updateDocument(tx, conversation.id, primary.id, write, now);
    if (version === undefined) {
      throw new ArtefactConflict(primary);
    }
    await touchConversation(tx, conversation.id, now);
    await announce(tx, conversation);
    return version;
  });
}

/** Removes a document and its export state. A ticket or page already made from it stays where it was made. */
export async function removeDocument(prisma: PrismaClient, conversation: ConversationRef, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantDocument.deleteMany({ where: { id, conversationId: conversation.id } });
    if (count === 0) {
      throw new HttpError(404, MISSING);
    }
    await announce(tx, conversation);
  });
}

/**
 * The document an export is asked of, checked before it is claimed: it is the conversation's, its kind goes to
 * `destination`, and, unless it is the primary, the pod's client can read it (`ITEMS_EXPORT_REFUSED`).
 */
export async function exportableDocument(tx: Database, conversation: ConversationRef, id: unknown, destination: "ticket" | "confluence"): Promise<string> {
  const document = typeof id === "string" && UUID_RE.test(id) ? await readDocument(tx, conversation.id, id) : undefined;
  if (document === undefined) {
    throw new HttpError(404, MISSING);
  }
  if (!documentExports(document.kind)[destination]) {
    throw new HttpError(
      409,
      document.kind === "ticket"
        ? "this document is a ticket, so it goes to your ticket tool only"
        : "this document is a Confluence page, so it goes to Confluence only"
    );
  }
  if ((await readPrimaryDocument(tx, conversation.id))?.id !== document.id && (await podLacksItems(tx, conversation))) {
    throw new HttpError(409, ITEMS_EXPORT_REFUSED);
  }
  return document.id;
}

/** A document as the agent API answers it. */
export function artefactJson(artefact: Artefact) {
  return {
    title: artefact.title,
    markdown: artefact.markdown,
    version: artefact.version,
    updated_by: artefact.updatedBy,
    updated_at: artefact.updatedAt?.toISOString() ?? null
  };
}

/** One entry of `GET /artefacts`: everything but the markdown. */
export function documentSummaryJson(document: StoredDocument) {
  return {
    id: document.id,
    kind: document.kind,
    title: document.title,
    version: document.version,
    updated_by: document.updatedBy,
    updated_at: document.updatedAt?.toISOString() ?? null
  };
}

/** The export tools whose request is a message the chat sends, and can be abandoned if that message does not go. */
export type ExportTool = "jira" | "github" | "confluence";

/** Said on the document when its export's request never reached the assistant, so it can be asked for again at once. */
export const EXPORT_NOT_SENT = "the request could not be sent to your assistant, so nothing was created; try again";

/** Each tool's columns, so one statement serves all three. */
const EXPORT_COLUMNS = {
  jira: { id: "jiraExportId", status: "jiraStatus", error: "jiraError" },
  github: { id: "githubExportId", status: "githubStatus", error: "githubError" },
  confluence: { id: "confluenceExportId", status: "confluenceStatus", error: "confluenceError" }
} as const satisfies Record<ExportTool, { id: string; status: string; error: string }>;

/**
 * Marks the document's export failed when the chat message that asks for it was not sent: the export is written
 * pending first, so the footer says so as the request goes, and without this a message that failed would leave it
 * "pending" until the 15-minute window let it be asked for again. Only a pending one, and only the export the
 * failed request wrote (`exportId`), so one another tab has since started is left alone. The id itself is kept, so
 * an earlier attempt with the same id that does answer is still recorded. Announced, so the panel shows the failure.
 */
export async function abandonExport(
  prisma: PrismaClient,
  conversation: ConversationRef,
  documentId: string,
  tool: ExportTool,
  exportId: string | null
): Promise<void> {
  if (!UUID_RE.test(documentId) || exportId === null) {
    return;
  }
  const column = EXPORT_COLUMNS[tool];
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantDocument.updateMany({
      where: { id: documentId, conversationId: conversation.id, [column.id]: exportId, [column.status]: "pending" },
      data: { [column.status]: "failed", [column.error]: EXPORT_NOT_SENT }
    });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
}
