import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { ARTEFACT_SELECT } from "./artefact-store.ts";
import { CONFLUENCE_SELECT } from "./confluence.ts";
import { DECK_SELECT } from "./deck-store.ts";
import { assistantFrame } from "./frame.ts";
import { GITHUB_SELECT } from "./github.ts";
import { JIRA_SELECT } from "./jira.ts";

/**
 * When the frame reads the deck's versions, with the database stood in for: `test/integration/assistant-deck-edit.test.ts`
 * is where the newest agent version is read from real rows.
 */

const CONVERSATION = "00000000-0000-4000-8000-000000000001";

function stub(deck: { deckVersion: number; deckUpdatedBy: string | null }, newestAgent: number | null = null) {
  const versionQueries: unknown[] = [];
  const nulls = Object.fromEntries(
    Object.keys({ ...ARTEFACT_SELECT, ...DECK_SELECT, ...JIRA_SELECT, ...GITHUB_SELECT, ...CONFLUENCE_SELECT }).map((key) => [key, null])
  );
  const conversation = {
    ...nulls,
    id: CONVERSATION,
    ownerOid: "oid-alice",
    product: "general",
    artefactMarkdown: "",
    artefactVersion: 0,
    deckRevision: deck.deckVersion,
    ...deck
  };
  const db = {
    agent: { findUnique: async () => ({ assistantConversation: conversation }) },
    assistantModelChoice: { findUnique: async () => null },
    assistantDeckVersion: {
      findFirst: async (query: unknown) => {
        versionQueries.push(query);
        return newestAgent === null ? null : { version: newestAgent };
      }
    }
  } as unknown as Database;
  return { db, versionQueries };
}

describe("assistantFrame's deck_agent_version", () => {
  it("should read the versions when the person wrote the latest", async () => {
    const { db, versionQueries } = stub({ deckVersion: 4, deckUpdatedBy: "user" }, 2);

    expect((await assistantFrame(db, "va-1"))?.deck_agent_version).toBe(2);
    expect(versionQueries).toHaveLength(1);
  });

  it("should answer the latest version without a query when the session wrote it", async () => {
    const { db, versionQueries } = stub({ deckVersion: 3, deckUpdatedBy: "agent" });

    expect((await assistantFrame(db, "va-1"))?.deck_agent_version).toBe(3);
    expect(versionQueries).toEqual([]);
  });

  it("should answer 0 without a query when there is no deck", async () => {
    const { db, versionQueries } = stub({ deckVersion: 0, deckUpdatedBy: null });

    expect((await assistantFrame(db, "va-1"))?.deck_agent_version).toBe(0);
    expect(versionQueries).toEqual([]);
  });

  it("should answer 0 without a query when the latest version has no author", async () => {
    const { db, versionQueries } = stub({ deckVersion: 2, deckUpdatedBy: null });

    expect((await assistantFrame(db, "va-1"))?.deck_agent_version).toBe(0);
    expect(versionQueries).toEqual([]);
  });
});
