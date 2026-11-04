import { describe, expect, it, vi } from "vitest";
import type { Database } from "../store/prisma.ts";
import { deckSummary } from "./deck-store.ts";

const CONVERSATION = "22222222-2222-2222-2222-222222222222";

/** A database that answers the .pptx probe and nothing else, so a second read of the conversation would throw. */
function probeOnly(pptx: boolean) {
  const $queryRaw = vi.fn(async () => [{ pptx }]);
  return { db: { $queryRaw } as unknown as Database, $queryRaw };
}

describe("deckSummary", () => {
  it("should summarise the deck from the row it is given, reading only whether the latest version has its .pptx", async () => {
    const { db, $queryRaw } = probeOnly(true);

    expect(await deckSummary(db, CONVERSATION, { deckTitle: "Plan", deckVersion: 3, deckRevision: 5, deckUpdatedBy: "agent" })).toEqual({
      title: "Plan",
      version: 3,
      revision: 5,
      updatedBy: "agent",
      pptx: true
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("should answer null, reading nothing, when the row says there is no deck", async () => {
    const { db, $queryRaw } = probeOnly(true);

    expect(await deckSummary(db, CONVERSATION, { deckTitle: null, deckVersion: 0, deckRevision: 0, deckUpdatedBy: null })).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
