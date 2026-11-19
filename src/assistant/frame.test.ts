import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { assistantFrame } from "./frame.ts";

// The published client is loaded by path, not imported: its sources are checked against their own `Env` type, which
// this project's typecheck would otherwise apply to them as well.
const clientModule = (name: string) => import(fileURLToPath(new URL(`../../packages/agent-hub/src/${name}.ts`, import.meta.url)));
type ParsedFrame = Record<string, unknown> | null;
type Client = {
  parseAssistantFrame: (value: unknown) => ParsedFrame;
  routeDelivery: (input: { fromOwner: boolean; session: string; frame: ParsedFrame; transcriptUploaded: boolean }) => { kind: string; frame?: ParsedFrame };
  chooseEnvelope: (message: { id: string; body: string }, delivery: unknown) => string;
};
async function client(): Promise<Client> {
  return { ...(await clientModule("frames")), ...(await clientModule("envelope")) } as Client;
}

/**
 * When the frame reads the deck's versions, with the database stood in for: `test/integration/assistant-deck-edit.test.ts`
 * is where the newest agent version is read from real rows.
 */

const CONVERSATION = "00000000-0000-4000-8000-000000000001";
const DECK = "00000000-0000-4000-8000-0000000000d1";

function stub(
  deck: { deckVersion: number; deckUpdatedBy: string | null },
  newestAgent: number | null = null,
  docmosisItems: Record<string, unknown>[] = [],
  notifyItems: Record<string, unknown>[] = [],
  documents: Record<string, unknown>[] = []
) {
  const versionQueries: unknown[] = [];
  const conversation = {
    id: CONVERSATION,
    ownerOid: "oid-alice",
    product: "general",
    documents,
    decks:
      deck.deckVersion === 0 ? [] : [{ id: DECK, title: "Plan", version: deck.deckVersion, revision: deck.deckVersion + 1, updatedBy: deck.deckUpdatedBy }],
    docmosisItems,
    notifyItems
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

function docmosisItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: "Claim form", version: 1, revision: 0, updatedBy: "agent", pdfState: "ready", ...overrides };
}

describe("assistantFrame's docmosis fields", () => {
  it("should carry the primary template's version, revision and author", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, [docmosisItem("d1", { version: 3, revision: 2, updatedBy: "user" })]);

    expect(await assistantFrame(db, "va-1")).toMatchObject({ docmosis_version: 3, docmosis_revision: 2, docmosis_updated_by: "user" });
  });

  it("should list every template, oldest first, and read the primary fields from the first", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, [
      docmosisItem("d1", { name: "Claim", version: 2 }),
      docmosisItem("d2", { name: "Order", version: 5, revision: 1, updatedBy: "user" })
    ]);

    expect(await assistantFrame(db, "va-1")).toMatchObject({
      docmosis_version: 2,
      docmosis_updated_by: "agent",
      docmosis_templates: [
        { id: "d1", name: "Claim", version: 2, revision: 0, updated_by: "agent" },
        { id: "d2", name: "Order", version: 5, revision: 1, updated_by: "user" }
      ]
    });
  });

  it("should say 0, 0 and no author before there is a template", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ docmosis_version: 0, docmosis_revision: 0, docmosis_updated_by: null, docmosis_templates: [] });
  });

  it("should leave out a template whose author is neither the person nor the session", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, [docmosisItem("d1", { updatedBy: "other" })]);

    expect((await assistantFrame(db, "va-1"))?.docmosis_templates).toEqual([]);
  });
});

function notifyItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: "Template", version: 1, revision: 0, updatedBy: "agent", ...overrides };
}

describe("assistantFrame's notify fields", () => {
  it("should carry the Notify template's version, revision and author", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, undefined, [notifyItem("n1", { version: 5, revision: 1, updatedBy: "user" })]);

    expect(await assistantFrame(db, "va-1")).toMatchObject({ notify_version: 5, notify_revision: 1, notify_updated_by: "user" });
  });

  it("should list every Notify template oldest first and report the oldest's version for older clients when there are several", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null }, null, undefined, [
      notifyItem("n1", { name: "Claim received", version: 2, updatedBy: "agent" }),
      notifyItem("n2", { name: "Hearing booked", version: 7, revision: 3, updatedBy: "user" })
    ]);

    expect(await assistantFrame(db, "va-1")).toMatchObject({
      notify_version: 2,
      notify_updated_by: "agent",
      notify_templates: [
        { id: "n1", name: "Claim received", version: 2, revision: 0, updated_by: "agent" },
        { id: "n2", name: "Hearing booked", version: 7, revision: 3, updated_by: "user" }
      ]
    });
  });

  it("should say 0, 0 and no author before there is a Notify template", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null });

    expect(await assistantFrame(db, "va-1")).toMatchObject({ notify_version: 0, notify_revision: 0, notify_updated_by: null, notify_templates: [] });
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

describe("assistantFrame's decks", () => {
  it("should list each deck with its id, title, version, revision, author and the newest version the session wrote", async () => {
    const { db } = stub({ deckVersion: 4, deckUpdatedBy: "user" }, 2);

    const frame = await assistantFrame(db, "va-1");

    expect(frame?.decks).toEqual([{ id: DECK, title: "Plan", version: 4, revision: 5, updated_by: "user", agent_version: 2 }]);
    expect(frame).toMatchObject({ deck_version: 4, deck_revision: 5, deck_updated_by: "user", deck_agent_version: 2 });
  });

  it("should list no decks and report the primary as 0 when the conversation has none", async () => {
    const { db } = stub({ deckVersion: 0, deckUpdatedBy: null });

    const frame = await assistantFrame(db, "va-1");

    expect(frame?.decks).toEqual([]);
    expect(frame).toMatchObject({ deck_version: 0, deck_revision: 0, deck_updated_by: null, deck_agent_version: 0 });
  });
});

describe("assistantFrame as the published client reads it", () => {
  const DOCMOSIS = "00000000-0000-4000-8000-0000000000a1";
  const NOTIFY = "00000000-0000-4000-8000-0000000000b1";
  const DOC = "00000000-0000-4000-8000-0000000000c1";

  async function onTheWire(
    documents: Record<string, unknown>[],
    docmosisItems: Record<string, unknown>[],
    notifyItems: Record<string, unknown>[],
    deckVersion = 0
  ) {
    const { db } = stub({ deckVersion, deckUpdatedBy: deckVersion === 0 ? null : "user" }, null, docmosisItems, notifyItems, documents);
    const frame = await assistantFrame(db, "va-1", undefined);
    return JSON.parse(JSON.stringify(frame)) as unknown;
  }

  const document = (overrides: Record<string, unknown> = {}) => ({
    id: DOC,
    kind: "document",
    title: null,
    version: 0,
    updatedBy: null,
    markdown: "",
    ...overrides
  });

  it("should keep every list and field for an empty conversation", async () => {
    const { parseAssistantFrame } = await client();
    const parsed = parseAssistantFrame(await onTheWire([], [], []));

    expect(parsed).toMatchObject({ artefacts: [], decks: [], docmosis_templates: [], notify_templates: [], deck_version: 0, notify_updated_by: null });
  });

  it("should keep every document, template and null author", async () => {
    const { parseAssistantFrame } = await client();
    const parsed = parseAssistantFrame(
      await onTheWire([document()], [docmosisItem(DOCMOSIS, { updatedBy: "user" })], [notifyItem(NOTIFY, { updatedBy: "agent" })], 2)
    );

    expect(parsed?.artefacts).toEqual([{ id: DOC, kind: "document", title: null, version: 0, updated_by: null }]);
    expect(parsed?.docmosis_templates).toEqual([{ id: DOCMOSIS, name: "Claim form", version: 1, revision: 0, updated_by: "user" }]);
    expect(parsed?.notify_templates).toEqual([{ id: NOTIFY, name: "Template", version: 1, revision: 0, updated_by: "agent" }]);
    expect(parsed?.decks).toHaveLength(1);
  });

  it("should be treated as a conversation with its templates listed to the session", async () => {
    const { parseAssistantFrame } = await client();
    const parsed = parseAssistantFrame(await onTheWire([], [docmosisItem(DOCMOSIS, { updatedBy: "user" })], [notifyItem(NOTIFY, { updatedBy: "user" })]));
    const { routeDelivery, chooseEnvelope } = await client();
    const delivery = routeDelivery({ fromOwner: true, session: "conversation", frame: parsed, transcriptUploaded: true });
    const prompt = chooseEnvelope({ id: "1", body: "Create a new slide deck for this conversation." } as never, delivery);

    expect(delivery).toEqual({ kind: "conversation", frame: parsed });
    expect(prompt).toContain("Create a new slide deck for this conversation.");
    expect(prompt).toContain("Claim form");
  });
});
