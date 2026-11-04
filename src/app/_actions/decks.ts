"use server";

import { canChangeDeck } from "@/access/rules";
import { checkOutline, type DeckOutline } from "@/assistant/deck";
import { saveDeckEdit } from "@/assistant/deck-edit-store";
import { restoreDeckVersion as restore } from "@/assistant/deck-history-store";
import { DeckAssetsMissing, type DeckAuthor } from "@/assistant/deck-store";
import { accessToConversation } from "@/assistant/shares";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

const OFF: { ok: false; error: string } = { ok: false, error: "the CFT Workspace is not available on this deployment" };

/** A reader and a stranger are told the same as for a version that has gone, so a refusal says nothing of the chat. */
const MISSING: { ok: false; error: string } = { ok: false, error: "that version of the slides is not there" };

export type RestoreDeckResult = { restored: true; version: number } | { restored: false; current: { version: number; updatedBy: DeckAuthor | null } };

const wholeFrom = (value: unknown, least: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= least ? value : undefined;

/**
 * The owner's restore of an older version of their conversation's deck, written as the next version and said to be
 * theirs, if nobody has written one since `baseVersion`; otherwise nothing is written and the version there now comes
 * back, for the panel to say so. The session learns of it from its next message's envelope, as of any change of theirs.
 */
export async function restoreDeckVersion(input: { conversationId: unknown; version: unknown; baseVersion: unknown }): Promise<ActionResult<RestoreDeckResult>> {
  return await runAction<RestoreDeckResult>("restore deck version", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const version = wholeFrom(input.version, 1);
    const baseVersion = wholeFrom(input.baseVersion, 1);
    if (version === undefined || baseVersion === undefined) {
      return MISSING;
    }
    const allowed = await accessToConversation(prisma, viewer.oid, text(input.conversationId));
    if (allowed === undefined || !canChangeDeck(allowed.access)) {
      return MISSING;
    }
    const result = await restore(prisma, allowed.conversation, { version, baseVersion });
    if ("missing" in result) {
      return MISSING;
    }
    if ("latest" in result) {
      return { ok: false, error: "that is already the latest version" };
    }
    return { ok: true, ...result };
  });
}

/** What a save from the editor finds when the deck has moved on: enough to show it, or to save the edit on top of it. */
export interface DeckSnapshot {
  title: string | null;
  outline: DeckOutline | null;
  version: number;
  revision: number;
  updatedBy: DeckAuthor | null;
}

export type SaveDeckResult = { saved: true; version: number; revision: number; amended: boolean } | { saved: false; current: DeckSnapshot };

const NOT_THERE: { ok: false; error: string } = { ok: false, error: "those slides are not there" };

/**
 * The owner's save of their deck from the slides panel's editor, if the deck is still at `baseVersion` and
 * `baseRevision`; otherwise nothing is written and the deck as it is now comes back, for the panel to offer it or the
 * person's own edit on top of it. A save soon after their last amends that version (`saveDeckEdit`). The session
 * learns of it from its next message's envelope.
 */
export async function saveDeck(input: {
  conversationId: unknown;
  outline: unknown;
  baseVersion: unknown;
  baseRevision: unknown;
}): Promise<ActionResult<SaveDeckResult>> {
  return await runAction<SaveDeckResult>("save deck", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const baseVersion = wholeFrom(input.baseVersion, 0);
    const baseRevision = wholeFrom(input.baseRevision, 0);
    if (baseVersion === undefined || baseRevision === undefined) {
      return NOT_THERE;
    }
    const allowed = await accessToConversation(prisma, viewer.oid, text(input.conversationId));
    if (allowed === undefined || !canChangeDeck(allowed.access)) {
      return NOT_THERE;
    }
    const checked = checkOutline(input.outline);
    if (!checked.ok) {
      return { ok: false, error: checked.error };
    }
    let result: Awaited<ReturnType<typeof saveDeckEdit>>;
    try {
      result = await saveDeckEdit(prisma, allowed.conversation, { outline: checked.outline, baseVersion, baseRevision, editorOid: viewer.oid });
    } catch (error) {
      if (error instanceof DeckAssetsMissing) {
        return { ok: false, error: "the slides name a picture that is no longer kept; remove it, then they will save" };
      }
      throw error;
    }
    if (!result.saved) {
      const { title, outline, version, revision, updatedBy } = result.current;
      return { ok: true, saved: false, current: { title, outline, version, revision, updatedBy } };
    }
    return { ok: true, saved: true, version: result.version, revision: result.revision, amended: result.amended };
  });
}
