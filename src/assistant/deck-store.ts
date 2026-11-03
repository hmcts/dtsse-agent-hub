import { HttpError } from "../agent-api/http.ts";
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
  outlineAssets,
  withSlideIds
} from "./deck.ts";

/**
 * A conversation's slide deck, written in versions the way its document is (`artefact-store.ts`): a write names the
 * version it was made from, and a newer one refuses it with what is there now. The pod builds each version's .pptx and
 * sends it after the outline, so a version can be read before its .pptx exists.
 *
 * Every write applies the retention in its own transaction: the newest `KEEP_VERSIONS` outlines stay, only the newest
 * `KEEP_PPTX` keep their .pptx, and a picture no kept outline names goes once it is older than `ASSET_GRACE_MS`. A
 * write locks the conversation's row, as an asset upload and a .pptx upload do, so the three cannot interleave.
 */

export type DeckAuthor = "user" | "agent";

export interface Deck {
  /** `null` and `outline: null` while `version` is 0, before anything has written one. */
  title: string | null;
  outline: DeckOutline | null;
  version: number;
  updatedBy: DeckAuthor | null;
  updatedAt: Date | null;
  /** Whether the hub holds the latest version's .pptx. */
  pptx: boolean;
}

const EMPTY_DECK: Deck = { title: null, outline: null, version: 0, updatedBy: null, updatedAt: null, pptx: false };

export const DECK_SELECT = { deckTitle: true, deckVersion: true, deckUpdatedBy: true, deckUpdatedAt: true } as const;

const author = (value: string | null): DeckAuthor | null => (value === "user" || value === "agent" ? value : null);

export function deckAuthor(row: { deckUpdatedBy: string | null }): DeckAuthor | null {
  return author(row.deckUpdatedBy);
}

export async function readDeck(db: Database, conversationId: string): Promise<Deck> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: DECK_SELECT });
  if (row === null || row.deckVersion === 0) {
    return EMPTY_DECK;
  }
  const [latest] = await db.$queryRaw<{ outline: DeckOutline; pptx: boolean }[]>`
    SELECT outline, pptx IS NOT NULL AS pptx FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid AND version = ${row.deckVersion}::int
  `;
  return {
    title: row.deckTitle,
    outline: latest?.outline ?? null,
    version: row.deckVersion,
    updatedBy: author(row.deckUpdatedBy),
    updatedAt: row.deckUpdatedAt,
    pptx: latest?.pptx ?? false
  };
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

/** Locks the conversation's row for the rest of the transaction, which is what every deck write queues on. */
async function lockConversation(db: Database, conversationId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM assistant_conversation WHERE id = ${conversationId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/** The retention: old outlines, old .pptx files, and pictures no kept outline names. */
async function prune(db: Database, conversationId: string, latest: number, now: Date): Promise<void> {
  await db.$executeRaw`
    DELETE FROM assistant_deck_version WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_VERSIONS}::int
  `;
  await db.$executeRaw`
    UPDATE assistant_deck_version SET pptx = NULL
     WHERE conversation_id = ${conversationId}::uuid AND version <= ${latest - KEEP_PPTX}::int AND pptx IS NOT NULL
  `;
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

/**
 * Writes a new version of the conversation's deck if `baseVersion` is still its version, and answers the new one.
 * Otherwise nothing is written and `DeckConflict` carries what is there now. Slides without an id are given one, and
 * every picture the outline names must already be held (`DeckAssetsMissing`).
 *
 * A deck is something in the chat, so the first one records the conversation's first content, as a document does.
 */
export async function writeDeck(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: { outline: DeckOutline; baseVersion: number; by: DeckAuthor; summary: string | null },
  now: Date = new Date()
): Promise<{ version: number; outline: DeckOutline }> {
  const outline = withSlideIds(write.outline);
  const named = outlineAssets(outline);
  return await prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw<{ version: number }[]>`
      UPDATE assistant_conversation
         SET deck_title = ${outline.title},
             deck_version = deck_version + 1,
             deck_updated_by = ${write.by},
             deck_updated_at = ${now},
             first_content_at = COALESCE(first_content_at, ${now}),
             updated_at = ${now}
       WHERE id = ${conversation.id}::uuid AND deck_version = ${write.baseVersion}::int
      RETURNING deck_version AS version
    `;
    const [row] = updated;
    if (row === undefined) {
      throw new DeckConflict(await readDeck(tx, conversation.id));
    }
    if (named.length > 0) {
      const held = await tx.$queryRaw<{ sha256: string }[]>`
        SELECT sha256 FROM assistant_deck_asset WHERE conversation_id = ${conversation.id}::uuid AND sha256 = ANY(${named}::text[])
      `;
      const have = new Set(held.map((asset) => asset.sha256));
      const missing = named.filter((sha) => !have.has(sha));
      if (missing.length > 0) {
        throw new DeckAssetsMissing(missing);
      }
    }
    await tx.$executeRaw`
      INSERT INTO assistant_deck_version (conversation_id, version, outline, by, summary, created_at)
      VALUES (${conversation.id}::uuid, ${row.version}::int, ${JSON.stringify(outline)}::jsonb, ${write.by}, ${write.summary}, ${now})
    `;
    await prune(tx, conversation.id, row.version, now);
    await announce(tx, conversation);
    return { version: row.version, outline };
  });
}

export type AssetWrite = "stored" | "held" | "deck_full";

/**
 * Stores one picture for the deck, under the digest of its bytes. Storing one already held changes nothing, so an
 * upload repeated after a lost answer is answered the same. `deck_full` is a picture that would take the deck's
 * pictures past `MAX_DECK_ASSET_BYTES`.
 *
 * Not announced: nothing on screen shows a picture until an outline names it, and that write is announced.
 */
export async function putDeckAsset(prisma: PrismaClient, conversationId: string, sha256: string, bytes: Uint8Array, info: ImageInfo): Promise<AssetWrite> {
  return await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const existing = await tx.assistantDeckAsset.count({ where: { conversationId, sha256 } });
    if (existing > 0) {
      // Touched, so a picture uploaded again for an outline about to name it gets its full grace again.
      await tx.assistantDeckAsset.update({ where: { conversationId_sha256: { conversationId, sha256 } }, data: { createdAt: new Date() } });
      return "held";
    }
    const [total] = await tx.$queryRaw<{ bytes: bigint | null }[]>`
      SELECT SUM(octet_length(bytes))::bigint AS bytes FROM assistant_deck_asset WHERE conversation_id = ${conversationId}::uuid
    `;
    if (Number(total?.bytes ?? 0) + bytes.byteLength > MAX_DECK_ASSET_BYTES) {
      return "deck_full";
    }
    await tx.assistantDeckAsset.create({
      data: { conversationId, sha256, mime: info.mime, bytes: Buffer.from(bytes), width: info.width, height: info.height }
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

/** Each picture's size in pixels, so the browser can keep its room before it has loaded. */
export async function deckAssetSizes(db: Database, conversationId: string): Promise<Record<string, { width: number; height: number }>> {
  const rows = await db.assistantDeckAsset.findMany({ where: { conversationId }, select: { sha256: true, width: true, height: true } });
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

export async function readDeckPptx(db: Database, conversationId: string, version: number): Promise<{ title: string; bytes: Uint8Array } | undefined> {
  const row = await db.assistantDeckVersion.findUnique({
    where: { conversationId_version: { conversationId, version } },
    select: { pptx: true, outline: true }
  });
  if (row?.pptx === null || row?.pptx === undefined) {
    return undefined;
  }
  return { title: (row.outline as unknown as DeckOutline).title, bytes: row.pptx };
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
    data: { deckVersion: 1, deckTitle: source.deckTitle, deckUpdatedBy: "user", deckUpdatedAt: now }
  });
  return true;
}

/** The latest version of a deck as the slide viewer draws it; `null` for a conversation with none. */
export interface DeckView {
  title: string;
  outline: DeckOutline;
  version: number;
  updatedBy: DeckAuthor | null;
  updatedAt: string | null;
  /** Whether the latest version's .pptx can be downloaded. */
  pptx: boolean;
  /** Each picture's size in pixels, by digest. */
  sizes: Record<string, { width: number; height: number }>;
}

export async function deckView(db: Database, conversationId: string): Promise<DeckView | null> {
  const deck = await readDeck(db, conversationId);
  if (deck.outline === null) {
    return null;
  }
  return {
    title: deck.title ?? deck.outline.title,
    outline: deck.outline,
    version: deck.version,
    updatedBy: deck.updatedBy,
    updatedAt: deck.updatedAt?.toISOString() ?? null,
    pptx: deck.pptx,
    sizes: await deckAssetSizes(db, conversationId)
  };
}
