import { clientPrisma } from "../store/client-namespace.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import type { ConversationRow } from "./conversation-row.ts";
import { type DeckOutline, outlineAssets } from "./deck.ts";
import { heldBuildSince } from "./deck-build.ts";
import { DeckAssetsMissing, type DeckAuthor, DeckConflict, DeckVersionGone, deckAssetSizes, deckAuthor, pptxHeld, writeDeck } from "./deck-store.ts";

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
  /** Whether a .pptx of this version can be downloaded now (`pptxHeld`). */
  pptx: boolean;
}

/** One kept version with its outline, as the agent API reads it. */
export interface DeckVersionOutline extends DeckVersionEntry {
  title: string;
  outline: DeckOutline;
}

/** One kept version, outline and all, as the slide viewer draws it. */
export interface DeckVersionView extends DeckVersionOutline {
  /** Each picture this version names that the deck still holds, by digest. */
  sizes: Record<string, { width: number; height: number }>;
}

const byOf = (value: string): DeckAuthor => deckAuthor({ deckUpdatedBy: value }) ?? "agent";

interface VersionRow {
  version: number;
  by: string;
  summary: string | null;
  created_at: Date;
  pptx: boolean;
  outline: DeckOutline | null;
}

/**
 * The deck's kept versions, newest first, or only `version` when it is a number, with its outline; the .pptx is tested
 * for, never read, and the list carries no outlines.
 */
async function versionRows(db: Database, conversationId: string, version: number | null, now: Date): Promise<VersionRow[]> {
  const { sql } = clientPrisma();
  return await db.$queryRaw<VersionRow[]>`
    SELECT v.version, v.by, v.summary, v.created_at, ${pptxHeld(now)} AS pptx, ${version === null ? sql`NULL::jsonb` : sql`v.outline`} AS outline
      FROM assistant_deck_version v
     WHERE v.conversation_id = ${conversationId}::uuid AND (${version}::int IS NULL OR v.version = ${version}::int)
     ORDER BY v.version DESC
  `;
}

const entryOf = (row: VersionRow): DeckVersionEntry => ({
  version: row.version,
  by: byOf(row.by),
  summary: row.summary,
  created_at: row.created_at.toISOString(),
  pptx: row.pptx
});

/** Every kept version of the deck, newest first; empty for a conversation with none. */
export async function listDeckVersions(db: Database, conversationId: string, now: Date = new Date()): Promise<DeckVersionEntry[]> {
  return (await versionRows(db, conversationId, null, now)).map(entryOf);
}

/** One kept version as the history lists it, or `undefined` for one the deck does not keep. */
export async function readDeckVersionEntry(
  db: Database,
  conversationId: string,
  version: number,
  now: Date = new Date()
): Promise<DeckVersionEntry | undefined> {
  const [row] = await versionRows(db, conversationId, version, now);
  return row === undefined ? undefined : entryOf(row);
}

/** One kept version with its outline, or `undefined` for one the deck does not keep. */
export async function readDeckVersionOutline(
  db: Database,
  conversationId: string,
  version: number,
  now: Date = new Date()
): Promise<DeckVersionOutline | undefined> {
  const [row] = await versionRows(db, conversationId, version, now);
  if (row?.outline === null || row?.outline === undefined) {
    return undefined;
  }
  return { ...entryOf(row), title: row.outline.title, outline: row.outline };
}

/** One kept version with the sizes of the pictures it names, or `undefined` for one the deck does not keep. */
export async function readDeckVersion(db: Database, conversationId: string, version: number, now: Date = new Date()): Promise<DeckVersionView | undefined> {
  const found = await readDeckVersionOutline(db, conversationId, version, now);
  if (found === undefined) {
    return undefined;
  }
  return { ...found, sizes: await deckAssetSizes(db, conversationId, outlineAssets(found.outline)) };
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
    where: { conversationId, version, status: "done", createdAt: { gte: heldBuildSince(now) } },
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
  | { restored: false; picturesGone: true }
  | { restored: false; latest: true };

/**
 * Writes the outline of `version` again as the deck's next version, said to be the person's, if the deck is still at
 * `baseVersion`; otherwise nothing is written and the version there now comes back, as a conflicting write does.
 * Restoring the latest version would write a copy of what is already there, so it is refused instead.
 *
 * The outline is the same, so a .pptx the hub holds for the old version is the new version's too, and is kept with
 * it: the person sees the restored version as built straight away, rather than waiting for the session to rebuild it.
 * The outline and the .pptx are read under the write's own lock (`writeDeck`), so a concurrent write or picture upload
 * cannot drop the version between the read and the write: one that already has is `missing`. A version naming a
 * picture the hub no longer holds is `picturesGone`.
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
  let written: { version: number };
  try {
    written = await writeDeck(
      prisma,
      conversation,
      {
        outline: { restore: restore.version },
        baseVersion: restore.baseVersion,
        by: "user",
        summary: `Restored version ${restore.version}`
      },
      now
    );
  } catch (error) {
    if (error instanceof DeckConflict) {
      return { restored: false, current: { version: error.current.version, updatedBy: error.current.updatedBy } };
    }
    if (error instanceof DeckVersionGone) {
      return { restored: false, missing: true };
    }
    if (error instanceof DeckAssetsMissing) {
      return { restored: false, picturesGone: true };
    }
    throw error;
  }
  return { restored: true, version: written.version };
}
