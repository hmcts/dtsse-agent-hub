import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { ARTEFACT_SELECT } from "./artefact-store.ts";
import { CONFLUENCE_SELECT } from "./confluence.ts";
import { DECK_SELECT } from "./deck-store.ts";
import { DOCMOSIS_SELECT } from "./docmosis-store.ts";
import { assistantFrame } from "./frame.ts";
import { GITHUB_SELECT } from "./github.ts";
import { JIRA_SELECT } from "./jira.ts";

/**
 * When the frame reads the deck's versions, with the database stood in for: `test/integration/assistant-deck-edit.test.ts`
 * is where the newest agent version is read from real rows.
 */

const CONVERSATION = "00000000-0000-4000-8000-000000000001";

function stub(
  deck: { deckVersion: number; deckUpdatedBy: string | null },
  newestAgent: number | null = null,
  docmosis: { docmosisVersion: number; docmosisRevision: number; docmosisUpdatedBy: string | null } = {
    docmosisVersion: 0,
    docmosisRevision: 0,
    docmosisUpdatedBy: null
  }
) {
  const versionQueries: unknown[] = [];
  const nulls = Object.fromEntries(
    Object.keys({ ...ARTEFACT_SELECT, ...DECK_SELECT, ...DOCMOSIS_SELECT, ...JIRA_SELECT, ...GITHUB_SELECT, ...CONFLUENCE_SELECT }).map((key) => [key, null])
  );
  const conversation = {
    ...nulls,
    id: CONVERSATION,
    ownerOid: "oid-alice",
    product: "general",
    artefactMarkdown: "",
    artefactVersion: 0,
    deckRevision: deck.deckVersion,
    ...docmosis,
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

describe("assistantFrame's docmosis fields", () => {
  it("should carry the template's version, revision and author", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, { docmosisVersion: 3, docmosisRevision: 2, docmosisUpdatedBy: "user" });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ docmosis_version: 3, docmosis_revision: 2, docmosis_updated_by: "user" });
  });

  it("should say 0, 0 and no author before there is a template", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ docmosis_version: 0, docmosis_revision: 0, docmosis_updated_by: null });
  });

  it("should say no author for a value that is neither the person nor the session", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, { docmosisVersion: 1, docmosisRevision: 0, docmosisUpdatedBy: "other" });

    expect((await assistantFrame(db, "va-1"))?.docmosis_updated_by).toBeNull();
  });
});
