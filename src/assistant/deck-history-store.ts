import type { Database, PrismaClient } from "../store/prisma.ts";
import type { ConversationRow } from "./conversation-row.ts";
import { type DeckOutline, outlineAssets } from "./deck.ts";
import { DECK_BUILD_KEEP_MS } from "./deck-build.ts";
import { type DeckAuthor, DeckConflict, deckAssetSizes, deckAuthor, writeDeck } from "./deck-store.ts";

/**
 * A deck's kept versions as the browser looks back through them: the list, one version's outline, the .pptx of any
 * version the hub holds one for, and the owner's restore of an older one as the next version. Who may do which is
 * `canReadDeck` and `canChangeDeck`, applied by the callers in `web/data.ts` and the restore action.
 */

/** One kept version, as the history lists it. */
export interface DeckVersionEntry {
  version: number;
  by: DeckAuthor;
  summary: string | null;
  created_at: string;
  /** When it was last written: an amend's time, or `created_at` for a version never amended. */
  updated_at: string;
  /** Whether a .pptx of this version can be downloaded now: kept with it, or built on request and not yet swept. */
  pptx: boolean;
}

/** One kept version, outline and all, as the slide viewer draws it. */
export interface DeckVersionView extends DeckVersionEntry {
  title: string;
  outline: DeckOutline;
  /** Each picture this version names that the deck still holds, by digest. */
  sizes: Record<string, { width: number; height: number }>;
}

const freshSince = (now: Date): Date => new Date(now.getTime() - DECK_BUILD_KEEP_MS);

const byOf = (value: string): DeckAuthor => deckAuthor({ deckUpdatedBy: value }) ?? "agent";

/** The deck's kept versions, newest first, or only `version` when it is a number; the .pptx is tested for, never read. */
async function versionEntries(db: Database, conversationId: string, version: number | null, now: Date): Promise<DeckVersionEntry[]> {
  const rows = await db.$queryRaw<{ version: number; by: string; summary: string | null; created_at: Date; updated_at: Date; pptx: boolean }[]>`
    SELECT v.version, v.by, v.summary, v.created_at, COALESCE(v.updated_at, v.created_at) AS updated_at,
           (v.pptx IS NOT NULL OR EXISTS (
             SELECT 1 FROM assistant_deck_build b
              WHERE b.conversation_id = v.conversation_id AND b.version = v.version AND b.status = 'done' AND b.created_at >= ${freshSince(now)}
           )) AS pptx
      FROM assistant_deck_version v
     WHERE v.conversation_id = ${conversationId}::uuid AND (${version}::int IS NULL OR v.version = ${version}::int)
     ORDER BY v.version DESC
  `;
  return rows.map((row) => ({
    version: row.version,
    by: byOf(row.by),
    summary: row.summary,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    pptx: row.pptx
  }));
}

/** Every kept version of the deck, newest first; empty for a conversation with none. */
export async function listDeckVersions(db: Database, conversationId: string, now: Date = new Date()): Promise<DeckVersionEntry[]> {
  return await versionEntries(db, conversationId, null, now);
}

/** One kept version as the history lists it, or `undefined` for one the deck does not keep. */
export async function readDeckVersionEntry(
  db: Database,
  conversationId: string,
  version: number,
  now: Date = new Date()
): Promise<DeckVersionEntry | undefined> {
  const [entry] = await versionEntries(db, conversationId, version, now);
  return entry;
}

/** One kept version, or `undefined` for one the deck does not keep. */
export async function readDeckVersion(db: Database, conversationId: string, version: number, now: Date = new Date()): Promise<DeckVersionView | undefined> {
  const entry = await readDeckVersionEntry(db, conversationId, version, now);
  const row = await db.assistantDeckVersion.findUnique({ where: { conversationId_version: { conversationId, version } }, select: { outline: true } });
  if (entry === undefined || row === null) {
    return undefined;
  }
  const outline = row.outline as unknown as DeckOutline;
  const named = new Set(outlineAssets(outline));
  const sizes = Object.fromEntries(Object.entries(await deckAssetSizes(db, conversationId)).filter(([sha]) => named.has(sha)));
  return { ...entry, title: outline.title, outline, sizes };
}

/**
 * The .pptx of one version: the one kept with it, or else the newest one built on request that has not been swept.
 * `undefined` when there is neither.
 */
export async function readVersionPptx(
  db: Database,
  conversationId: string,
  version: number,
  now: Date = new Date()
): Promise<{ title: string; bytes: Uint8Array } | undefined> {
  const row = await db.assistantDeckVersion.findUnique({
    where: { conversationId_version: { conversationId, version } },
    select: { pptx: true, outline: true }
  });
  const title = (row?.outline as unknown as DeckOutline | undefined)?.title;
  if (row?.pptx !== null && row?.pptx !== undefined && title !== undefined) {
    return { title, bytes: row.pptx };
  }
  const built = await db.assistantDeckBuild.findFirst({
    where: { conversationId, version, status: "done", createdAt: { gte: freshSince(now) } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { pptx: true }
  });
  if (built?.pptx === null || built?.pptx === undefined) {
    return undefined;
  }
  // A version swept since its build was asked for still downloads under the deck's own title.
  const deck = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { deckTitle: true } });
  return { title: title ?? deck?.deckTitle ?? "slides", bytes: built.pptx };
}

export type RestoreResult =
  | { restored: true; version: number }
  | { restored: false; current: { version: number; updatedBy: DeckAuthor | null } }
  | { restored: false; missing: true }
  | { restored: false; latest: true };

/**
 * Writes the outline of `version` again as the deck's next version, said to be the person's, if the deck is still at
 * `baseVersion`; otherwise nothing is written and the version there now comes back, as a conflicting write does.
 * Restoring the latest version would write a copy of what is already there, so it is refused instead.
 *
 * The outline is the same, so a .pptx the hub holds for the old version is the new version's too, and is kept with
 * it: the person sees the restored version as built straight away, rather than waiting for the session to rebuild it.
 * It is copied in the write's own transaction, before the write's retention can drop the old version's.
 */
export async function restoreDeckVersion(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  restore: { version: number; baseVersion: number },
  now: Date = new Date()
): Promise<RestoreResult> {
  if (restore.version === restore.baseVersion) {
    return { restored: false, latest: true };
  }
  const source = await prisma.assistantDeckVersion.findUnique({
    where: { conversationId_version: { conversationId: conversation.id, version: restore.version } },
    select: { outline: true }
  });
  if (source === null) {
    return { restored: false, missing: true };
  }
  let written: { version: number };
  try {
    written = await writeDeck(
      prisma,
      conversation,
      {
        outline: source.outline as unknown as DeckOutline,
        baseVersion: restore.baseVersion,
        by: "user",
        summary: `Restored version ${restore.version}`,
        pptxOf: restore.version
      },
      now
    );
  } catch (error) {
    if (error instanceof DeckConflict) {
      return { restored: false, current: { version: error.current.version, updatedBy: error.current.updatedBy } };
    }
    throw error;
  }
  return { restored: true, version: written.version };
}
