import { describe, expect, it, vi } from "vitest";
import type { Database } from "../store/prisma.ts";
import { deckSummary } from "./deck-store.ts";

const ITEM = "33333333-3333-3333-3333-333333333333";

/** A database that answers the .pptx probe and nothing else, so a second read of the deck would throw. */
function probeOnly(pptx: boolean) {
  const $queryRaw = vi.fn(async () => [{ pptx }]);
  return { db: { $queryRaw } as unknown as Database, $queryRaw };
}

describe("deckSummary", () => {
  it("should summarise the deck from the row it is given, reading only whether the latest version has its .pptx", async () => {
    const { db, $queryRaw } = probeOnly(true);

    expect(await deckSummary(db, { id: ITEM, title: "Plan", version: 3, revision: 5, updatedBy: "agent" })).toEqual({
      id: ITEM,
      title: "Plan",
      version: 3,
      revision: 5,
      updatedBy: "agent",
      pptx: true
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it("should answer null, reading nothing, when the row says there is no version yet", async () => {
    const { db, $queryRaw } = probeOnly(true);

    expect(await deckSummary(db, { id: ITEM, title: null, version: 0, revision: 0, updatedBy: null })).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
