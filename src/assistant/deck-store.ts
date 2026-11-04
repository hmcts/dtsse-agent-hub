import { HttpError } from "../agent-api/http.ts";
import { clientPrisma } from "../store/client-namespace.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import {
  ASSET_GRACE_MS,
  assetRef,
  type DeckOutline,
  type ImageInfo,
  KEEP_PPTX,
  KEEP_VERSIONS,
  MAX_DECK_ASSET_BYTES,
  MAX_HELD_ASSET_BYTES,
  outlineAssets,
  withSlideIds
} from "./deck.ts";
import { heldBuildSince } from "./deck-build.ts";

/**
 * A conversation's slide deck, written in versions the way its document is (`artefact-store.ts`): a write names the
 * version it was made from, and a newer one refuses it with what is there now. The pod builds each version's .pptx and
 * sends it after the outline, so a version can be read before its .pptx exists.
 *
 * Every write applies the retention in its own transaction: the newest `KEEP_VERSIONS` outlines stay, only the newest
 * `KEEP_PPTX` keep their .pptx, and a picture no kept outline names goes once it is older than `ASSET_GRACE_MS`. An
 * upload that would take the pictures held past `MAX_HELD_ASSET_BYTES` drops the oldest outlines to make room, never
 * one of the newest `KEEP_PPTX`, and is refused when only those would make it. A
 * write locks the conversation's row, as an asset upload and a .pptx upload do, so the three cannot interleave.
 */

export type DeckAuthor = "user" | "agent";

export interface Deck {
  /** `null` and `outline: null` while `version` is 0, before anything has written one. */
  title: string | null;
  outline: DeckOutline | null;
  version: number;
  /** Moved on by every write of the outline, an amend that leaves `version` where it was included. */
  revision: number;
  updatedBy: DeckAuthor | null;
  updatedAt: Date | null;
  /** Whether the latest version's .pptx can be downloaded (`pptxHeld`). */
  pptx: boolean;
}

const EMPTY_DECK: Deck = { title: null, outline: null, version: 0, revision: 0, updatedBy: null, updatedAt: null, pptx: false };

export const DECK_SELECT = { deckTitle: true, deckVersion: true, deckRevision: true, deckUpdatedBy: true, deckUpdatedAt: true } as const;

const author = (value: string | null): DeckAuthor | null => (value === "user" || value === "agent" ? value : null);

export function deckAuthor(row: { deckUpdatedBy: string | null }): DeckAuthor | null {
  return author(row.deckUpdatedBy);
}

/**
 * Whether the deck version aliased `v` has a .pptx to download: kept with it, or built on request and still held. The
 * one rule every read of a version's .pptx flag uses.
 */
export function pptxHeld(now: Date) {
  return clientPrisma().sql`(v.pptx IS NOT NULL OR EXISTS (
    SELECT 1 FROM assistant_deck_build b
     WHERE b.conversation_id = v.conversation_id AND b.version = v.version AND b.status = 'done' AND b.pptx IS NOT NULL
       AND b.created_at >= ${heldBuildSince(now)}
  ))`;
}

export async function readDeck(db: Database, conversationId: string, now: Date = new Date()): Promise<Deck> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: DECK_SELECT });
  if (row === null || row.deckVersion === 0) {
    return { ...EMPTY_DECK, revision: row?.deckRevision ?? 0 };
  }
  const [latest] = await db.$queryRaw<{ outline: DeckOutline; pptx: boolean }[]>`
    SELECT v.outline, ${pptxHeld(now)} AS pptx FROM assistant_deck_version v WHERE v.conversation_id = ${conversationId}::uuid AND v.version = ${row.deckVersion}::int
  `;
  return {
    title: row.deckTitle,
    outline: latest?.outline ?? null,
    version: row.deckVersion,
    revision: row.deckRevision,
    updatedBy: author(row.deckUpdatedBy),
    updatedAt: row.deckUpdatedAt,
    pptx: latest?.pptx ?? false
  };
}

/** The newest kept version a session wrote, 0 when no kept version is one. */
export async function newestAgentVersion(db: Database, conversationId: string): Promise<number> {
  const newest = await db.assistantDeckVersion.findFirst({
    where: { conversationId, by: "agent" },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  return newest?.version ?? 0;
}

export class DeckConflict extends Error {
  readonly current: Deck;

  constructor(current: Deck) {
    super("the deck has changed since that version");
    this.current = current;
  }
}

/** An outline naming pictures the hub does not hold. Nothing is written. */
export class DeckAssetsMissing extends HttpError {
  constructor(missing: string[]) {
    super(400, `the outline names pictures the hub does not hold: ${missing.map(assetRef).join(", ")}; upload them first`, { missing: missing.map(assetRef) });
  }
}

/** A kept version to restore has gone. Nothing is written. */
export class DeckVersionGone extends Error {
  constructor(version: number) {
    super(`the deck does not keep version ${version}`);
  }
}

/** Version `version`'s outline, read under the conversation's lock. */
async function keptOutline(db: Database, conversationId: string, version: number): Promise<DeckOutline> {
  await lockConversation(db, conversationId);
  const row = await db.assistantDeckVersion.findUnique({ where: { conversationId_version: { conversationId, version } }, select: { outline: true } });
  if (row === null) {
    throw new DeckVersionGone(version);
  }
  return row.outline as unknown as DeckOutline;
}

/** Locks the conversation's row for the rest of the transaction, which is what every deck write queues on. */
export async function lockConversation(db: Database, conversationId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM assistant_conversation WHERE id = ${conversationId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/** The retention: old outlines, old .pptx files, and pictures no kept outline names. `makeRoom` is the rest of it. */
export async function prune(db: Database, conversationId: string, latest: number, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_VERSIONS}::int
  `;
  await db.$executeRaw`
    UPDATE assistant_deck_version SET pptx = NULL
     WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_PPTX}::int AND pptx IS NOT NULL
  `;
  await deleteUnnamedAssets(db, conversationId, now);
}

/** The pictures no kept version names, once they are past their grace. */
async function deleteUnnamedAssets(db: Database, conversationId: string, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_deck_asset a
     WHERE a.conversation_id = ${conversationId}::uuid
       AND a.created_at < ${new Date(now.getTime() - ASSET_GRACE_MS)}
       AND NOT EXISTS (
         SELECT 1 FROM assistant_deck_version v
          WHERE v.conversation_id = a.conversation_id
            AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
       )
  `;
}

/** Refuses with `DeckAssetsMissing` an outline naming pictures the conversation does not hold. */
export async function requireHeldAssets(db: Database, conversationId: string, outline: DeckOutline): Promise<void> {
  const named = outlineAssets(outline);
  if (named.length === 0) {
    return;
  }
  const held = await db.$queryRaw<{ sha256: string }[]>`
    SELECT sha256 FROM assistant_deck_asset WHERE conversation_id = ${conversationId}::uuid AND sha256 = ANY(${named}::text[])
  `;
  const have = new Set(held.map((asset) => asset.sha256));
  const missing = named.filter((sha) => !have.has(sha));
  if (missing.length > 0) {
    throw new DeckAssetsMissing(missing);
  }
}

/**
 * Writes a new version of the conversation's deck if `baseVersion` is still its version, and `baseRevision`, when
 * given, its revision, and answers the new one. Otherwise nothing is written and `DeckConflict` carries what is there
 * now. Slides without an id are given one, and every picture the outline names must already be held
 * (`DeckAssetsMissing`). `editorOid` is the person writing it through the web UI's editor, which is what lets their
 * next edit amend it (`deck-edit-store.ts`).
 *
 * A deck is something in the chat, so the first one records the conversation's first content, as a document does.
 *
 * `{restore: N}` writes version N's outline again, with the .pptx the hub holds of it (kept with it, or built on request
 * and still held), both read under the conversation's lock, so the retention of a concurrent write or picture upload
 * cannot drop them between the read and the write (`DeckVersionGone` when it already has). The .pptx is copied before
 * this write's own retention runs, which may drop the old version's.
 */
export async function writeDeck(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: DeckWrite,
  now: Date = new Date()
): Promise<{ version: number; revision: number; outline: DeckOutline }> {
  return await prisma.$transaction(async (tx) => await writeDeckIn(tx, conversation, write, now));
}

export interface DeckWrite {
  outline: DeckOutline | { restore: number };
  baseVersion: number;
  baseRevision?: number;
  by: DeckAuthor;
  summary: string | null;
  editorOid?: string;
}

/** `writeDeck` in a transaction the caller holds, for a write that has read what it builds on under the same lock. */
export async function writeDeckIn(
  tx: Database,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: DeckWrite,
  now: Date
): Promise<{ version: number; revision: number; outline: DeckOutline }> {
  const source = write.outline;
  const pptxOf = "restore" in source ? source.restore : undefined;
  const outline = "restore" in source ? await keptOutline(tx, conversation.id, source.restore) : withSlideIds(source);
  const updated = await tx.$queryRaw<{ version: number; revision: number }[]>`
    UPDATE assistant_conversation
       SET deck_title = ${outline.title},
           deck_version = deck_version + 1,
           deck_revision = deck_revision + 1,
           deck_updated_by = ${write.by},
           deck_updated_at = ${now},
           first_content_at = COALESCE(first_content_at, ${now}),
           updated_at = ${now}
     WHERE id = ${conversation.id}::uuid AND deck_version = ${write.baseVersion}::int
       AND (${write.baseRevision ?? null}::int IS NULL OR deck_revision = ${write.baseRevision ?? null}::int)
    RETURNING deck_version AS version, deck_revision AS revision
  `;
  const [row] = updated;
  if (row === undefined) {
    throw new DeckConflict(await readDeck(tx, conversation.id, now));
  }
  await requireHeldAssets(tx, conversation.id, outline);
  await tx.$executeRaw`
    INSERT INTO assistant_deck_version (conversation_id, version, outline, by, summary, created_at, editor_oid)
    VALUES (${conversation.id}::uuid, ${row.version}::int, ${JSON.stringify(outline)}::jsonb, ${write.by}, ${write.summary}, ${now}, ${write.editorOid ?? null})
  `;
  if (pptxOf !== undefined) {
    await tx.$executeRaw`
      UPDATE assistant_deck_version SET pptx = COALESCE(
        (SELECT pptx FROM assistant_deck_version WHERE conversation_id = ${conversation.id}::uuid AND version = ${pptxOf}::int),
        (SELECT pptx FROM assistant_deck_build
          WHERE conversation_id = ${conversation.id}::uuid AND version = ${pptxOf}::int AND status = 'done' AND pptx IS NOT NULL
            AND created_at >= ${heldBuildSince(now)}
          ORDER BY created_at DESC, id ASC LIMIT 1)
      )
       WHERE conversation_id = ${conversation.id}::uuid AND version = ${row.version}::int
    `;
  }
  await prune(tx, conversation.id, row.version, now);
  await announce(tx, conversation);
  return { version: row.version, revision: row.revision, outline };
}

export type AssetWrite = "stored" | "held" | "deck_full" | "held_full";

/** The bytes of the pictures the deck is using: those its latest version names, and those still in their grace. */
async function usedAssetBytes(db: Database, conversationId: string, now: Date): Promise<number> {
  const [used] = await db.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT SUM(octet_length(a.bytes))::bigint AS bytes
      FROM assistant_deck_asset a
      JOIN assistant_conversation c ON c.id = a.conversation_id
     WHERE a.conversation_id = ${conversationId}::uuid
       AND (
         a.created_at >= ${new Date(now.getTime() - ASSET_GRACE_MS)}
         OR EXISTS (
           SELECT 1 FROM assistant_deck_version v
            WHERE v.conversation_id = a.conversation_id
              AND v.version = c.deck_version
              AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
         )
       )
  `;
  return Number(used?.bytes ?? 0);
}

/**
 * Makes room for `incoming` more bytes under `MAX_HELD_ASSET_BYTES`, by deleting the fewest of the oldest versions
 * whose going leaves the pictures still held under it, and then the pictures nothing kept names. The newest
 * `KEEP_PPTX` versions are never deleted, since they are the ones the person can download: when room needs one of
 * them, nothing is deleted and the answer is `false`.
 */
async function makeRoom(db: Database, conversationId: string, incoming: number, now: Date): Promise<boolean> {
  const assets = await db.$queryRaw<{ sha256: string; bytes: number; fresh: boolean }[]>`
    SELECT sha256, octet_length(bytes) AS bytes, created_at >= ${new Date(now.getTime() - ASSET_GRACE_MS)} AS fresh
      FROM assistant_deck_asset WHERE conversation_id = ${conversationId}::uuid
  `;
  const held = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (held + incoming <= MAX_HELD_ASSET_BYTES) {
    return true;
  }
  const versions = await db.$queryRaw<{ version: number; refs: string[] }[]>`
    SELECT version, jsonb_path_query_array(outline, '$.slides[*].image.asset') AS refs
      FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid ORDER BY version ASC
  `;
  // Deleting the versions before `versions[cut]` keeps a picture that is fresh or named from `cut` on.
  const fits = (cut: number): boolean => {
    const named = new Set(versions.slice(cut).flatMap((one) => one.refs));
    const kept = assets.filter((asset) => asset.fresh || named.has(assetRef(asset.sha256))).reduce((sum, asset) => sum + asset.bytes, 0);
    return kept + incoming <= MAX_HELD_ASSET_BYTES;
  };
  const deletable = Math.max(0, versions.length - KEEP_PPTX);
  let cut = 0;
  while (cut < deletable && !fits(cut)) {
    cut += 1;
  }
  if (!fits(cut)) {
    return false;
  }
  const oldestKept = versions[cut]?.version;
  if (cut > 0 && oldestKept !== undefined) {
    await db.$executeRaw`DELETE FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid AND version < ${oldestKept}::int`;
  }
  await deleteUnnamedAssets(db, conversationId, now);
  return true;
}

/**
 * Stores one picture for the deck, under the digest of its bytes. Storing one already held changes nothing, so an
 * upload repeated after a lost answer is answered the same. `deck_full` is a picture that would take the pictures the
 * deck is using past `MAX_DECK_ASSET_BYTES`; one that would take every picture held past `MAX_HELD_ASSET_BYTES` makes
 * room by dropping old versions instead (`makeRoom`), and is `held_full` when only the newest `KEEP_PPTX` would.
 *
 * Not announced: nothing on screen shows a picture until an outline names it, and that write is announced.
 */
export async function putDeckAsset(
  prisma: PrismaClient,
  conversationId: string,
  sha256: string,
  bytes: Uint8Array,
  info: ImageInfo,
  now: Date = new Date()
): Promise<AssetWrite> {
  return await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const existing = await tx.assistantDeckAsset.count({ where: { conversationId, sha256 } });
    if (existing > 0) {
      // Touched, so a picture uploaded again for an outline about to name it gets its full grace again.
      await tx.assistantDeckAsset.update({ where: { conversationId_sha256: { conversationId, sha256 } }, data: { createdAt: now } });
      return "held";
    }
    if ((await usedAssetBytes(tx, conversationId, now)) + bytes.byteLength > MAX_DECK_ASSET_BYTES) {
      return "deck_full";
    }
    if (!(await makeRoom(tx, conversationId, bytes.byteLength, now))) {
      return "held_full";
    }
    await tx.assistantDeckAsset.create({
      data: { conversationId, sha256, mime: info.mime, bytes: Buffer.from(bytes), width: info.width, height: info.height, createdAt: now }
    });
    return "stored";
  });
}

export interface DeckAsset {
  mime: string;
  bytes: Uint8Array;
}

export async function readDeckAsset(db: Database, conversationId: string, sha256: string): Promise<DeckAsset | undefined> {
  const row = await db.assistantDeckAsset.findUnique({ where: { conversationId_sha256: { conversationId, sha256 } }, select: { mime: true, bytes: true } });
  return row ?? undefined;
}

/** Whether the deck holds the picture, without reading its bytes: what a revalidation needs to answer `304`. */
export async function holdsDeckAsset(db: Database, conversationId: string, sha256: string): Promise<boolean> {
  return (await db.assistantDeckAsset.count({ where: { conversationId, sha256 } })) > 0;
}

/** Each picture's size in pixels, or only those of `only`, so the browser can keep its room before it has loaded. */
export async function deckAssetSizes(db: Database, conversationId: string, only?: string[]): Promise<Record<string, { width: number; height: number }>> {
  const rows = await db.assistantDeckAsset.findMany({
    where: { conversationId, ...(only === undefined ? {} : { sha256: { in: only } }) },
    select: { sha256: true, width: true, height: true }
  });
  return Object.fromEntries(rows.map((row) => [row.sha256, { width: row.width, height: row.height }]));
}

export type PptxWrite = "stored" | "no_such_version" | "too_old";

/**
 * The .pptx the pod built from one version. Only the newest `KEEP_PPTX` versions keep one, so an upload for an older
 * version is refused as `too_old` rather than stored and pruned by the next write. Replacing one is allowed: it is a
 * rebuild of the same outline. Announced, because the panel's download appears with it.
 */
export async function putDeckPptx(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  version: number,
  bytes: Uint8Array
): Promise<PptxWrite> {
  return await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversation.id);
    const row = await tx.assistantConversation.findUnique({ where: { id: conversation.id }, select: { deckVersion: true } });
    const latest = row?.deckVersion ?? 0;
    if (version > latest) {
      return "no_such_version";
    }
    if (version <= latest - KEEP_PPTX) {
      return "too_old";
    }
    const { count } = await tx.assistantDeckVersion.updateMany({ where: { conversationId: conversation.id, version }, data: { pptx: Buffer.from(bytes) } });
    if (count === 0) {
      return "no_such_version";
    }
    await announce(tx, conversation);
    return "stored";
  });
}

/**
 * A fork's copy of the source's latest deck, as the copy's version 1 with its pictures and its .pptx, said to be the
 * person's so the copy's session is told there is a deck it has never seen. Inside the fork's own transaction.
 */
export async function copyDeck(db: Database, fromId: string, toId: string, now: Date): Promise<boolean> {
  const source = await db.assistantConversation.findUnique({ where: { id: fromId }, select: DECK_SELECT });
  if (source === null || source.deckVersion === 0) {
    return false;
  }
  const copied = await db.$executeRaw`
    INSERT INTO assistant_deck_version (conversation_id, version, outline, by, summary, created_at, pptx)
    SELECT ${toId}::uuid, 1, outline, 'user', summary, ${now}, pptx
      FROM assistant_deck_version
     WHERE conversation_id = ${fromId}::uuid AND version = ${source.deckVersion}::int
  `;
  if (copied === 0) {
    return false;
  }
  await db.$executeRaw`
    INSERT INTO assistant_deck_asset (conversation_id, sha256, mime, bytes, width, height, created_at)
    SELECT ${toId}::uuid, a.sha256, a.mime, a.bytes, a.width, a.height, ${now}
      FROM assistant_deck_asset a
      JOIN assistant_deck_version v ON v.conversation_id = a.conversation_id AND v.version = ${source.deckVersion}::int
     WHERE a.conversation_id = ${fromId}::uuid
       AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
  `;
  await db.assistantConversation.update({
    where: { id: toId },
    data: { deckVersion: 1, deckRevision: 1, deckTitle: source.deckTitle, deckUpdatedBy: "user", deckUpdatedAt: now }
  });
  return true;
}

/** The latest version of a deck as the slide viewer draws it; `null` for a conversation with none. */
export interface DeckView {
  title: string;
  outline: DeckOutline;
  version: number;
  /** The deck's revision as this was read; left out for an older version, which the history draws as a `DeckView` too. */
  revision?: number;
  updatedBy: DeckAuthor | null;
  updatedAt: string | null;
  /** Whether the latest version's .pptx can be downloaded (`pptxHeld`). */
  pptx: boolean;
  /** Each picture's size in pixels, by digest. */
  sizes: Record<string, { width: number; height: number }>;
}

export async function deckView(db: Database, conversationId: string, now: Date = new Date()): Promise<DeckView | null> {
  const deck = await readDeck(db, conversationId, now);
  if (deck.outline === null) {
    return null;
  }
  return {
    title: deck.title ?? deck.outline.title,
    outline: deck.outline,
    version: deck.version,
    revision: deck.revision,
    updatedBy: deck.updatedBy,
    updatedAt: deck.updatedAt?.toISOString() ?? null,
    pptx: deck.pptx,
    sizes: await deckAssetSizes(db, conversationId)
  };
}

/**
 * What a page carries about the latest version of a deck, which is all it needs to offer the slides and to know when
 * they have changed; the panel reads the outline itself, as `DeckView`, when it opens and whenever `version` moves on.
 * `null` for a conversation with none.
 */
export interface DeckSummary {
  title: string;
  version: number;
  revision: number;
  updatedBy: DeckAuthor | null;
  /** Whether the latest version's .pptx can be downloaded (`pptxHeld`). */
  pptx: boolean;
}

/** From the conversation's deck columns (`DECK_SELECT`), which the page has already read with the rest of its row. */
export async function deckSummary(
  db: Database,
  conversationId: string,
  row: { deckTitle: string | null; deckVersion: number; deckRevision: number; deckUpdatedBy: string | null },
  now: Date = new Date()
): Promise<DeckSummary | null> {
  if (row.deckVersion === 0 || row.deckTitle === null) {
    return null;
  }
  const [latest] = await db.$queryRaw<{ pptx: boolean }[]>`
    SELECT ${pptxHeld(now)} AS pptx FROM assistant_deck_version v WHERE v.conversation_id = ${conversationId}::uuid AND v.version = ${row.deckVersion}::int
  `;
  return { title: row.deckTitle, version: row.deckVersion, revision: row.deckRevision, updatedBy: author(row.deckUpdatedBy), pptx: latest?.pptx ?? false };
}
