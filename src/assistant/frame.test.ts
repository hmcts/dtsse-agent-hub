import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { DECK_SELECT } from "./deck-store.ts";
import { DOCMOSIS_SELECT } from "./docmosis-store.ts";
import { assistantFrame } from "./frame.ts";

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
  },
  notify: { notifyVersion: number; notifyRevision: number; notifyUpdatedBy: string | null } = { notifyVersion: 0, notifyRevision: 0, notifyUpdatedBy: null },
  documents: Record<string, unknown>[] = []
) {
  const versionQueries: unknown[] = [];
  const nulls = Object.fromEntries(Object.keys({ ...DECK_SELECT, ...DOCMOSIS_SELECT }).map((key) => [key, null]));
  const conversation = {
    ...nulls,
    id: CONVERSATION,
    ownerOid: "oid-alice",
    product: "general",
    documents,
    deckRevision: deck.deckVersion,
    ...docmosis,
    ...notify,
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

describe("assistantFrame's notify fields", () => {
  it("should carry the Notify template's version, revision and author", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, undefined, { notifyVersion: 5, notifyRevision: 1, notifyUpdatedBy: "user" });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ notify_version: 5, notify_revision: 1, notify_updated_by: "user" });
  });

  it("should say 0, 0 and no author before there is a Notify template", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ notify_version: 0, notify_revision: 0, notify_updated_by: null });
  });
});

describe("assistantFrame's documents", () => {
  const NONE = { deckVersion: 0, deckUpdatedBy: null };
  const NOW = Date.now();

  function document(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      kind: "document",
      title: "Plan",
      markdown: "# Plan",
      version: 1,
      updatedBy: "agent",
      updatedAt: new Date(NOW),
      jiraExportId: null,
      jiraProject: null,
      jiraStatus: null,
      jiraKey: null,
      jiraError: null,
      jiraRequestedAt: null,
      githubExportId: null,
      githubRepo: null,
      githubStatus: null,
      githubNumber: null,
      githubError: null,
      githubRequestedAt: null,
      confluenceExportId: null,
      confluenceSpaceId: null,
      confluenceSpaceKey: null,
      confluenceSpaceName: null,
      confluenceParentId: null,
      confluenceParentTitle: null,
      confluenceStatus: null,
      confluencePageId: null,
      confluencePageTitle: null,
      confluenceError: null,
      confluenceRequestedAt: null,
      ...overrides
    };
  }

  const FIRST = "00000000-0000-4000-8000-0000000000d1";
  const SECOND = "00000000-0000-4000-8000-0000000000d2";

  it("should list every document and report the primary's version for older clients when there are several", async () => {
    const { db } = stub(NONE, null, undefined, undefined, [
      document(FIRST, { kind: "ticket", title: "Story", version: 4, updatedBy: "user" }),
      document(SECOND, { version: 2, updatedBy: "agent" })
    ]);

    const frame = await assistantFrame(db, "va-1");

    expect(frame?.artefacts).toEqual([
      { id: FIRST, kind: "ticket", title: "Story", version: 4, updated_by: "user" },
      { id: SECOND, kind: "document", title: "Plan", version: 2, updated_by: "agent" }
    ]);
    expect(frame).toMatchObject({ artefact_version: 2, artefact_updated_by: "agent" });
  });

  it("should say version 0 and no author when the conversation has no plain document", async () => {
    const { db } = stub(NONE, null, undefined, undefined, [document(FIRST, { kind: "confluence" })]);

    expect(await assistantFrame(db, "va-1")).toMatchObject({ artefact_version: 0, artefact_updated_by: null });
  });

  it("should carry the most recently asked pending export with its document when two documents have one", async () => {
    const pending = (exportId: string, at: number) => ({
      jiraExportId: exportId,
      jiraProject: "VIBE",
      jiraStatus: "pending",
      jiraRequestedAt: new Date(at)
    });
    const { db } = stub(NONE, null, undefined, undefined, [
      document(FIRST, pending("00000000-0000-4000-8000-0000000000e1", NOW - 2000)),
      document(SECOND, pending("00000000-0000-4000-8000-0000000000e2", NOW - 1000))
    ]);

    expect((await assistantFrame(db, "va-1"))?.jira_export).toMatchObject({ export_id: "00000000-0000-4000-8000-0000000000e2", document_id: SECOND });
  });

  it("should carry no export when no document has one pending", async () => {
    const { db } = stub(NONE, null, undefined, undefined, [document(FIRST)]);

    const frame = await assistantFrame(db, "va-1");

    expect(frame?.jira_export).toBeUndefined();
    expect(frame?.github_export).toBeUndefined();
    expect(frame?.confluence_export).toBeUndefined();
  });
});
