"use server";

import { canChangeDeck } from "@/access/rules";
import { restoreDeckVersion as restore } from "@/assistant/deck-history-store";
import type { DeckAuthor } from "@/assistant/deck-store";
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
    if ("picturesGone" in result) {
      return { ok: false, error: `Version ${version}'s pictures are no longer held, so it can't be restored.` };
    }
    return { ok: true, ...result };
  });
}
