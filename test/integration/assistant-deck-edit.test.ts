import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import * as deckRoute from "../../src/app/api/agent/[agentId]/deck/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as pptxRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/versions/[version]/pptx/route.ts";
import { assetRef, type DeckOutline, KEEP_VERSIONS } from "../../src/assistant/deck.ts";
import { answerDeckBuild, readDeckBuild } from "../../src/assistant/deck-build-store.ts";
import { AMEND_WINDOW_MS, AMENDED_BUILD_ERROR } from "../../src/assistant/deck-edit.ts";
import { saveDeckEdit } from "../../src/assistant/deck-edit-store.ts";
import { listDeckVersions, readDeckVersionOutline } from "../../src/assistant/deck-history-store.ts";
import { putDeckPptx, readDeck, writeDeck } from "../../src/assistant/deck-store.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { prisma } from "./database.ts";
import { ALICE, BOB, CAROL, type Chat, chat, PPTX, png, store } from "./deck-chats.ts";
import { jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const _assistantActions = await import("../../src/app/_actions/assistant.ts");
const deckActions = await import("../../src/app/_actions/decks.ts");
const shareActions = await import("../../src/app/_actions/shares.ts");
const forkActions = await import("../../src/app/_actions/forks.ts");

assistantSuite([ALICE, BOB, CAROL]);

function outline(title: string, pictures: string[] = []): DeckOutline {
  return {
    title,
    slides: [
      { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
      { id: "how", layout: "HMCTS_CONTENT", title: "How we ship", bullets: ["Build", { text: "Test", bullets: ["Unit"] }] },
      ...pictures.map((sha, index) => ({
        id: `pic${index}`,
        layout: "HMCTS_IMAGE" as const,
        title: `Picture ${index}`,
        image: { asset: assetRef(sha), alt: "A picture" }
      }))
    ]
  };
}

/** A chat whose session has written version 1, with its .pptx. */
async function agentDeck(pictures: string[] = []): Promise<Chat> {
  const mine = await chat();
  await writeDeck(prisma, mine.row, { outline: outline("Ways of working", pictures), baseVersion: 0, by: "agent", summary: "First draft" });
  await putDeckPptx(prisma, mine.row, 1, PPTX);
  return mine;
}

async function save(of: Chat, next: DeckOutline, base: { version: number; revision: number }) {
  actAs("alice");
  return await deckActions.saveDeck({ conversationId: of.id, outline: next, baseVersion: base.version, baseRevision: base.revision });
}

async function versionRow(of: Chat, version: number) {
  return await prisma.assistantDeckVersion.findUniqueOrThrow({
    where: { conversationId_version: { conversationId: of.id, version } },
    select: { by: true, summary: true, createdAt: true, updatedAt: true, editorOid: true, pptx: true, outline: true }
  });
}

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

async function agent<P>(handler: Handler<P>, path: string, params: P, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return await handler(
    new Request(`http://localhost:3000${path}`, {
      method: init.method ?? "GET",
      headers: { "x-dev-user": `${ALICE.oid}|${ALICE.name}|${ALICE.email}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    }),
    { params: Promise.resolve(params) }
  );
}

describe("saving the deck from the editor", () => {
  it("should write the person's edit of the session's version as the next version, said to be theirs, and tell the session", async () => {
    // Arrange
    const mine = await agentDeck();
    const edited = { ...outline("Ways of working"), subtitle: "For new starters" };

    // Act
    const saved = await save(mine, edited, { version: 1, revision: 1 });

    // Assert
    expect(saved).toEqual({ ok: true, saved: true, version: 2, revision: 2, amended: false, unchanged: false });
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 2, revision: 2, updatedBy: "user", outline: edited, pptx: false });
    expect(await versionRow(mine, 2)).toMatchObject({ by: "user", summary: "Edited slides", editorOid: ALICE.oid, updatedAt: null });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 2, deck_updated_by: "user", deck_revision: 2, deck_agent_version: 1 });
  });

  it("should write nothing, keeping the session's .pptx and its word on the deck, when the outline is the same as its base", async () => {
    // Arrange
    const mine = await agentDeck();
    const same = outline("Ways of working");
    // The same outline with its keys in another order, as a browser may send it.
    const reordered = { slides: same.slides.map((slide) => Object.fromEntries(Object.entries(slide).reverse())), title: same.title } as DeckOutline;

    // Act
    const saved = await save(mine, reordered, { version: 1, revision: 1 });

    // Assert
    expect(saved).toEqual({ ok: true, saved: true, version: 1, revision: 1, amended: false, unchanged: true });
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 1, revision: 1, updatedBy: "agent", pptx: true });
    expect(await prisma.assistantDeckVersion.count({ where: { conversationId: mine.id } })).toBe(1);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 1, deck_revision: 1, deck_updated_by: "agent" });
  });

  it("should not amend the person's own version, or move its revision on, when the save is the same as it", async () => {
    // Arrange
    const mine = await agentDeck();
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine"), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, start);
    await putDeckPptx(prisma, mine.row, 2, PPTX);

    // Act
    const again = await saveDeckEdit(
      prisma,
      mine.row,
      { outline: outline("Mine"), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid },
      new Date(start.getTime() + 1000)
    );

    // Assert
    expect(again).toMatchObject({ saved: true, version: 2, revision: 2, amended: false, unchanged: true });
    expect((await versionRow(mine, 2)).updatedAt).toBeNull();
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 2, revision: 2, pptx: true });
  });

  it("should amend the person's own latest version in place, moving only the revision on, when they save again soon after", async () => {
    // Arrange
    const mine = await agentDeck();
    const first = new Date();
    await save(mine, { ...outline("Ways of working"), subtitle: "One" }, { version: 1, revision: 1 });
    const pending = await prisma.assistantDeckBuild.create({ data: { conversationId: mine.id, version: 2 }, select: { id: true } });
    await putDeckPptx(prisma, mine.row, 2, PPTX);
    const later = new Date(first.getTime() + 60_000);

    // Act
    const amended = await saveDeckEdit(
      prisma,
      mine.row,
      { outline: { ...outline("Ways of shipping"), subtitle: "Two" }, baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid },
      later
    );

    // Assert
    expect(amended).toMatchObject({ saved: true, version: 2, revision: 3, amended: true });
    const row = await versionRow(mine, 2);
    expect(row.updatedAt?.toISOString()).toBe(later.toISOString());
    expect(row.createdAt.getTime()).toBeLessThan(later.getTime());
    expect(row.pptx).toBeNull();
    expect((row.outline as unknown as DeckOutline).subtitle).toBe("Two");
    expect(await prisma.assistantDeckBuild.findUniqueOrThrow({ where: { id: pending.id }, select: { status: true, error: true } })).toEqual({
      status: "failed",
      error: AMENDED_BUILD_ERROR
    });
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 2, revision: 3, title: "Ways of shipping", updatedBy: "user" });
    expect(await prisma.assistantDeckVersion.count({ where: { conversationId: mine.id } })).toBe(2);
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 2, deck_revision: 3, deck_updated_by: "user" });
  });

  it("should report an amended version's last write as its updated_at, and a version never amended's first", async () => {
    // Arrange
    const mine = await agentDeck();
    const first = new Date(Date.now() - 120_000);
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine"), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, first);
    const later = new Date(first.getTime() + 60_000);
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine, amended"), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid }, later);

    // Act
    const listed = await listDeckVersions(prisma, mine.id);
    const asked = await jsonOf<{ updated_at: string }>(await agent(deckRoute.GET, `/api/agent/${mine.agentId}/deck?version=2`, { agentId: mine.agentId }));

    // Assert
    expect(listed[0]).toMatchObject({ version: 2, created_at: first.toISOString(), updated_at: later.toISOString() });
    expect(listed[1]!.updated_at).toBe(listed[1]!.created_at);
    expect(asked.updated_at).toBe(later.toISOString());
  });

  it("should write a new version rather than amend once the person's version is 10 minutes old", async () => {
    // Arrange
    const mine = await agentDeck();
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("One"), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, start);

    // Act
    const later = await saveDeckEdit(
      prisma,
      mine.row,
      { outline: outline("Two"), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid },
      new Date(start.getTime() + AMEND_WINDOW_MS)
    );

    // Assert
    expect(later).toMatchObject({ saved: true, version: 3, revision: 3, amended: false });
  });

  it("should write a new version rather than amend a restore, and say a change of order alone was a reorder", async () => {
    // Arrange
    const mine = await agentDeck();
    await save(mine, outline("Edited"), { version: 1, revision: 1 });
    actAs("alice");
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 })).toMatchObject({ restored: true, version: 3 });
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 3, revision: 3 });
    const restored = outline("Ways of working");

    // Act
    const reordered = await save(mine, { ...restored, slides: [...restored.slides].reverse() }, { version: 3, revision: 3 });

    // Assert
    expect(reordered).toEqual({ ok: true, saved: true, version: 4, revision: 4, amended: false, unchanged: false });
    expect((await versionRow(mine, 4)).summary).toBe("Reordered slides");
    expect((await versionRow(mine, 3)).editorOid).toBeNull();
  });

  it("should write nothing and answer the deck as it is now when the session or another tab wrote since the base", async () => {
    // Arrange
    const mine = await agentDeck();
    await save(mine, outline("Mine"), { version: 1, revision: 1 });
    await save(mine, outline("Mine again"), { version: 2, revision: 2 });

    // Act
    const staleRevision = await save(mine, outline("From an old tab"), { version: 2, revision: 2 });
    await writeDeck(prisma, mine.row, { outline: outline("The session's"), baseVersion: 2, by: "agent", summary: null });
    const staleVersion = await save(mine, outline("Too late"), { version: 2, revision: 3 });

    // Assert
    expect(staleRevision).toMatchObject({ ok: true, saved: false, current: { version: 2, revision: 3, updatedBy: "user", title: "Mine again" } });
    expect(staleVersion).toMatchObject({ ok: true, saved: false, current: { version: 3, revision: 4, updatedBy: "agent" } });
    expect((staleVersion as { current: { outline: DeckOutline } }).current.outline.title).toBe("The session's");
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 3, revision: 4, title: "The session's" });
  });

  it("should save the person's edit on top of the newer version when they keep theirs", async () => {
    // Arrange
    const mine = await agentDeck();
    await writeDeck(prisma, mine.row, { outline: outline("The session's"), baseVersion: 1, by: "agent", summary: null });

    // Act
    const refused = await save(mine, outline("Mine"), { version: 1, revision: 1 });
    const kept = await save(mine, outline("Mine"), { version: 2, revision: 2 });

    // Assert
    expect(refused).toMatchObject({ saved: false });
    expect(kept).toEqual({ ok: true, saved: true, version: 3, revision: 3, amended: false, unchanged: false });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_agent_version: 2 });
  });

  it("should refuse a share's reader and a stranger as slides that are not there, writing nothing", async () => {
    // Arrange
    const mine = await agentDeck();
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const refused = { ok: false, error: "those slides are not there" };
    const attempt = () => deckActions.saveDeck({ conversationId: mine.id, outline: outline("Theirs"), baseVersion: 1, baseRevision: 1 });

    // Act and assert
    actAs("bob");
    expect(await attempt()).toEqual(refused);
    actAs("carol");
    expect(await attempt()).toEqual(refused);
    actAs("alice");
    expect(await deckActions.saveDeck({ conversationId: mine.id, outline: outline("Mine"), baseVersion: "1", baseRevision: 1 })).toEqual(refused);
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 1, revision: 1, updatedBy: "agent" });
  });

  it("should refuse an outline the plugin could not build, and one naming a picture the deck does not hold", async () => {
    // Arrange
    const mine = await agentDeck();
    const blank = { ...outline("Ways of working"), title: " " };
    const stranger = outline("Ways of working", ["c".repeat(64)]);

    // Act
    const invalid = await save(mine, blank, { version: 1, revision: 1 });
    const missing = await save(mine, stranger, { version: 1, revision: 1 });

    // Assert
    expect(invalid).toEqual({ ok: false, error: "outline.title must be non-empty text" });
    expect(missing).toEqual({ ok: false, error: "the slides name a picture that is no longer kept; remove it, then they will save" });
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: 1, revision: 1 });
  });

  it("should delete, once past its hour, a picture the amend stopped naming that no other version names", async () => {
    // Arrange
    const mine = await chat();
    const kept = await store(mine, png(1));
    const dropped = await store(mine, png(2));
    await writeDeck(prisma, mine.row, { outline: outline("Pictures", [kept]), baseVersion: 0, by: "agent", summary: null });
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("Pictures", [kept, dropped]), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, start);

    // The person's version is a minute old an hour on, so the amend is inside its window and past the picture's grace.
    await prisma.assistantDeckVersion.update({
      where: { conversationId_version: { conversationId: mine.id, version: 2 } },
      data: { createdAt: new Date(start.getTime() + 60 * 60_000) }
    });

    // Act
    const amended = await saveDeckEdit(
      prisma,
      mine.row,
      { outline: outline("Pictures, one", [kept]), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid },
      new Date(start.getTime() + 61 * 60_000)
    );

    // Assert
    expect(amended).toMatchObject({ saved: true, amended: true, version: 2 });
    const held = await prisma.assistantDeckAsset.findMany({ where: { conversationId: mine.id }, select: { sha256: true } });
    expect(held.map((one) => one.sha256)).toEqual([kept]);
  });
});

describe("the session after the person's edit", () => {
  it("should answer the revision on GET and PUT, and refuse a put on a revision the person has amended since", async () => {
    // Arrange
    const mine = await agentDeck();
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine"), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, start);
    const read = await jsonOf<{ version: number; revision: number }>(await agent(deckRoute.GET, `/api/agent/${mine.agentId}/deck`, { agentId: mine.agentId }));
    await saveDeckEdit(
      prisma,
      mine.row,
      { outline: outline("Mine, amended"), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid },
      new Date(start.getTime() + 1000)
    );
    const put = (base_revision?: number) =>
      agent(
        deckRoute.PUT,
        `/api/agent/${mine.agentId}/deck`,
        { agentId: mine.agentId },
        { method: "PUT", body: { outline: outline("The session's"), base_version: 2, ...(base_revision === undefined ? {} : { base_revision }) } }
      );

    // Act
    const stale = await put(read.revision);
    const fresh = await put(3);

    // Assert
    expect(read).toMatchObject({ version: 2, revision: 2 });
    expect(stale.status).toBe(409);
    expect(await jsonOf(stale)).toMatchObject({ current: { version: 2, revision: 3, updated_by: "user", title: "Mine, amended" } });
    expect(fresh.status).toBe(200);
    expect(await jsonOf(fresh)).toMatchObject({ version: 3, revision: 4 });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_updated_by: "agent", deck_agent_version: 3 });
  });

  it("should copy the amended latest version to a fork, as its version 1 at revision 1, which the copy's owner then edits anew", async () => {
    // Arrange
    const mine = await agentDeck();
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine"), baseVersion: 1, baseRevision: 1, editorOid: ALICE.oid }, start);
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine, amended"), baseVersion: 2, baseRevision: 2, editorOid: ALICE.oid }, start);
    actAs("alice");
    await forkActions.offerChatFork({ conversationId: mine.id, recipientOid: BOB.oid });
    actAs("bob");
    const copy = ((await forkActions.forkChat({ conversationId: mine.id })) as { ok: true; id: string }).id;

    // Act
    const forked = await readDeck(prisma, copy);
    const edited = await deckActions.saveDeck({ conversationId: copy, outline: outline("Bob's"), baseVersion: 1, baseRevision: 1 });

    // Assert
    expect(forked).toMatchObject({ version: 1, revision: 1, updatedBy: "user", title: "Mine, amended" });
    expect(edited).toEqual({ ok: true, saved: true, version: 2, revision: 2, amended: false, unchanged: false });
  });
});

describe("a version the person wrote", () => {
  it("should be built on request, latest as it is, and its pending build failed and its finished ones dropped when the person amends it", async () => {
    // Arrange
    const mine = await agentDeck();
    const claim = await claimRoute.POST(
      new Request("http://localhost:3000/api/orchestrator/claim", {
        method: "POST",
        headers: { "x-dev-orchestrator": "preview-01", "content-type": "application/json" },
        body: JSON.stringify({ cluster: "preview-01" })
      }),
      { params: Promise.resolve({}) }
    );
    const claimed = (await jsonOf<{ virtual_agents: { id: string; generation: number }[] }>(claim)).virtual_agents.find(
      (entry) => entry.id === mine.virtualAgentId
    )!;
    await observedRoute.POST(
      new Request(`http://localhost:3000/api/orchestrator/virtual-agents/${mine.virtualAgentId}/observed`, {
        method: "POST",
        headers: { "x-dev-orchestrator": "preview-01", "content-type": "application/json" },
        body: JSON.stringify({ generation: claimed.generation, replicas_ready: 1, pod_phase: "Running" })
      }),
      { params: Promise.resolve({ id: mine.virtualAgentId }) }
    );
    const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: mine.virtualAgentId }, select: { generation: true } });
    await prisma.virtualAgent.update({
      where: { id: mine.virtualAgentId },
      data: { observedGeneration: row.generation, status: "running", clientFeatures: ["deck-build", "slides-always-on"] }
    });
    await save(mine, outline("Mine"), { version: 1, revision: 1 });
    const prepare = () =>
      pptxRoute.POST(
        new NextRequest(`http://localhost:3000/api/ui/assistant/decks/${mine.id}/versions/2/pptx`, {
          method: "POST",
          headers: { cookie: "ah_dev_persona=alice" }
        }),
        { params: Promise.resolve({ conversationId: mine.id, version: "2" }) }
      );

    const asked = await jsonOf<{ status: string; job_id: string }>(await prepare());
    const finished = await prisma.assistantDeckBuild.create({
      data: { conversationId: mine.id, version: 2, status: "done", pptx: PPTX, finishedAt: new Date() },
      select: { id: true }
    });
    const heldBefore = (await readDeck(prisma, mine.id)).pptx;

    // Act
    await save(mine, outline("Mine, amended"), { version: 2, revision: 2 });
    await answerDeckBuild(prisma, mine.virtualAgentId, asked.job_id, { pptx: PPTX });

    // Assert
    expect(asked.status).toBe("pending");
    expect(await readDeckBuild(prisma, ALICE.oid, mine.id, asked.job_id)).toEqual({
      status: "failed",
      job_id: asked.job_id,
      version: 2,
      error: AMENDED_BUILD_ERROR
    });
    expect(await prisma.assistantDeckBuild.findUnique({ where: { id: finished.id } })).toBeNull();
    expect(await prisma.assistantDeckBuild.findUniqueOrThrow({ where: { id: asked.job_id }, select: { pptx: true } })).toEqual({ pptx: null });
    expect(heldBefore).toBe(true);
    expect((await listDeckVersions(prisma, mine.id))[0]).toMatchObject({ version: 2, by: "user", pptx: false });
    expect((await readDeck(prisma, mine.id)).pptx).toBe(false);
    expect(await readDeckVersionOutline(prisma, mine.id, 2)).toMatchObject({ version: 2, pptx: false });
  });
});

describe("the retention with amends", () => {
  it("should keep at most 100 versions however many times the person amends, and prune as a new version is written", async () => {
    // Arrange
    const mine = await chat();
    for (let base = 0; base < KEEP_VERSIONS; base += 1) {
      await writeDeck(prisma, mine.row, { outline: outline(`v${base + 1}`), baseVersion: base, by: "agent", summary: null });
    }
    const start = new Date();
    await saveDeckEdit(prisma, mine.row, { outline: outline("Mine"), baseVersion: KEEP_VERSIONS, baseRevision: KEEP_VERSIONS, editorOid: ALICE.oid }, start);

    // Act
    for (let revision = KEEP_VERSIONS + 1; revision < KEEP_VERSIONS + 21; revision += 1) {
      const amended = await saveDeckEdit(
        prisma,
        mine.row,
        { outline: outline(`Mine ${revision}`), baseVersion: KEEP_VERSIONS + 1, baseRevision: revision, editorOid: ALICE.oid },
        new Date(start.getTime() + 1000)
      );
      expect(amended).toMatchObject({ saved: true, amended: true });
    }

    // Assert
    const versions = await listDeckVersions(prisma, mine.id);
    expect(versions).toHaveLength(KEEP_VERSIONS);
    expect(versions[0]).toMatchObject({ version: KEEP_VERSIONS + 1, by: "user" });
    expect(versions.at(-1)?.version).toBe(2);
    expect(await readDeck(prisma, mine.id)).toMatchObject({ version: KEEP_VERSIONS + 1, revision: KEEP_VERSIONS + 21 });
  });
});
