import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { lockConversation } from "./deck-store.ts";
import {
  ASSET_GRACE_MS,
  checkDocmosisData,
  type DocmosisAuthor,
  type DocmosisPut,
  type DocmosisSchema,
  docxRef,
  docxSha,
  KEEP_PDF,
  KEEP_VERSIONS,
  MAX_HELD_DOCX_BYTES,
  MAX_PDF_BYTES,
  storableError
} from "./docmosis.ts";

/**
 * A conversation's Docmosis template, written in versions the way its deck is (`deck-store.ts`): a write names the
 * version it was made from, and a newer one refuses it with what is there now. See "Docmosis templates" in docs/agent-api.md.
 *
 * Every write applies the retention in its own transaction: the newest `KEEP_VERSIONS` versions stay, only the newest
 * `KEEP_PDF` keep their PDF, and a .docx no kept version names goes once it is older than `ASSET_GRACE_MS`. A write
 * locks the conversation's row, as an upload does, so the two cannot interleave.
 */

type Conversation = Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">;

export interface DocmosisResponse {
  version: number;
  revision: number;
  name: string;
  docx: string;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  by: DocmosisAuthor;
  summary: string | null;
  updated_at: string;
  has_pdf: boolean;
  render_error: { short: string; long: string } | null;
  /** Only when a version other than the latest was asked for. */
  current_version?: number;
}

export interface DocmosisVersionEntry {
  version: number;
  by: DocmosisAuthor;
  summary: string | null;
  updated_at: string;
  has_pdf: boolean;
}

export const DOCMOSIS_SELECT = { docmosisName: true, docmosisVersion: true, docmosisRevision: true, docmosisUpdatedBy: true, docmosisPdfState: true } as const;

const author = (value: string | null): DocmosisAuthor | null => (value === "user" || value === "agent" ? value : null);

const pdfState = (value: string): DocmosisSummary["pdf"] => (value === "ready" || value === "failed" ? value : "pending");

export function docmosisAuthor(row: { docmosisUpdatedBy: string | null }): DocmosisAuthor | null {
  return author(row.docmosisUpdatedBy);
}

/** What a page carries about the latest version of a Docmosis template; the panel reads the rest itself. */
export interface DocmosisSummary {
  name: string;
  version: number;
  revision: number;
  updatedBy: DocmosisAuthor;
  /** Whether the latest version has its PDF, has a failed render, or has neither yet. */
  pdf: "pending" | "ready" | "failed";
}

/** From the conversation's Docmosis columns (`DOCMOSIS_SELECT`); `null` for a conversation with no Docmosis template. */
export function docmosisSummary(row: {
  docmosisName: string | null;
  docmosisVersion: number;
  docmosisRevision: number;
  docmosisUpdatedBy: string | null;
  docmosisPdfState: string;
}): DocmosisSummary | null {
  const updatedBy = author(row.docmosisUpdatedBy);
  if (row.docmosisVersion === 0 || row.docmosisName === null || updatedBy === null) {
    return null;
  }
  return { name: row.docmosisName, version: row.docmosisVersion, revision: row.docmosisRevision, updatedBy, pdf: pdfState(row.docmosisPdfState) };
}

interface VersionRow {
  version: number;
  revision: number;
  name: string;
  docx_sha256: string;
  schema: DocmosisSchema;
  data: Record<string, unknown>;
  by: string;
  summary: string | null;
  updated_at: Date;
  has_pdf: boolean;
  render_error: { short: string; long: string } | null;
}

const responseOf = (row: VersionRow): DocmosisResponse => ({
  version: row.version,
  revision: row.revision,
  name: row.name,
  docx: docxRef(row.docx_sha256),
  schema: row.schema,
  data: row.data,
  by: row.by === "user" ? "user" : "agent",
  summary: row.summary,
  updated_at: row.updated_at.toISOString(),
  has_pdf: row.has_pdf,
  render_error: row.render_error
});

async function latestVersion(db: Database, conversationId: string): Promise<number> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { docmosisVersion: true } });
  return row?.docmosisVersion ?? 0;
}

async function versionRow(db: Database, conversationId: string, version: number): Promise<VersionRow | undefined> {
  const [row] = await db.$queryRaw<VersionRow[]>`
    SELECT version, revision, name, docx_sha256, schema, data, by, summary, updated_at, pdf IS NOT NULL AS has_pdf, render_error
      FROM assistant_docmosis_version
     WHERE conversation_id = ${conversationId}::uuid AND version = ${version}::int
  `;
  return row;
}

/** The latest version, or `version` when it is kept; `null` for a conversation with no Docmosis template and for a version not kept. */
export async function docmosisView(db: Database, conversationId: string, version?: number): Promise<DocmosisResponse | null> {
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
export async function listDocmosisVersions(db: Database, conversationId: string): Promise<DocmosisVersionEntry[]> {
  const rows = await db.$queryRaw<Omit<VersionRow, "revision" | "name" | "docx_sha256" | "schema" | "data" | "render_error">[]>`
    SELECT version, by, summary, updated_at, pdf IS NOT NULL AS has_pdf
      FROM assistant_docmosis_version WHERE conversation_id = ${conversationId}::uuid ORDER BY version DESC
  `;
  return rows.map((row) => ({
    version: row.version,
    by: row.by === "user" ? "user" : "agent",
    summary: row.summary,
    updated_at: row.updated_at.toISOString(),
    has_pdf: row.has_pdf
  }));
}

export async function readDocmosisPdf(db: Database, conversationId: string, version: number): Promise<Uint8Array | null> {
  const row = await db.assistantDocmosisVersion.findUnique({
    where: { conversationId_version: { conversationId, version } },
    select: { pdf: true }
  });
  return row?.pdf ?? null;
}

export async function readDocmosisDocx(db: Database, conversationId: string, sha256: string): Promise<Uint8Array | null> {
  const row = await db.assistantDocmosisAsset.findUnique({ where: { conversationId_sha256: { conversationId, sha256 } }, select: { bytes: true } });
  return row?.bytes ?? null;
}

/** The retention: old versions, old PDFs, and .docx files no kept version names. */
async function prune(db: Database, conversationId: string, latest: number, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_docmosis_version WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_VERSIONS}::int
  `;
  await db.$executeRaw`
    UPDATE assistant_docmosis_version SET pdf = NULL
     WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_PDF}::int AND pdf IS NOT NULL
  `;
  await deleteUnnamedAssets(db, conversationId, now);
}

async function deleteUnnamedAssets(db: Database, conversationId: string, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_docmosis_asset a
     WHERE a.conversation_id = ${conversationId}::uuid
       AND a.created_at < ${new Date(now.getTime() - ASSET_GRACE_MS)}
       AND NOT EXISTS (
         SELECT 1 FROM assistant_docmosis_version v WHERE v.conversation_id = a.conversation_id AND v.docx_sha256 = a.sha256
       )
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
  return new HttpError(409, "the Docmosis template has changed since that version", { current: await docmosisView(db, conversationId) });
}

/**
 * Writes a new version if `baseVersion` is still the template's version, and `baseRevision`, when given, its revision.
 * Otherwise `HttpError(409, {current})`; a .docx the hub does not hold is `HttpError(400, {missing_assets})` and
 * nothing is written. Announced.
 */
export async function writeAgentDocmosis(
  prisma: PrismaClient,
  { conversationId, body, now = new Date() }: { conversationId: string; body: DocmosisPut; now?: Date }
): Promise<{ version: number; revision: number }> {
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const sha = docxSha(body.docx) ?? "";
    const [moved] = await tx.$queryRaw<{ version: number }[]>`
      UPDATE assistant_conversation
         SET docmosis_version = docmosis_version + 1,
             docmosis_revision = 0,
             docmosis_name = ${body.name},
             docmosis_updated_by = 'agent',
             docmosis_pdf_state = 'pending',
             docmosis_updated_at = ${now},
             first_content_at = COALESCE(first_content_at, ${now}),
             updated_at = ${now}
       WHERE id = ${conversationId}::uuid AND docmosis_version = ${body.base_version}::int
         AND (${body.base_revision ?? null}::int IS NULL OR docmosis_revision = ${body.base_revision ?? null}::int)
      RETURNING docmosis_version AS version
    `;
    if (moved === undefined) {
      throw await conflict(tx, conversationId);
    }
    if ((await tx.assistantDocmosisAsset.count({ where: { conversationId, sha256: sha } })) === 0) {
      throw new HttpError(400, `docx names a .docx the hub does not hold: ${body.docx}; upload it first`, { missing_assets: [body.docx] });
    }
    await tx.$executeRaw`
      INSERT INTO assistant_docmosis_version (conversation_id, version, revision, name, docx_sha256, schema, data, by, summary, updated_at)
      VALUES (${conversationId}::uuid, ${moved.version}::int, 0, ${body.name}, ${sha}, ${JSON.stringify(body.schema)}::jsonb,
              ${JSON.stringify(body.data)}::jsonb, 'agent', ${body.summary ?? null}, ${now})
    `;
    await prune(tx, conversationId, moved.version, now);
    await announce(tx, conversation);
    return { version: moved.version, revision: 0 };
  });
}

export const EDITED_SUMMARY = "Edited form data";

/**
 * The person's save of the form's data, if the template is still at `baseVersion` and `baseRevision`; otherwise
 * `HttpError(409, {current})`. It answers with the version and revision written and the name and .docx digest it holds. It amends the latest version in place when that is this person's own, and otherwise
 * writes the next version, `by: user`, from the latest one's name, .docx and schema. Announced.
 */
export async function writeUserDocmosisData(
  prisma: PrismaClient,
  {
    conversationId,
    editorOid,
    data,
    baseVersion,
    baseRevision,
    now = new Date()
  }: { conversationId: string; editorOid: string; data: unknown; baseVersion: number; baseRevision: number; now?: Date }
): Promise<{ version: number; revision: number; name: string; docxSha256: string }> {
  const checked = checkDocmosisData(data);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const stored = JSON.stringify(checked.value);
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const held = await tx.assistantConversation.findUnique({ where: { id: conversationId }, select: { docmosisVersion: true, docmosisRevision: true } });
    if (held === null || held.docmosisVersion === 0) {
      throw new HttpError(404, "the conversation has no Docmosis template");
    }
    if (held.docmosisVersion !== baseVersion || held.docmosisRevision !== baseRevision) {
      throw await conflict(tx, conversationId);
    }
    const latest = await tx.assistantDocmosisVersion.findUniqueOrThrow({
      where: { conversationId_version: { conversationId, version: baseVersion } },
      select: { by: true, editorOid: true, name: true, docxSha256: true }
    });
    if (latest.by === "user" && latest.editorOid === editorOid) {
      const revision = baseRevision + 1;
      await tx.$executeRaw`
        UPDATE assistant_docmosis_version
           SET data = ${stored}::jsonb, revision = ${revision}::int, pdf = NULL, render_error = NULL, updated_at = ${now}
         WHERE conversation_id = ${conversationId}::uuid AND version = ${baseVersion}::int
      `;
      await tx.$executeRaw`
        UPDATE assistant_conversation
           SET docmosis_revision = ${revision}::int, docmosis_pdf_state = 'pending', docmosis_updated_by = 'user', docmosis_updated_at = ${now}, updated_at = ${now}
         WHERE id = ${conversationId}::uuid
      `;
      await prune(tx, conversationId, baseVersion, now);
      await announce(tx, conversation);
      return { version: baseVersion, revision, name: latest.name, docxSha256: latest.docxSha256 };
    }
    const version = baseVersion + 1;
    await tx.$executeRaw`
      INSERT INTO assistant_docmosis_version (conversation_id, version, revision, name, docx_sha256, schema, data, by, editor_oid, summary, updated_at)
      SELECT conversation_id, ${version}::int, 0, name, docx_sha256, schema, ${stored}::jsonb, 'user', ${editorOid}, ${EDITED_SUMMARY}, ${now}
        FROM assistant_docmosis_version WHERE conversation_id = ${conversationId}::uuid AND version = ${baseVersion}::int
    `;
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET docmosis_version = ${version}::int, docmosis_revision = 0, docmosis_name = ${latest.name}, docmosis_updated_by = 'user', docmosis_pdf_state = 'pending',
             docmosis_updated_at = ${now}, updated_at = ${now}
       WHERE id = ${conversationId}::uuid
    `;
    await prune(tx, conversationId, version, now);
    await announce(tx, conversation);
    return { version, revision: 0, name: latest.name, docxSha256: latest.docxSha256 };
  });
}

/**
 * Stores the outcome of a render of `version` at `revision`: the PDF, or the merge error, each clearing the other.
 * `false`, and nothing stored, when that is no longer the template's latest version at that revision. Announced.
 */
export async function storeDocmosisRender(
  prisma: PrismaClient,
  {
    conversationId,
    version,
    revision,
    pdf,
    error
  }: { conversationId: string; version: number; revision: number; pdf?: Uint8Array; error?: { short: string; long: string } }
): Promise<boolean> {
  if (pdf !== undefined && (pdf.byteLength < 1 || pdf.byteLength > MAX_PDF_BYTES)) {
    throw new HttpError(413, `a PDF is 1 to ${MAX_PDF_BYTES} bytes`);
  }
  const errorJson = error === undefined ? null : JSON.stringify(storableError(error));
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const held = await tx.assistantConversation.findUnique({ where: { id: conversationId }, select: { docmosisVersion: true, docmosisRevision: true } });
    if (held?.docmosisVersion !== version || held.docmosisRevision !== revision) {
      return false;
    }
    await tx.$executeRaw`
      UPDATE assistant_docmosis_version
         SET pdf = ${pdf === undefined ? null : Buffer.from(pdf)}, render_error = ${errorJson}::jsonb
       WHERE conversation_id = ${conversationId}::uuid AND version = ${version}::int
    `;
    await tx.$executeRaw`
      UPDATE assistant_conversation SET docmosis_pdf_state = ${pdf === undefined ? "failed" : "ready"} WHERE id = ${conversationId}::uuid
    `;
    await announce(tx, conversation);
    return true;
  });
}

/**
 * Stores a PDF for `version` when that version is kept, is one of the newest `KEEP_PDF`, and is still at `revision`:
 * `"stored"`; `"gone"` when it is not kept or too old; `"stale"` when the person has amended it since, so the PDF was
 * rendered from data it no longer holds.
 */
export async function putDocmosisPdf(
  prisma: PrismaClient,
  conversationId: string,
  version: number,
  revision: number,
  bytes: Uint8Array
): Promise<"stored" | "gone" | "stale"> {
  return await prisma.$transaction(async (tx) => {
    const conversation = await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const latest = await latestVersion(tx, conversationId);
    if (version > latest || version <= latest - KEEP_PDF) {
      return "gone";
    }
    const row = await versionRow(tx, conversationId, version);
    if (row === undefined) {
      return "gone";
    }
    if (row.revision !== revision) {
      return "stale";
    }
    await tx.$executeRaw`
      UPDATE assistant_docmosis_version SET pdf = ${Buffer.from(bytes)}, render_error = NULL
       WHERE conversation_id = ${conversationId}::uuid AND version = ${version}::int
    `;
    if (version === latest) {
      await tx.$executeRaw`UPDATE assistant_conversation SET docmosis_pdf_state = 'ready' WHERE id = ${conversationId}::uuid`;
    }
    await announce(tx, conversation);
    return "stored";
  });
}

/**
 * Makes room for `incoming` more bytes under `MAX_HELD_DOCX_BYTES` by deleting the oldest versions, never one of the
 * newest `KEEP_PDF`, and the .docx of each that no remaining version names, whatever its age: the grace is for an
 * upload no version has named yet, and one this frees was named. `keep` is the digest the write in hand names, which
 * is not freed. `false` when only the newest `KEEP_PDF` versions and uploads still in their grace would make room.
 */
async function makeRoom(db: Database, conversationId: string, incoming: number, now: Date, keep: string): Promise<boolean> {
  const latest = await latestVersion(db, conversationId);
  for (;;) {
    const [held] = await db.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT SUM(octet_length(bytes))::bigint AS bytes FROM assistant_docmosis_asset WHERE conversation_id = ${conversationId}::uuid
    `;
    if (Number(held?.bytes ?? 0) + incoming <= MAX_HELD_DOCX_BYTES) {
      return true;
    }
    const dropped = await db.$queryRaw<{ docx_sha256: string }[]>`
      DELETE FROM assistant_docmosis_version
       WHERE conversation_id = ${conversationId}::uuid
         AND version = (SELECT MIN(version) FROM assistant_docmosis_version WHERE conversation_id = ${conversationId}::uuid)
         AND version <= ${latest - KEEP_PDF}::int
      RETURNING docx_sha256
    `;
    const [gone] = dropped;
    if (gone === undefined) {
      return false;
    }
    await db.$executeRaw`
      DELETE FROM assistant_docmosis_asset a
       WHERE a.conversation_id = ${conversationId}::uuid AND a.sha256 = ${gone.docx_sha256} AND a.sha256 <> ${keep}
         AND NOT EXISTS (
           SELECT 1 FROM assistant_docmosis_version v WHERE v.conversation_id = a.conversation_id AND v.docx_sha256 = a.sha256
         )
    `;
    await deleteUnnamedAssets(db, conversationId, now);
  }
}

/**
 * Stores a .docx under the digest of its bytes, which the caller has checked. One already held is touched, so it gets
 * its grace again. `HttpError(409)` when it does not fit (`makeRoom`). Not announced: nothing on screen shows a .docx
 * until a version names it.
 */
export async function putDocmosisAsset(prisma: PrismaClient, conversationId: string, sha256: string, bytes: Uint8Array, now: Date = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await conversationOf(tx, conversationId);
    await lockConversation(tx, conversationId);
    const { count } = await tx.assistantDocmosisAsset.updateMany({ where: { conversationId, sha256 }, data: { createdAt: now } });
    if (count > 0) {
      return;
    }
    if (!(await makeRoom(tx, conversationId, bytes.byteLength, now, sha256))) {
      throw new HttpError(
        409,
        `a conversation holds at most ${MAX_HELD_DOCX_BYTES} bytes of .docx files, and it holds too much .docx to take this one: what is left is named by the latest ${KEEP_PDF} versions, which are never deleted to make room, or was uploaded within the last hour`
      );
    }
    await tx.assistantDocmosisAsset.create({ data: { conversationId, sha256, bytes: Buffer.from(bytes), createdAt: now } });
  });
}
