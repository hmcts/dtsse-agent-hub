import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { type DeckOutline, withSlideIds } from "./deck.ts";
import { AMENDED_BUILD_ERROR, amends, editSummary, sameOutline } from "./deck-edit.ts";
import { type Deck, lockConversation, prune, readDeck, requireHeldAssets, writeDeckIn } from "./deck-store.ts";

/**
 * The owner's save of their deck from the web UI's editor. Saves in quick succession amend the person's own latest
 * version in place (`amends` in `deck-edit.ts`), so editing for a while does not push the history's older versions out
 * of the 100 kept; any other save writes the next version through `writeDeckIn`, said to be the person's. Either moves
 * the conversation's revision on, which is how a session and another tab see an amend. An outline the same as the
 * version it was made from writes nothing.
 */

export type DeckEditResult =
  | { saved: true; version: number; revision: number; outline: DeckOutline; amended: boolean; unchanged: boolean }
  | { saved: false; current: Deck };

type Conversation = Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">;

type Edit = { outline: DeckOutline; baseVersion: number; baseRevision: number; editorOid: string };

/**
 * The amend: the version's outline and summary replaced, its .pptx and its finished builds dropped, since they show
 * what it said before, a build still pending failed so the panel's poll says so and the pod's answer to it is ignored,
 * and the retention applied, which frees pictures the amend stopped naming.
 */
async function amendLatest(
  tx: Database,
  conversation: Conversation,
  edit: Edit,
  row: { version: number; revision: number },
  now: Date
): Promise<DeckEditResult> {
  await requireHeldAssets(tx, conversation.id, edit.outline);
  const previous = await tx.assistantDeckVersion.findUnique({
    where: { conversationId_version: { conversationId: conversation.id, version: row.version - 1 } },
    select: { outline: true }
  });
  const summary = editSummary((previous?.outline ?? undefined) as DeckOutline | undefined, edit.outline);
  await tx.$executeRaw`
    UPDATE assistant_deck_version
       SET outline = ${JSON.stringify(edit.outline)}::jsonb, summary = ${summary}, updated_at = ${now}, pptx = NULL
     WHERE conversation_id = ${conversation.id}::uuid AND version = ${row.version}::int
  `;
  await tx.$executeRaw`
    DELETE FROM assistant_deck_build WHERE conversation_id = ${conversation.id}::uuid AND version = ${row.version}::int AND status <> 'pending'
  `;
  await tx.$executeRaw`
    UPDATE assistant_deck_build SET status = 'failed', error = ${AMENDED_BUILD_ERROR}, finished_at = ${now}
     WHERE conversation_id = ${conversation.id}::uuid AND version = ${row.version}::int AND status = 'pending'
  `;
  const [moved] = await tx.$queryRaw<{ revision: number }[]>`
    UPDATE assistant_conversation
       SET deck_title = ${edit.outline.title},
           deck_revision = deck_revision + 1,
           deck_updated_by = 'user',
           deck_updated_at = ${now},
           updated_at = ${now}
     WHERE id = ${conversation.id}::uuid
    RETURNING deck_revision AS revision
  `;
  await prune(tx, conversation.id, row.version, now);
  await announce(tx, conversation);
  return { saved: true, version: row.version, revision: moved?.revision ?? row.revision + 1, outline: edit.outline, amended: true, unchanged: false };
}

/**
 * Saves the person's outline if the deck is still at `baseVersion` and `baseRevision`; otherwise nothing is written
 * and the answer carries what is there now. One transaction holds the conversation's row from reading the base to
 * the write, so nothing can land in between. An outline naming a picture the deck does not hold is refused with
 * `DeckAssetsMissing`, and one the same as the base is answered `unchanged` with nothing written. Who may save is
 * `canChangeDeck`, applied by the caller.
 */
export async function saveDeckEdit(prisma: PrismaClient, conversation: Conversation, edit: Edit, now: Date = new Date()): Promise<DeckEditResult> {
  const outline = withSlideIds(edit.outline);
  return await prisma.$transaction(async (tx): Promise<DeckEditResult> => {
    await lockConversation(tx, conversation.id);
    const held = await tx.assistantConversation.findUnique({ where: { id: conversation.id }, select: { deckVersion: true, deckRevision: true } });
    const row = held === null ? undefined : { version: held.deckVersion, revision: held.deckRevision };
    if (row === undefined || row.version !== edit.baseVersion || row.revision !== edit.baseRevision) {
      return { saved: false, current: await readDeck(tx, conversation.id, now) };
    }
    const latest =
      row.version === 0
        ? null
        : await tx.assistantDeckVersion.findUnique({
            where: { conversationId_version: { conversationId: conversation.id, version: row.version } },
            select: { by: true, editorOid: true, createdAt: true, outline: true }
          });
    const base = (latest?.outline ?? undefined) as DeckOutline | undefined;
    if (sameOutline(base, outline)) {
      return { saved: true, version: row.version, revision: row.revision, outline: base as DeckOutline, amended: false, unchanged: true };
    }
    if (latest !== null && amends(latest, edit.editorOid, now)) {
      return await amendLatest(tx, conversation, { ...edit, outline }, row, now);
    }
    const written = await writeDeckIn(
      tx,
      conversation,
      { outline, baseVersion: row.version, baseRevision: row.revision, by: "user", summary: editSummary(base, outline), editorOid: edit.editorOid },
      now
    );
    return { saved: true, ...written, amended: false, unchanged: false };
  });
}
