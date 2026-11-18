import { HttpError } from "../agent-api/http.ts";
import { clientPrisma } from "../store/client-namespace.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { OLDEST_FIRST, podLacksItems } from "./artefact-store.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import {
  ASSET_GRACE_MS,
  assetRef,
  type DeckOutline,
  type ImageInfo,
  ITEMS_CREATE_REFUSED_DECK,
  KEEP_PPTX,
  KEEP_VERSIONS,
  MAX_DECK_ASSET_BYTES,
  MAX_HELD_ASSET_BYTES,
  outlineAssets,
  withSlideIds
} from "./deck.ts";
import { heldBuildSince } from "./deck-build.ts";

/**
 * A conversation's slide decks, any number of them, each written in versions the way a document is (`artefact-store.ts`):
 * a write names the version it was made from, and a newer one refuses it with what is there now. The conversation's
 * primary deck is its oldest, which `/api/agent/{id}/deck` and an older client read and write. The pod builds each version's .pptx and
 * sends it after the outline, so a version can be read before its .pptx exists.
 *
 * Every write applies the retention to its own deck in its own transaction: the newest `KEEP_VERSIONS` outlines stay, only the newest
 * `KEEP_PPTX` keep their .pptx, and a picture no kept outline names goes once it is older than `ASSET_GRACE_MS`. An
 * upload that would take the pictures held past `MAX_HELD_ASSET_BYTES` drops the oldest outlines to make room, never
 * one of the newest `KEEP_PPTX`, and is refused when only those would make it. A
 * write locks the conversation's row, as an asset upload and a .pptx upload do, so the three cannot interleave. Pictures are
 * the conversation's, not a deck's: one is kept while any of its decks' kept versions names it.
 */

export type DeckAuthor = "user" | "agent";

export interface Deck {
  /** Empty while the conversation has no deck. */
  id: string;
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

const EMPTY_DECK: Deck = { id: "", title: null, outline: null, version: 0, revision: 0, updatedBy: null, updatedAt: null, pptx: false };

export const DECK_SELECT = { id: true, title: true, version: true, revision: true, updatedBy: true, updatedAt: true } as const;

const author = (value: string | null): DeckAuthor | null => (value === "user" || value === "agent" ? value : null);

export function deckAuthor(row: { updatedBy: string | null }): DeckAuthor | null {
  return author(row.updatedBy);
}

/**
 * Whether the deck version aliased `v` has a .pptx to download: kept with it, or built on request and still held. The
 * one rule every read of a version's .pptx flag uses.
 */
export function pptxHeld(now: Date) {
  return clientPrisma().sql`(v.pptx IS NOT NULL OR EXISTS (
    SELECT 1 FROM assistant_deck_build b
     WHERE b.item_id = v.item_id AND b.version = v.version AND b.status = 'done' AND b.pptx IS NOT NULL
       AND b.created_at >= ${heldBuildSince(now)}
  ))`;
}

type ItemRow = { id: string; title: string | null; version: number; revision: number; updatedBy: string | null; updatedAt: Date | null };

async function deckOf(db: Database, row: ItemRow | null, now: Date): Promise<Deck> {
  if (row === null) {
    return EMPTY_DECK;
  }
  if (row.version === 0) {
    return { ...EMPTY_DECK, id: row.id, revision: row.revision };
  }
  const [latest] = await db.$queryRaw<{ outline: DeckOutline; pptx: boolean }[]>`
    SELECT v.outline, ${pptxHeld(now)} AS pptx FROM assistant_deck_version v WHERE v.item_id = ${row.id}::uuid AND v.version = ${row.version}::int
  `;
  return {
    id: row.id,
    title: row.title,
    outline: latest?.outline ?? null,
    version: row.version,
    revision: row.revision,
    updatedBy: author(row.updatedBy),
    updatedAt: row.updatedAt,
    pptx: latest?.pptx ?? false
  };
}

/** One of the conversation's decks, or `undefined` when it holds none of that id. */
export async function readDeckItem(db: Database, conversationId: string, itemId: string, now: Date = new Date()): Promise<Deck | undefined> {
  const row = await db.assistantDeck.findFirst({ where: { id: itemId, conversationId }, select: DECK_SELECT });
  return row === null ? undefined : await deckOf(db, row, now);
}

/** The primary deck, or an empty one at version 0 while the conversation has none: what `/deck` answers. */
export async function readDeck(db: Database, conversationId: string, now: Date = new Date()): Promise<Deck> {
  const row = await db.assistantDeck.findFirst({ where: { conversationId }, select: DECK_SELECT, orderBy: [...OLDEST_FIRST] });
  return await deckOf(db, row, now);
}

/** The newest kept version of the deck a session wrote, 0 when no kept version is one. */
export async function newestAgentVersion(db: Database, itemId: string): Promise<number> {
  const newest = await db.assistantDeckVersion.findFirst({
    where: { itemId, by: "agent" },
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

/** Version `version`'s outline of one deck, read under the conversation's lock. */
async function keptOutline(db: Database, conversationId: string, itemId: string, version: number): Promise<DeckOutline> {
  await lockConversation(db, conversationId);
  const row = await db.assistantDeckVersion.findUnique({ where: { itemId_version: { itemId, version } }, select: { outline: true } });
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

/** The retention of one deck: old outlines, old .pptx files, and pictures no kept outline names. `makeRoom` is the rest of it. */
export async function prune(db: Database, conversationId: string, itemId: string, latest: number, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_deck_version WHERE item_id = ${itemId}::uuid AND version <= ${latest - KEEP_VERSIONS}::int
  `;
  await db.$executeRaw`
    UPDATE assistant_deck_version SET pptx = NULL
     WHERE item_id = ${itemId}::uuid AND version <= ${latest - KEEP_PPTX}::int AND pptx IS NOT NULL
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
 * Writes a new version of a deck if `baseVersion` is still its version, and `baseRevision`, when given, its revision,
 * and answers the new one. Otherwise nothing is written and `DeckConflict` carries what is there now. Slides without
 * an id are given one, and every picture the outline names must already be held (`DeckAssetsMissing`). `editorOid` is
 * the person writing it through the web UI's editor, which is what lets their next edit amend it (`deck-edit-store.ts`).
 *
 * The deck is `itemId`'s (`404` when the conversation holds none of that id), or a new one with `create`, or, with
 * neither, the primary, which a write at base 0 makes when there is none. A deck is something in the chat, so the
 * first one records the conversation's first content, as a document does. A deck beyond the first is refused for a
 * pod whose client reads only the primary (`ITEMS_CREATE_REFUSED_DECK`).
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
): Promise<{ id: string; version: number; revision: number; outline: DeckOutline }> {
  return await prisma.$transaction(async (tx) => await writeDeckIn(tx, conversation, write, now));
}

export interface DeckWrite {
  outline: DeckOutline | { restore: number };
  baseVersion: number;
  baseRevision?: number;
  by: DeckAuthor;
  summary: string | null;
  editorOid?: string;
  /** The deck to write; left out, the primary. */
  itemId?: string;
  /** Makes a new deck, at base 0, whatever the conversation holds. */
  create?: boolean;
}

const MISSING_DECK = "that deck no longer exists";

/** The deck a write is of, made when it is new, under the conversation's lock. */
async function targetDeck(tx: Database, conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">, write: DeckWrite): Promise<string> {
  await lockConversation(tx, conversation.id);
  if (write.itemId !== undefined) {
    if ((await tx.assistantDeck.count({ where: { id: write.itemId, conversationId: conversation.id } })) === 0) {
      throw new HttpError(404, MISSING_DECK);
    }
    return write.itemId;
  }
  const held = await tx.assistantDeck.findMany({ where: { conversationId: conversation.id }, select: { id: true }, orderBy: [...OLDEST_FIRST], take: 1 });
  const primary = held[0];
  if (primary !== undefined && write.create !== true) {
    return primary.id;
  }
  if (primary !== undefined && (await podLacksItems(tx, conversation, "item-templates"))) {
    throw new HttpError(409, ITEMS_CREATE_REFUSED_DECK);
  }
  const made = await tx.assistantDeck.create({ data: { conversationId: conversation.id }, select: { id: true } });
  return made.id;
}

/** `writeDeck` in a transaction the caller holds, for a write that has read what it builds on under the same lock. */
export async function writeDeckIn(
  tx: Database,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: DeckWrite,
  now: Date
): Promise<{ id: string; version: number; revision: number; outline: DeckOutline }> {
  const itemId = await targetDeck(tx, conversation, write);
  const source = write.outline;
  const pptxOf = "restore" in source ? source.restore : undefined;
  const outline = "restore" in source ? await keptOutline(tx, conversation.id, itemId, source.restore) : withSlideIds(source);
  const updated = await tx.$queryRaw<{ version: number; revision: number }[]>`
    UPDATE assistant_deck
       SET title = ${outline.title},
           version = version + 1,
           revision = revision + 1,
           updated_by = ${write.by},
           updated_at = ${now}
     WHERE id = ${itemId}::uuid AND version = ${write.baseVersion}::int
       AND (${write.baseRevision ?? null}::int IS NULL OR revision = ${write.baseRevision ?? null}::int)
    RETURNING version, revision
  `;
  const [row] = updated;
  if (row === undefined) {
    throw new DeckConflict((await readDeckItem(tx, conversation.id, itemId, now)) as Deck);
  }
  await tx.$executeRaw`
    UPDATE assistant_conversation SET first_content_at = COALESCE(first_content_at, ${now}), updated_at = ${now} WHERE id = ${conversation.id}::uuid
  `;
  await requireHeldAssets(tx, conversation.id, outline);
  await tx.$executeRaw`
    INSERT INTO assistant_deck_version (item_id, conversation_id, version, outline, by, summary, created_at, editor_oid)
    VALUES (${itemId}::uuid, ${conversation.id}::uuid, ${row.version}::int, ${JSON.stringify(outline)}::jsonb, ${write.by}, ${write.summary}, ${now}, ${write.editorOid ?? null})
  `;
  if (pptxOf !== undefined) {
    await tx.$executeRaw`
      UPDATE assistant_deck_version SET pptx = COALESCE(
        (SELECT pptx FROM assistant_deck_version WHERE item_id = ${itemId}::uuid AND version = ${pptxOf}::int),
        (SELECT pptx FROM assistant_deck_build
          WHERE item_id = ${itemId}::uuid AND version = ${pptxOf}::int AND status = 'done' AND pptx IS NOT NULL
            AND created_at >= ${heldBuildSince(now)}
          ORDER BY created_at DESC, id ASC LIMIT 1)
      )
       WHERE item_id = ${itemId}::uuid AND version = ${row.version}::int
    `;
  }
  await prune(tx, conversation.id, itemId, row.version, now);
  await announce(tx, conversation);
  return { id: itemId, version: row.version, revision: row.revision, outline };
}

export type AssetWrite = "stored" | "held" | "deck_full" | "held_full";

/** The bytes of the pictures the conversation's decks are using: those their latest versions name, and those still in their grace. */
async function usedAssetBytes(db: Database, conversationId: string, now: Date): Promise<number> {
  const [used] = await db.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT SUM(octet_length(a.bytes))::bigint AS bytes
      FROM assistant_deck_asset a
     WHERE a.conversation_id = ${conversationId}::uuid
       AND (
         a.created_at >= ${new Date(now.getTime() - ASSET_GRACE_MS)}
         OR EXISTS (
           SELECT 1 FROM assistant_deck d
             JOIN assistant_deck_version v ON v.item_id = d.id AND v.version = d.version
            WHERE d.conversation_id = a.conversation_id
              AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
         )
       )
  `;
  return Number(used?.bytes ?? 0);
}

/**
 * Makes room for `incoming` more bytes under `MAX_HELD_ASSET_BYTES`, by deleting the fewest of the conversation's oldest
 * versions, across its decks, whose going leaves the pictures still held under it, and then the pictures nothing kept
 * names. Each deck's newest `KEEP_PPTX` versions are never deleted, since they are the ones the person can download:
 * when room needs one of them, nothing is deleted and the answer is `false`.
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
  const versions = await db.$queryRaw<{ item_id: string; version: number; refs: string[]; newest: number }[]>`
    SELECT item_id::text AS item_id, version, jsonb_path_query_array(outline, '$.slides[*].image.asset') AS refs,
           row_number() OVER (PARTITION BY item_id ORDER BY version DESC)::int AS newest
      FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid ORDER BY created_at ASC, item_id ASC, version ASC
  `;
  const deletable = versions.filter((one) => one.newest > KEEP_PPTX);
  // Deleting the first `cut` deletable versions keeps a picture that is fresh or named by a version left.
  const fits = (cut: number): boolean => {
    const gone = new Set(deletable.slice(0, cut));
    const named = new Set(versions.filter((one) => !gone.has(one)).flatMap((one) => one.refs));
    const kept = assets.filter((asset) => asset.fresh || named.has(assetRef(asset.sha256))).reduce((sum, asset) => sum + asset.bytes, 0);
    return kept + incoming <= MAX_HELD_ASSET_BYTES;
  };
  let cut = 0;
  while (cut < deletable.length && !fits(cut)) {
    cut += 1;
  }
  if (!fits(cut)) {
    return false;
  }
  const doomed = deletable.slice(0, cut);
  if (doomed.length > 0) {
    await db.$executeRaw`
      DELETE FROM assistant_deck_version v USING unnest(${doomed.map((one) => one.item_id)}::uuid[], ${doomed.map((one) => one.version)}::int[]) AS d(item_id, version)
       WHERE v.item_id = d.item_id AND v.version = d.version
    `;
  }
  await deleteUnnamedAssets(db, conversationId, now);
  return true;
}

/**
 * Stores one picture for the conversation's decks, under the digest of its bytes. Storing one already held changes nothing, so an
 * upload repeated after a lost answer is answered the same. `deck_full` is a picture that would take the pictures the
 * decks are using past `MAX_DECK_ASSET_BYTES`; one that would take every picture held past `MAX_HELD_ASSET_BYTES` makes
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
 * The .pptx the pod built from one version of one deck. Only the newest `KEEP_PPTX` versions keep one, so an upload for
 * an older version is refused as `too_old` rather than stored and pruned by the next write. Replacing one is allowed:
 * it is a rebuild of the same outline. Announced, because the panel's download appears with it.
 */
export async function putDeckPptx(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  itemId: string,
  version: number,
  bytes: Uint8Array
): Promise<PptxWrite> {
  return await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversation.id);
    const row = await tx.assistantDeck.findFirst({ where: { id: itemId, conversationId: conversation.id }, select: { version: true } });
    if (row === null) {
      return "no_such_version";
    }
    const latest = row.version;
    if (version > latest) {
      return "no_such_version";
    }
    if (version <= latest - KEEP_PPTX) {
      return "too_old";
    }
    const { count } = await tx.assistantDeckVersion.updateMany({ where: { itemId, version }, data: { pptx: Buffer.from(bytes) } });
    if (count === 0) {
      return "no_such_version";
    }
    await announce(tx, conversation);
    return "stored";
  });
}

/**
 * A fork's copy of each of the source's decks' latest versions, as the copy's version 1 of a deck of its own, with its
 * pictures and its .pptx, said to be the person's so the copy's session is told there are decks it has never seen. In
 * the source's order. Inside the fork's own transaction.
 */
export async function copyDeck(db: Database, fromId: string, toId: string, now: Date): Promise<boolean> {
  const sources = await db.assistantDeck.findMany({ where: { conversationId: fromId, version: { gt: 0 } }, select: DECK_SELECT, orderBy: [...OLDEST_FIRST] });
  let copied = false;
  for (const [index, source] of sources.entries()) {
    const made = await db.assistantDeck.create({
      data: {
        conversationId: toId,
        version: 1,
        revision: 1,
        title: source.title,
        updatedBy: "user",
        updatedAt: now,
        createdAt: new Date(now.getTime() + index)
      },
      select: { id: true }
    });
    const rows = await db.$executeRaw`
      INSERT INTO assistant_deck_version (item_id, conversation_id, version, outline, by, summary, created_at, pptx)
      SELECT ${made.id}::uuid, ${toId}::uuid, 1, outline, 'user', summary, ${now}, pptx
        FROM assistant_deck_version
       WHERE item_id = ${source.id}::uuid AND version = ${source.version}::int
    `;
    if (rows === 0) {
      await db.assistantDeck.delete({ where: { id: made.id } });
      continue;
    }
    await db.$executeRaw`
      INSERT INTO assistant_deck_asset (conversation_id, sha256, mime, bytes, width, height, created_at)
      SELECT ${toId}::uuid, a.sha256, a.mime, a.bytes, a.width, a.height, ${now}
        FROM assistant_deck_asset a
        JOIN assistant_deck_version v ON v.item_id = ${source.id}::uuid AND v.version = ${source.version}::int
       WHERE a.conversation_id = ${fromId}::uuid
         AND jsonb_path_exists(v.outline, '$.slides[*].image.asset ? (@ == $ref)', jsonb_build_object('ref', 'sha256:' || a.sha256))
      ON CONFLICT (conversation_id, sha256) DO NOTHING
    `;
    copied = true;
  }
  return copied;
}

/** Removes one deck, with its versions and builds, and the pictures no remaining deck's versions name once they are past their grace. */
export async function removeDeck(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  itemId: string,
  now: Date = new Date()
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversation.id);
    const { count } = await tx.assistantDeck.deleteMany({ where: { id: itemId, conversationId: conversation.id } });
    if (count === 0) {
      throw new HttpError(404, MISSING_DECK);
    }
    await deleteUnnamedAssets(tx, conversation.id, now);
    await announce(tx, conversation);
  });
}

/** The latest version of a deck as the slide viewer draws it; `null` for a deck with none. */
export interface DeckView {
  id: string;
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

export async function deckView(db: Database, conversationId: string, itemId: string, now: Date = new Date()): Promise<DeckView | null> {
  const deck = await readDeckItem(db, conversationId, itemId, now);
  if (deck === undefined || deck.outline === null) {
    return null;
  }
  return {
    id: deck.id,
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
 */
export interface DeckSummary {
  id: string;
  title: string;
  version: number;
  revision: number;
  updatedBy: DeckAuthor | null;
  /** Whether the latest version's .pptx can be downloaded (`pptxHeld`). */
  pptx: boolean;
}

/** From a deck's row (`DECK_SELECT`); `null` for a deck with no version yet. */
export async function deckSummary(db: Database, row: Omit<ItemRow, "updatedAt">, now: Date = new Date()): Promise<DeckSummary | null> {
  if (row.version === 0 || row.title === null) {
    return null;
  }
  const [latest] = await db.$queryRaw<{ pptx: boolean }[]>`
    SELECT ${pptxHeld(now)} AS pptx FROM assistant_deck_version v WHERE v.item_id = ${row.id}::uuid AND v.version = ${row.version}::int
  `;
  return { id: row.id, title: row.title, version: row.version, revision: row.revision, updatedBy: author(row.updatedBy), pptx: latest?.pptx ?? false };
}

/** Every deck of the conversation, oldest first. */
export async function listDeckSummaries(db: Database, conversationId: string, now: Date = new Date()): Promise<DeckSummary[]> {
  const rows = await db.assistantDeck.findMany({ where: { conversationId, version: { gt: 0 } }, select: DECK_SELECT, orderBy: [...OLDEST_FIRST] });
  const summaries = await Promise.all(rows.map((row) => deckSummary(db, row, now)));
  return summaries.filter((summary): summary is DeckSummary => summary !== null);
}
