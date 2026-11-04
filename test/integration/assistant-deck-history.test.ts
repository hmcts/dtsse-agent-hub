import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import * as deckRoute from "../../src/app/api/agent/[agentId]/deck/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as buildRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/builds/[jobId]/route.ts";
import * as deckUiRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/route.ts";
import * as pptxRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/versions/[version]/pptx/route.ts";
import * as versionRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/versions/[version]/route.ts";
import * as versionsRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/versions/route.ts";
import * as podAssetRoute from "../../src/app/api/virtual/[virtualAgentId]/deck-builds/[jobId]/assets/[sha256]/route.ts";
import * as podBuildRoute from "../../src/app/api/virtual/[virtualAgentId]/deck-builds/[jobId]/route.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { assetRef, type DeckOutline } from "../../src/assistant/deck.ts";
import { DECK_BUILD_KEEP_MS, DECK_BUILD_TIMEOUT_MS, DECK_BUILDS_KEPT } from "../../src/assistant/deck-build.ts";
import {
  answerDeckBuild,
  pendingDeckBuild,
  podDeckBuildAsset,
  readDeckBuild,
  requestDeckBuild,
  sweepDeckBuilds
} from "../../src/assistant/deck-build-store.ts";
import { listDeckVersions, restoreDeckVersion } from "../../src/assistant/deck-history-store.ts";
import { deckSummary, deckView, putDeckPptx, readDeck, writeDeck } from "../../src/assistant/deck-store.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { prisma } from "./database.ts";
import { ALICE, BOB, CAROL, type Chat, chat, PPTX, png, store, viewerOf } from "./deck-chats.ts";
import { jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const _assistantActions = await import("../../src/app/_actions/assistant.ts");
const deckActions = await import("../../src/app/_actions/decks.ts");
const shareActions = await import("../../src/app/_actions/shares.ts");
const forkActions = await import("../../src/app/_actions/forks.ts");

assistantSuite([ALICE, BOB, CAROL]);

const BUILT = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x01]);

function outline(title: string, pictures: string[] = []): DeckOutline {
  return {
    title,
    slides: [
      { id: "why", layout: "HMCTS_SECTION", title: `Why: ${title}` },
      ...pictures.map((sha, index) => ({
        id: `pic${index}`,
        layout: "HMCTS_IMAGE" as const,
        title: "Picture",
        image: { asset: assetRef(sha), alt: "A picture" }
      }))
    ]
  };
}

/** A deck of `count` versions, the first naming a picture and with a .pptx the later writes take away. */
async function deckOf(count: number): Promise<{ mine: Chat; sha: string }> {
  const mine = await chat();
  const sha = await store(mine, png(1));
  await writeDeck(prisma, mine.row, { outline: outline("v1", [sha]), baseVersion: 0, by: "agent", summary: "First draft" });
  await putDeckPptx(prisma, mine.row, 1, PPTX);
  for (let version = 2; version <= count; version += 1) {
    await writeDeck(prisma, mine.row, { outline: outline(`v${version}`), baseVersion: version - 1, by: version % 2 === 0 ? "user" : "agent", summary: null });
  }
  return { mine, sha };
}

type BrowserHandler<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>;

async function browser<P>(handler: BrowserHandler<P>, as: string, path: string, params: P, method = "GET"): Promise<Response> {
  return await handler(new NextRequest(`http://localhost:3000${path}`, { method, headers: { cookie: `ah_dev_persona=${as}` } }), {
    params: Promise.resolve(params)
  });
}

const base = (id: string) => `/api/ui/assistant/decks/${id}`;
const versionsOf = (as: string, id: string) => browser(versionsRoute.GET, as, `${base(id)}/versions`, { conversationId: id });
const versionOf = (as: string, id: string, version: string) =>
  browser(versionRoute.GET, as, `${base(id)}/versions/${version}`, { conversationId: id, version });
const download = (as: string, id: string, version: number) =>
  browser(pptxRoute.GET, as, `${base(id)}/versions/${version}/pptx`, { conversationId: id, version: String(version) });
const prepare = (as: string, id: string, version: number | string) =>
  browser(pptxRoute.POST, as, `${base(id)}/versions/${version}/pptx`, { conversationId: id, version: String(version) }, "POST");
const buildOf = (as: string, id: string, jobId: string) => browser(buildRoute.GET, as, `${base(id)}/builds/${jobId}`, { conversationId: id, jobId });

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

async function agent<P>(handler: Handler<P>, path: string, params: P): Promise<Response> {
  return await handler(new Request(`http://localhost:3000${path}`, { headers: { "x-dev-user": `${ALICE.oid}|${ALICE.name}|${ALICE.email}` } }), {
    params: Promise.resolve(params)
  });
}

async function orchestrator<P>(handler: Handler<P>, path: string, params: P, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "x-dev-orchestrator": "preview-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await handler(request, { params: Promise.resolve(params) });
}

/**
 * The chat's pod claimed and started by the orchestrator, with the launch token it sends, and a claim of `features`
 * of its own.
 */
async function podFor(of: Chat, features: string[] = ["deck-build"]): Promise<string> {
  const claim = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, { cluster: "preview-01" });
  const claimed = (await jsonOf<{ virtual_agents: { id: string; generation: number; launch_token: string | null }[] }>(claim)).virtual_agents.find(
    (entry) => entry.id === of.virtualAgentId
  )!;
  await orchestrator(
    observedRoute.POST,
    `/api/orchestrator/virtual-agents/${of.virtualAgentId}/observed`,
    { id: of.virtualAgentId },
    { generation: claimed.generation, replicas_ready: 1, pod_phase: "Running" }
  );
  const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: of.virtualAgentId }, select: { generation: true } });
  await prisma.virtualAgent.update({
    where: { id: of.virtualAgentId },
    data: { observedGeneration: row.generation, status: "running", clientFeatures: features }
  });
  return claimed.launch_token!;
}

async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, init: { method?: string; body?: BodyInit; type?: string } = {}) {
  const request = new Request(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.type === undefined ? {} : { "content-type": init.type }) },
    ...(init.body === undefined ? {} : { body: init.body })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

/** Answers build `jobId` of `of` as its pod does, with `PUT /api/virtual/{id}/deck-builds/{jobId}`. */
function podAnswer(of: Chat, token: string, jobId: string) {
  return (init: { body: BodyInit; type: string }) =>
    pod(
      podBuildRoute.PUT,
      token,
      `/api/virtual/${of.virtualAgentId}/deck-builds/${jobId}`,
      { virtualAgentId: of.virtualAgentId, jobId },
      { method: "PUT", ...init }
    );
}
describe("a deck's history in the browser", () => {
  it("should list every kept version newest first, saying which can be downloaded, to the owner and a share's reader", async () => {
    // Arrange
    const { mine } = await deckOf(4);

    // Act
    const own = await versionsOf("alice", mine.id);
    const stranger = await versionsOf("bob", mine.id);
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const shared = await versionsOf("bob", mine.id);

    // Assert
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    const versions = await jsonOf<{ version: number; by: string; summary: string | null; created_at: string; pptx: boolean }[]>(own);
    expect(versions.map(({ version, by, summary, pptx }) => ({ version, by, summary, pptx }))).toEqual([
      { version: 4, by: "user", summary: null, pptx: false },
      { version: 3, by: "agent", summary: null, pptx: false },
      { version: 2, by: "user", summary: null, pptx: false },
      // Only the latest 3 keep a .pptx, so the first version's went with the fourth write.
      { version: 1, by: "agent", summary: "First draft", pptx: false }
    ]);
    expect(Date.parse(versions[0]!.created_at)).not.toBeNaN();
    expect(stranger.status).toBe(404);
    expect(shared.status).toBe(200);
    expect((await versionsOf("carol", mine.id)).status).toBe(404);
  });

  it("should answer 404 for a chat with no deck", async () => {
    const empty = await chat();
    expect((await versionsOf("alice", empty.id)).status).toBe(404);
  });

  it("should read one version with the sizes of the pictures it names, and refuse one not kept or not a number", async () => {
    // Arrange
    const { mine, sha } = await deckOf(2);

    // Act
    const first = await versionOf("alice", mine.id, "1");
    const second = await jsonOf(await versionOf("alice", mine.id, "2"));

    // Assert
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await jsonOf(first)).toMatchObject({
      title: "v1",
      version: 1,
      by: "agent",
      summary: "First draft",
      pptx: true,
      outline: outline("v1", [sha]),
      sizes: { [sha]: { width: 640, height: 320 } }
    });
    // The second version names no picture, so it carries none of the deck's sizes.
    expect(second.sizes).toEqual({});
    expect((await versionOf("alice", mine.id, "3")).status).toBe(404);
    expect((await versionOf("alice", mine.id, "one")).status).toBe(404);
    expect((await versionOf("bob", mine.id, "1")).status).toBe(404);
  });

  it("should read one kept version through the agent API, with the version the deck is at now", async () => {
    // Arrange
    const { mine } = await deckOf(3);
    const read = (query: string) => agent(deckRoute.GET, `/api/agent/${mine.agentId}/deck${query}`, { agentId: mine.agentId });

    // Act
    const one = await read("?version=1");

    // Assert
    expect(one.status).toBe(200);
    expect(await jsonOf(one)).toMatchObject({ title: "v1", version: 1, updated_by: "agent", pptx: true, latest_version: 3, outline: { title: "v1" } });
    expect(await jsonOf(await read(""))).toMatchObject({ version: 3, title: "v3" });
    expect((await read("?version=9")).status).toBe(404);
    expect((await read("?version=0")).status).toBe(400);
    expect((await read("?version=x")).status).toBe(400);
  });

  it("should show a fork's history as the one version it was copied as", async () => {
    // Arrange
    const { mine } = await deckOf(3);
    actAs("alice");
    await forkActions.offerChatFork({ conversationId: mine.id, recipientOid: BOB.oid });
    actAs("bob");
    const copy = ((await forkActions.forkChat({ conversationId: mine.id })) as { ok: true; id: string }).id;

    // Act
    const versions = await jsonOf<{ version: number; by: string }[]>(await versionsOf("bob", copy));

    // Assert
    expect(versions.map(({ version, by }) => ({ version, by }))).toEqual([{ version: 1, by: "user" }]);
  });
});

describe("restoring a deck version", () => {
  it("should write the old outline as the next version, said to be the person's, so the session is told it changed", async () => {
    // Arrange
    const { mine } = await deckOf(2);

    // Act
    actAs("alice");
    const restored = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 });

    // Assert
    expect(restored).toEqual({ ok: true, restored: true, version: 3 });
    const deck = await readDeck(prisma, mine.id);
    expect(deck).toMatchObject({ version: 3, updatedBy: "user", title: "v1" });
    expect(deck.outline).toEqual((await readDeckVersionOutline(mine.id, 1))!);
    // The same outline, so the .pptx the hub held for it is the restored version's too.
    expect(deck.pptx).toBe(true);
    const [latest] = await listDeckVersions(prisma, mine.id);
    expect(latest).toMatchObject({ version: 3, by: "user", summary: "Restored version 1", pptx: true });
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 3, deck_updated_by: "user" });
  });

  it("should keep the .pptx kept with the third-newest version when restoring it, though the write moves it out of the latest 3", async () => {
    // Arrange
    const { mine } = await deckOf(3);

    // Act
    actAs("alice");
    const restored = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 3 });

    // Assert
    expect(restored).toEqual({ ok: true, restored: true, version: 4 });
    const pptxOf = async (version: number) =>
      (await prisma.assistantDeckVersion.findUniqueOrThrow({ where: { conversationId_version: { conversationId: mine.id, version } } })).pptx;
    expect(Buffer.from((await pptxOf(4))!)).toEqual(PPTX);
    expect(await pptxOf(1)).toBeNull();
    expect((await readDeck(prisma, mine.id)).pptx).toBe(true);
    const file = await download("alice", mine.id, 4);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PPTX);
  });

  it("should keep a .pptx built on request for the third-newest version when restoring it", async () => {
    // Arrange
    const { mine } = await deckOf(3);
    await prisma.assistantDeckVersion.update({ where: { conversationId_version: { conversationId: mine.id, version: 1 } }, data: { pptx: null } });
    await prisma.assistantDeckBuild.create({ data: { conversationId: mine.id, version: 1, status: "done", pptx: BUILT, finishedAt: new Date() } });

    // Act
    actAs("alice");
    const restored = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 3 });

    // Assert
    expect(restored).toEqual({ ok: true, restored: true, version: 4 });
    const kept = await prisma.assistantDeckVersion.findUniqueOrThrow({ where: { conversationId_version: { conversationId: mine.id, version: 4 } } });
    expect(Buffer.from(kept.pptx!)).toEqual(BUILT);
  });

  it("should restore with no .pptx when the restored version has none kept or built", async () => {
    // Arrange
    const { mine } = await deckOf(3);
    await prisma.assistantDeckBuild.create({ data: { conversationId: mine.id, version: 2, status: "failed", error: "nope", finishedAt: new Date() } });

    // Act
    actAs("alice");
    const restored = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 2, baseVersion: 3 });

    // Assert
    expect(restored).toEqual({ ok: true, restored: true, version: 4 });
    expect((await readDeck(prisma, mine.id)).pptx).toBe(false);
  });

  it("should write nothing and say what is there now when the deck moved on since the base", async () => {
    // Arrange
    const { mine } = await deckOf(3);

    // Act
    actAs("alice");
    const stale = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 });

    // Assert
    expect(stale).toEqual({ ok: true, restored: false, current: { version: 3, updatedBy: "agent" } });
    expect((await readDeck(prisma, mine.id)).version).toBe(3);
  });

  it("should refuse a reader, a stranger, the latest version and one not kept, writing nothing", async () => {
    // Arrange
    const { mine } = await deckOf(2);
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const missing = { ok: false, error: "that version of the slides is not there" };

    // Act and assert
    actAs("bob");
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 })).toEqual(missing);
    actAs("carol");
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 })).toEqual(missing);
    actAs("alice");
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 2, baseVersion: 2 })).toEqual({
      ok: false,
      error: "that is already the latest version"
    });
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 9, baseVersion: 2 })).toEqual(missing);
    expect(await deckActions.restoreDeckVersion({ conversationId: mine.id, version: "1", baseVersion: 2 })).toEqual(missing);
    expect((await readDeck(prisma, mine.id)).version).toBe(2);
  });

  it("should refuse, saying so, a version naming a picture the hub has since dropped", async () => {
    // Arrange
    const { mine, sha } = await deckOf(2);
    await prisma.assistantDeckAsset.delete({ where: { conversationId_sha256: { conversationId: mine.id, sha256: sha } } });

    // Act
    actAs("alice");
    const refused = await deckActions.restoreDeckVersion({ conversationId: mine.id, version: 1, baseVersion: 2 });

    // Assert
    expect(refused).toEqual({ ok: false, error: "Version 1's pictures are no longer held, so it can't be restored." });
    expect((await readDeck(prisma, mine.id)).version).toBe(2);
  });

  it("should answer that the version is not there, not ask for its pictures, when a write drops it while the restore waits for the lock", async () => {
    // Arrange
    const { mine, sha } = await deckOf(2);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dropped!: () => void;
    const droppedYet = new Promise<void>((resolve) => {
      dropped = resolve;
    });
    // What an upload's makeRoom does under the conversation's lock: version 1 and the picture only it names go.
    const upload = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM assistant_conversation WHERE id = ${mine.id}::uuid FOR UPDATE`;
        await tx.assistantDeckVersion.delete({ where: { conversationId_version: { conversationId: mine.id, version: 1 } } });
        await tx.assistantDeckAsset.delete({ where: { conversationId_sha256: { conversationId: mine.id, sha256: sha } } });
        dropped();
        await released;
      },
      { timeout: 15_000 }
    );
    await droppedYet;

    // Act
    const restoring = restoreDeckVersion(prisma, mine.row, { version: 1, baseVersion: 2 });
    await vi.waitFor(
      async () => {
        const [waiting] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
        expect(waiting?.count).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 20 }
    );
    release();
    await upload;
    const restored = await restoring;

    // Assert
    expect(restored).toEqual({ restored: false, missing: true });
    expect((await readDeck(prisma, mine.id)).version).toBe(2);
  });
});

async function readDeckVersionOutline(conversationId: string, version: number) {
  const row = await prisma.assistantDeckVersion.findUnique({ where: { conversationId_version: { conversationId, version } }, select: { outline: true } });
  return row?.outline;
}

describe("building an older version's .pptx", () => {
  it("should record a build, send it to the pod, join a second request to it, and download what the pod built", async () => {
    // Arrange
    const { mine, sha } = await deckOf(4);
    const token = await podFor(mine);
    const other = await store(mine, png(2));

    // Act
    const asked = await prepare("alice", mine.id, 1);
    const { job_id: jobId, status } = await jsonOf<{ status: string; job_id: string }>(asked);
    const again = await jsonOf(await prepare("alice", mine.id, 1));
    const frame = await pendingDeckBuild(prisma, mine.virtualAgentId, jobId);
    const read = await pod(podBuildRoute.GET, token, `/api/virtual/${mine.virtualAgentId}/deck-builds/${jobId}`, {
      virtualAgentId: mine.virtualAgentId,
      jobId
    });
    const picture = (digestOf: string) =>
      pod(podAssetRoute.GET, token, `/api/virtual/${mine.virtualAgentId}/deck-builds/${jobId}/assets/${digestOf}`, {
        virtualAgentId: mine.virtualAgentId,
        jobId,
        sha256: digestOf
      });
    const named = await picture(sha);
    const unnamed = await picture(other);
    const pending = await jsonOf(await buildOf("alice", mine.id, jobId));
    const answered = await podAnswer(mine, token, jobId)({ body: new Uint8Array(BUILT), type: "application/octet-stream" });

    // Assert
    expect(asked.headers.get("cache-control")).toBe("no-store");
    expect(status).toBe("pending");
    expect(again).toEqual({ status: "pending", job_id: jobId });
    expect(frame).toEqual({ job_id: jobId, conversation_id: mine.id, version: 1 });
    expect(await jsonOf(read)).toEqual({ job_id: jobId, conversation_id: mine.id, version: 1, outline: outline("v1", [sha]) });
    expect(named.status).toBe(200);
    expect(named.headers.get("content-type")).toBe("image/png");
    expect(unnamed.status).toBe(404);
    expect(pending).toEqual({ status: "pending", job_id: jobId, version: 1 });
    expect(answered.status).toBe(204);
    expect(await jsonOf(await buildOf("alice", mine.id, jobId))).toEqual({ status: "done", job_id: jobId, version: 1 });
    expect(await pendingDeckBuild(prisma, mine.virtualAgentId, jobId)).toBeUndefined();
    const file = await download("alice", mine.id, 1);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(BUILT);
    expect((await listDeckVersions(prisma, mine.id)).find((entry) => entry.version === 1)?.pptx).toBe(true);
    expect(await jsonOf(await prepare("alice", mine.id, 1))).toEqual({ status: "ready" });
    // Built bytes stay with the build: the version itself still keeps none, as only the latest 3 do.
    expect(
      (await prisma.assistantDeckVersion.findUniqueOrThrow({ where: { conversationId_version: { conversationId: mine.id, version: 1 } } })).pptx
    ).toBeNull();
  });

  it("should let a share's reader download a version built for the owner, but not ask for a build or read one back", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 2));

    // Act
    const asked = await prepare("bob", mine.id, 2);
    const readBack = await buildOf("bob", mine.id, jobId);
    const before = await download("bob", mine.id, 2);
    await answerDeckBuild(prisma, mine.virtualAgentId, jobId, { pptx: BUILT });
    const after = await download("bob", mine.id, 2);

    // Assert
    expect(asked.status).toBe(403);
    expect(readBack.status).toBe(404);
    expect(before.status).toBe(404);
    expect(after.status).toBe(200);
    expect((await prepare("carol", mine.id, 2)).status).toBe(404);
    expect((await buildOf("carol", mine.id, jobId)).status).toBe(404);
  });

  it("should keep the pod's error for the person, and ignore a second answer", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    const token = await podFor(mine);
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 1));
    const answer = podAnswer(mine, token, jobId);

    // Act
    const failed = await answer({ body: JSON.stringify({ error: "This version could not be built: slide 2: too many bullets" }), type: "application/json" });
    const late = await answer({ body: new Uint8Array(BUILT), type: "application/octet-stream" });

    // Assert
    expect(failed.status).toBe(204);
    expect(late.status).toBe(204);
    expect(await jsonOf(await buildOf("alice", mine.id, jobId))).toEqual({
      status: "failed",
      job_id: jobId,
      version: 1,
      error: "This version could not be built: slide 2: too many bullets"
    });
    expect((await download("alice", mine.id, 1)).status).toBe(404);
    // A failed build does not hold the next request back.
    expect(await jsonOf(await prepare("alice", mine.id, 1))).toMatchObject({ status: "pending", job_id: expect.not.stringMatching(jobId) });
  });

  it("should refuse an answer that is not a .pptx or is too big, and an error that is empty", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    const token = await podFor(mine);
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 1));
    const answer = podAnswer(mine, token, jobId);

    // Act and assert
    expect((await answer({ body: new Uint8Array([1, 2, 3, 4]), type: "application/octet-stream" })).status).toBe(400);
    expect((await answer({ body: new Uint8Array(5 * 1024 * 1024 + 1).fill(0x50), type: "application/octet-stream" })).status).toBe(413);
    expect((await answer({ body: JSON.stringify({ error: " " }), type: "application/json" })).status).toBe(400);
    expect(await jsonOf(await buildOf("alice", mine.id, jobId))).toMatchObject({ status: "pending" });
  });

  it("should not let another assistant's pod read or answer the build", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 1));
    actAs("bob");
    await ensureAssistant(prisma, viewerOf(BOB));
    const bobs = await prisma.virtualAgent.findFirstOrThrow({ where: { ownerOid: BOB.oid }, select: { id: true } });

    // Act
    await answerDeckBuild(prisma, bobs.id, jobId, { pptx: BUILT });

    // Assert
    expect(await pendingDeckBuild(prisma, bobs.id, jobId)).toBeUndefined();
    expect(await readDeckBuild(prisma, ALICE.oid, mine.id, jobId)).toMatchObject({ status: "pending" });
  });

  it("should time a build out after 15 minutes, ignore the pod's late answer, and start a new one when asked again", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    const then = new Date(Date.now() - DECK_BUILD_TIMEOUT_MS - 1000);
    const asked = await requestDeckBuild(prisma, ALICE.oid, mine.id, 1, then);
    const jobId = (asked as { job_id: string }).job_id;

    // Act
    const read = await jsonOf(await buildOf("alice", mine.id, jobId));
    await answerDeckBuild(prisma, mine.virtualAgentId, jobId, { pptx: BUILT });
    const next = await jsonOf<{ status: string; job_id: string }>(await prepare("alice", mine.id, 1));

    // Assert
    expect(read).toEqual({ status: "timeout", job_id: jobId, version: 1 });
    expect((await download("alice", mine.id, 1)).status).toBe(404);
    expect(next.status).toBe("pending");
    expect(next.job_id).not.toBe(jobId);
    expect((await prisma.assistantDeckBuild.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("timeout");
  });

  it("should sweep builds past their time and those older than a day, bytes and all", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    const now = new Date();
    // Written as rows, since asking for a build writes down the conversation's timed-out ones itself.
    const old = await prisma.assistantDeckBuild.create({
      data: { conversationId: mine.id, version: 1, status: "failed", error: "old", createdAt: new Date(now.getTime() - DECK_BUILD_KEEP_MS - 60_000) },
      select: { id: true }
    });
    const fresh = await requestDeckBuild(prisma, ALICE.oid, mine.id, 1, now);
    await answerDeckBuild(prisma, mine.virtualAgentId, (fresh as { job_id: string }).job_id, { pptx: BUILT }, now);
    const stuck = await prisma.assistantDeckBuild.create({
      data: { conversationId: mine.id, version: 2, createdAt: new Date(now.getTime() - DECK_BUILD_TIMEOUT_MS - 60_000) },
      select: { id: true }
    });

    // Act
    const swept = await sweepDeckBuilds(prisma, now);

    // Assert
    expect(swept).toEqual({ timedOut: 1, deleted: 1 });
    expect(await prisma.assistantDeckBuild.findUnique({ where: { id: old.id } })).toBeNull();
    expect((await prisma.assistantDeckBuild.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("timeout");
    expect((await download("alice", mine.id, 1)).status).toBe(200);
    // A day on, the built bytes are gone with the build.
    await sweepDeckBuilds(prisma, new Date(now.getTime() + DECK_BUILD_KEEP_MS + 1000));
    expect(await prisma.assistantDeckBuild.count({ where: { conversationId: mine.id } })).toBe(0);
    expect((await download("alice", mine.id, 1)).status).toBe(404);
  });

  it(`should keep a conversation's ${DECK_BUILDS_KEPT} newest finished builds`, async () => {
    // Arrange
    const { mine } = await deckOf(DECK_BUILDS_KEPT + 4);
    await podFor(mine);
    const start = Date.now() - 60 * 60_000;

    // Act
    for (let version = 1; version <= DECK_BUILDS_KEPT + 1; version += 1) {
      const at = new Date(start + version * 1000);
      const asked = await requestDeckBuild(prisma, ALICE.oid, mine.id, version, at);
      await answerDeckBuild(prisma, mine.virtualAgentId, (asked as { job_id: string }).job_id, { error: `no ${version}` }, at);
    }

    // Assert
    const kept = await prisma.assistantDeckBuild.findMany({ where: { conversationId: mine.id }, select: { version: true } });
    expect(kept.map((row) => row.version).sort((a, b) => a - b)).toEqual(Array.from({ length: DECK_BUILDS_KEPT }, (_, index) => index + 2));
  });

  it("should offer the latest version's .pptx once a build of it is done, to the owner, a share's reader and the session", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 4));
    const before = await deckView(prisma, mine.id);

    // Act
    await answerDeckBuild(prisma, mine.virtualAgentId, jobId, { pptx: BUILT });

    // Assert
    expect(before?.pptx).toBe(false);
    const panel = (as: string) => browser(deckUiRoute.GET, as, base(mine.id), { conversationId: mine.id });
    expect(await jsonOf(await panel("alice"))).toMatchObject({ version: 4, pptx: true });
    expect(await jsonOf(await panel("bob"))).toMatchObject({ version: 4, pptx: true });
    expect((await readDeck(prisma, mine.id)).pptx).toBe(true);
    expect(await deckSummary(prisma, mine.id, { deckTitle: "v4", deckVersion: 4, deckRevision: 4, deckUpdatedBy: "user" })).toMatchObject({ pptx: true });
    expect((await listDeckVersions(prisma, mine.id))[0]).toMatchObject({ version: 4, pptx: true });
    // A day on, the build is no longer held, by every one of them alike.
    const dayOn = new Date(Date.now() + DECK_BUILD_KEEP_MS + 60_000);
    expect((await readDeck(prisma, mine.id, dayOn)).pptx).toBe(false);
    expect((await deckView(prisma, mine.id, dayOn))?.pptx).toBe(false);
    expect((await listDeckVersions(prisma, mine.id, dayOn))[0]?.pptx).toBe(false);
  });

  it("should give the pod a picture only while its build is pending, and only to the build's own assistant", async () => {
    // Arrange
    const { mine, sha } = await deckOf(4);
    await podFor(mine);
    const { job_id: jobId } = await jsonOf<{ job_id: string }>(await prepare("alice", mine.id, 1));
    actAs("bob");
    await ensureAssistant(prisma, viewerOf(BOB));
    const bobs = await prisma.virtualAgent.findFirstOrThrow({ where: { ownerOid: BOB.oid }, select: { id: true } });
    const late = new Date(Date.now() + DECK_BUILD_TIMEOUT_MS + 1000);

    // Act
    const pending = await podDeckBuildAsset(prisma, mine.virtualAgentId, jobId, sha);
    const timedOut = await podDeckBuildAsset(prisma, mine.virtualAgentId, jobId, sha, late);
    const another = await podDeckBuildAsset(prisma, bobs.id, jobId, sha);
    const notAJob = await podDeckBuildAsset(prisma, mine.virtualAgentId, "not-a-job", sha);
    await answerDeckBuild(prisma, mine.virtualAgentId, jobId, { error: "no" });
    const answered = await podDeckBuildAsset(prisma, mine.virtualAgentId, jobId, sha);

    // Assert
    expect(pending?.mime).toBe("image/png");
    expect(Buffer.from(pending!.bytes)).toEqual(png(1));
    expect(timedOut).toBeUndefined();
    expect(another).toBeUndefined();
    expect(notAJob).toBeUndefined();
    expect(answered).toBeUndefined();
  });

  it("should answer ready, recording nothing, for a version the hub already holds a .pptx of", async () => {
    // Arrange
    const { mine } = await deckOf(2);
    await podFor(mine);

    // Act
    const answer = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "ready" });
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should answer 404 for a version the deck does not keep, or that is not a number", async () => {
    const { mine } = await deckOf(2);
    await podFor(mine);
    expect((await prepare("alice", mine.id, 9)).status).toBe(404);
    expect((await prepare("alice", mine.id, "latest")).status).toBe(404);
  });
});

describe("the deck build's gate", () => {
  it("should answer unsupported, recording nothing, for a pod whose client has not claimed deck-build", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine, ["welsh"]);

    // Act
    const answer = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "unsupported" });
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should answer assistant_gone, recording nothing, for a chat whose assistant has been replaced", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { desired: "deleted" } });
    await ensureAssistant(prisma, viewerOf(ALICE));

    // Act
    const answer = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "assistant_gone" });
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should answer no_pod, recording nothing, for a local session's chat", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await prisma.assistantConversation.update({ where: { id: mine.id }, data: { virtualAgentId: null } });

    // Act
    const answer = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "no_pod" });
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should start a stopped assistant and answer waking, recording nothing", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { desired: "stopped", status: "stopped" } });

    // Act
    const answer = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "waking" });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: mine.virtualAgentId } })).desired).toBe("running");
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should answer waking while the pod has claimed nothing yet, and while a change is not yet applied", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { generation: { increment: 1 } } });

    // Act
    const behind = await jsonOf(await prepare("alice", mine.id, 1));
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { generation: { decrement: 1 }, status: "provisioning" } });
    const booting = await jsonOf(await prepare("alice", mine.id, 1));
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { status: "running" } });
    await prisma.$executeRaw`UPDATE virtual_agent SET client_features = NULL WHERE id = ${mine.virtualAgentId}::uuid`;
    const unclaimed = await jsonOf(await prepare("alice", mine.id, 1));

    // Assert
    expect(behind).toEqual({ status: "waking" });
    expect(booting).toEqual({ status: "waking" });
    expect(unclaimed).toEqual({ status: "waking" });
    expect(await prisma.assistantDeckBuild.count()).toBe(0);
  });

  it("should record the build when the assistant has no plugins ticked, since every pod loads slides", async () => {
    // Arrange
    const { mine } = await deckOf(4);
    await podFor(mine);
    await prisma.virtualAgent.update({ where: { id: mine.virtualAgentId }, data: { plugins: [] } });

    // Act
    const answer = await jsonOf<{ status: string; job_id: string }>(await prepare("alice", mine.id, 1));

    // Assert
    expect(answer).toEqual({ status: "pending", job_id: expect.any(String) });
    expect(await prisma.assistantDeckBuild.count()).toBe(1);
  });

  it("should answer 404 with virtual agents off", async () => {
    const { mine } = await deckOf(4);
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    expect((await prepare("alice", mine.id, 1)).status).toBe(404);
  });
});
