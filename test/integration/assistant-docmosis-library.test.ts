// The template library's index through Postgres: opening it from the browser, the check the pod is sent, the pod's
// answer and who may read any of it. The pod's own half — reading GitHub — is in the client package's
// `src/assistant/docmosis-library.test.ts`.
import { NextRequest } from "next/server";
import type pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as entriesRoute from "../../src/app/api/ui/assistant/docmosis-library/entries/route.ts";
import * as libraryRoute from "../../src/app/api/ui/assistant/docmosis-library/route.ts";
import {
  FORCED_REFRESH_MIN_MS,
  FORCED_REPLACES_PENDING_MS,
  INDEX_REFRESH_PENDING_MS,
  INDEX_REVALIDATE_MS,
  type IndexEntry,
  MAX_RESET_MS
} from "../../src/assistant/docmosis-library.ts";
import { answerIndex, openLibrary, pendingIndexFrame, readLibrary, readLibraryEntries } from "../../src/assistant/docmosis-library-store.ts";
import { decodeEvent, HUB_CHANNEL, type NotifiedEvent } from "../../src/realtime/events.ts";
import { createVirtualAgent, setDesired } from "../../src/virtual-agents/store.ts";
import { ALICE, type AssistantFixture, BOB, podFixture } from "./assistant-pod.ts";
import { connect, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

let listener: pg.Client;
let heard: NotifiedEvent[];

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  heard = [];
  listener = await connect();
  listener.on("notification", (notification) => {
    const event = decodeEvent(notification.payload);
    if (event !== undefined) {
      heard.push(event);
    }
  });
  await listener.query(`LISTEN ${HUB_CHANNEL}`);
});

afterEach(async () => {
  await listener.end();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const claiming = podFixture(["docmosis-library"]);

/** An assistant whose pod claims the library and has caught up with every change, as one the orchestrator has applied. */
const assistantOf: AssistantFixture = async (...args) => {
  const id = await claiming(...args);
  const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id }, select: { generation: true } });
  await prisma.virtualAgent.update({ where: { id }, data: { observedGeneration: row.generation } });
  return id;
};

const NOW = new Date("2026-11-18T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const COMMIT = "c".repeat(40);
const NEXT = "d".repeat(40);
const BLOB = "b".repeat(40);
const ENTRIES: IndexEntry[] = [
  ["Templates/Base/Claim form.docx", BLOB, 1200],
  ["Templates/Base/Defence.docx", BLOB, 900]
];

/** Allowed a moment to arrive, since a NOTIFY is delivered on its own connection after the commit. */
async function events(type: NotifiedEvent["type"]): Promise<NotifiedEvent[]> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return heard.filter((event) => event.type === type);
}

async function requestIdOf(ownerOid: string): Promise<string> {
  const row = await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid }, select: { refreshId: true } });
  return row.refreshId as string;
}

function openRaw(body: string, persona = "alice") {
  return libraryRoute.POST(
    new NextRequest("http://localhost:3000/api/ui/assistant/docmosis-library", {
      method: "POST",
      headers: { cookie: `ah_dev_persona=${persona}`, "content-type": "application/json" },
      body
    })
  );
}

function open(body: unknown, persona = "alice") {
  return openRaw(JSON.stringify(body), persona);
}

function read(persona = "alice") {
  return libraryRoute.GET(new NextRequest("http://localhost:3000/api/ui/assistant/docmosis-library", { headers: { cookie: `ah_dev_persona=${persona}` } }));
}

function entriesAt(url: string, persona = "alice") {
  return entriesRoute.GET(new NextRequest(`http://localhost:3000${url}`, { headers: { cookie: `ah_dev_persona=${persona}` } }));
}

async function keyOf(ownerOid: string): Promise<string> {
  return (await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid }, select: { entriesKey: true } })).entriesKey;
}

/** The entries at `commit`, read with `ownerOid`'s key, which is Alice's unless said otherwise. */
async function entriesOf(commit: string, persona = "alice", ownerOid = ALICE.oid) {
  return entriesAt(`/api/ui/assistant/docmosis-library/entries?commit=${commit}&key=${await keyOf(ownerOid)}`, persona);
}

describe("the template library", () => {
  it("should ask the pod on first open, frame the check, keep the index it answers and serve it to its owner alone", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await assistantOf(BOB);

    // Act
    const opened = await open({});
    const status = await jsonOf(opened);
    const requestId = await requestIdOf(ALICE.oid);
    const frame = await pendingIndexFrame(prisma, { id: assistant, ownerOid: ALICE.oid }, requestId);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, requestId, { commit: COMMIT, etag: '"e1"', entries: ENTRIES });
    const after = await jsonOf(await open({}));
    const served = await entriesOf(COMMIT);

    // Assert
    expect(opened.headers.get("cache-control")).toBe("no-store");
    expect(status).toMatchObject({ library: "hmcts/rdo-docmosis@HEAD:Templates", pod: "ok", commit: null, refreshing: true, failure: null });
    expect(frame).toEqual({ request_id: requestId, owner: "hmcts", repo: "rdo-docmosis", ref: "HEAD", path: "Templates", commit: null, etag: null });
    expect(await events("assistant_docmosis_index")).toEqual([
      { type: "assistant_docmosis_index", request_id: requestId, virtual_agent_id: assistant, owner_oid: ALICE.oid }
    ]);
    expect(await events("assistant_docmosis_library")).toEqual([{ type: "assistant_docmosis_library", owner_oid: ALICE.oid }]);
    expect(after).toMatchObject({
      commit: COMMIT,
      entry_count: 2,
      dropped: 0,
      entries_url: `/api/ui/assistant/docmosis-library/entries?commit=${COMMIT}&key=${await keyOf(ALICE.oid)}`,
      refreshing: false,
      failure: null
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(served.headers.get("vary")).toBeNull();
    expect(await jsonOf(served)).toEqual({ commit: COMMIT, entries: ENTRIES });
    expect((await entriesOf(COMMIT, "bob")).status).toBe(404);
    expect(await pendingIndexFrame(prisma, { id: assistant, ownerOid: ALICE.oid }, requestId)).toBeUndefined();
  });

  it("should join a check still pending rather than send another", async () => {
    // Arrange
    await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const first = await requestIdOf(ALICE.oid);

    // Act
    const joined = await openLibrary(prisma, ALICE.oid, { force: true }, later(1000));

    // Assert
    expect(joined.refreshing).toBe(true);
    expect(await requestIdOf(ALICE.oid)).toBe(first);
    expect(await events("assistant_docmosis_index")).toHaveLength(1);
  });

  it("should not ask again while the index is fresh, and ask once it is five minutes old", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: '"e1"', entries: ENTRIES }, NOW);

    // Act
    const fresh = await openLibrary(prisma, ALICE.oid, { force: false }, later(INDEX_REVALIDATE_MS - 1));
    const stale = await openLibrary(prisma, ALICE.oid, { force: false }, later(INDEX_REVALIDATE_MS));
    const frame = await pendingIndexFrame(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), later(INDEX_REVALIDATE_MS));

    // Assert
    expect(fresh.refreshing).toBe(false);
    expect(stale.refreshing).toBe(true);
    expect(frame).toMatchObject({ commit: COMMIT, etag: '"e1"' });
  });

  it("should refuse a forced check within 30 seconds of the last forced one, and allow it after", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: true }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);

    // Act
    const refused = openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS - 1));

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 429 });
    expect((await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS))).refreshing).toBe(true);
  });

  it("should answer 429 from the route for a forced check too soon", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await open({ force: true });
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES });

    // Act
    const response = await open({ force: true });

    // Assert
    expect(response.status).toBe(429);
  });

  it("should ignore an answer to a check that is not the last sent, or is two minutes old", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const lost = await requestIdOf(ALICE.oid);

    // Act
    await answerIndex(prisma, va, lost, { commit: COMMIT, etag: null, entries: ENTRIES }, later(INDEX_REFRESH_PENDING_MS));
    await openLibrary(prisma, ALICE.oid, { force: false }, later(INDEX_REFRESH_PENDING_MS));
    const current = await requestIdOf(ALICE.oid);
    await answerIndex(prisma, va, lost, { commit: COMMIT, etag: null, entries: ENTRIES }, later(INDEX_REFRESH_PENDING_MS + 1));
    await answerIndex(prisma, va, "not-a-uuid", { commit: COMMIT, etag: null, entries: ENTRIES }, later(INDEX_REFRESH_PENDING_MS + 1));

    // Assert
    expect(current).not.toBe(lost);
    expect(await pendingIndexFrame(prisma, { id: assistant, ownerOid: ALICE.oid }, lost, later(INDEX_REFRESH_PENDING_MS + 1))).toBeUndefined();
    const row = await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } });
    expect(row).toMatchObject({ commitSha: null, refreshId: current });
    expect(await events("assistant_docmosis_library")).toEqual([]);
  });

  it("should neither frame nor keep a check for another person's pod", async () => {
    // Arrange
    await assistantOf(ALICE);
    const bobs = await assistantOf(BOB);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const requestId = await requestIdOf(ALICE.oid);

    // Act
    const frame = await pendingIndexFrame(prisma, { id: bobs, ownerOid: BOB.oid }, requestId, NOW);
    await answerIndex(prisma, { id: bobs, ownerOid: BOB.oid }, requestId, { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);

    // Assert
    expect(frame).toBeUndefined();
    expect(await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } })).toMatchObject({ commitSha: null, refreshId: requestId });
  });

  it("should refuse an index with a path outside the library and keep the one held", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    await openLibrary(prisma, ALICE.oid, { force: true }, later(1000));
    const requestId = await requestIdOf(ALICE.oid);

    // Act
    const refused = answerIndex(prisma, va, requestId, { commit: NEXT, etag: null, entries: [["Templates/../secrets.docx", BLOB, 1]] }, later(2000));

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 400 });
    expect(await readLibraryEntries(prisma, ALICE.oid, COMMIT, await keyOf(ALICE.oid))).toEqual({ commit: COMMIT, entries: ENTRIES });
    expect(await requestIdOf(ALICE.oid)).toBe(requestId);
  });

  it("should confirm an unchanged index, keeping the ETag unless given another", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: '"e1"', entries: ENTRIES }, NOW);

    // Act
    await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS));
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { unchanged: true }, later(FORCED_REFRESH_MIN_MS));
    const kept = await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } });
    await openLibrary(prisma, ALICE.oid, { force: true }, later(2 * FORCED_REFRESH_MIN_MS));
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { unchanged: true, etag: '"e2"' }, later(2 * FORCED_REFRESH_MIN_MS));
    const replaced = await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } });

    // Assert
    expect(kept).toMatchObject({ commitSha: COMMIT, etag: '"e1"', checkedAt: later(FORCED_REFRESH_MIN_MS), refreshId: null });
    expect(replaced).toMatchObject({ commitSha: COMMIT, etag: '"e2"', entryCount: 2 });
  });

  it("should refuse an unchanged answer when there is no index to keep", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);

    // Act
    const refused = answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { unchanged: true }, NOW);

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 400 });
  });

  it("should record a failure beside the index held, and clear it on the next good answer", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    await openLibrary(prisma, ALICE.oid, { force: true }, later(1000));

    // Act
    await answerIndex(
      prisma,
      va,
      await requestIdOf(ALICE.oid),
      { error: "sso", detail: "Authorise the token", sso_url: "https://github.com/orgs/hmcts/sso" },
      later(1000)
    );
    const failed = await openLibrary(prisma, ALICE.oid, { force: false }, later(2000));
    await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS + 1000));
    await answerIndex(
      prisma,
      va,
      await requestIdOf(ALICE.oid),
      { commit: NEXT, etag: null, entries: ENTRIES.slice(0, 1) },
      later(FORCED_REFRESH_MIN_MS + 1000)
    );
    const recovered = await openLibrary(prisma, ALICE.oid, { force: false }, later(FORCED_REFRESH_MIN_MS + 2000));

    // Assert
    expect(failed).toMatchObject({
      commit: COMMIT,
      entry_count: 2,
      failure: { reason: "sso", detail: "Authorise the token", sso_url: "https://github.com/orgs/hmcts/sso" }
    });
    expect(recovered).toMatchObject({ commit: NEXT, entry_count: 1, failure: null });
    expect(await readLibraryEntries(prisma, ALICE.oid, COMMIT, await keyOf(ALICE.oid))).toBeUndefined();
  });

  it("should keep a rate limit's reset time", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);

    // Act
    await answerIndex(
      prisma,
      { id: assistant, ownerOid: ALICE.oid },
      await requestIdOf(ALICE.oid),
      { error: "rate_limited", reset_at: "2026-11-18T12:30:00Z" },
      NOW
    );

    // Assert
    expect((await openLibrary(prisma, ALICE.oid, { force: false }, later(1000))).failure).toEqual({
      reason: "rate_limited",
      reset_at: "2026-11-18T12:30:00.000Z"
    });
  });

  it("should start a stopped assistant while there is no index, and record nothing", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await setDesired(prisma, ALICE.oid, assistant, "stopped");

    // Act
    const status = await openLibrary(prisma, ALICE.oid, { force: false }, NOW);

    // Assert
    expect(status).toMatchObject({ pod: "waking", refreshing: false, commit: null });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { desired: true } })).desired).toBe("running");
    expect(await prisma.assistantDocmosisLibrary.count()).toBe(0);
  });

  it("should serve the index of a stopped assistant without starting it", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    await setDesired(prisma, ALICE.oid, assistant, "stopped");

    // Act
    const status = await openLibrary(prisma, ALICE.oid, { force: true }, later(INDEX_REVALIDATE_MS));

    // Assert
    expect(status).toMatchObject({ pod: "stopped", commit: COMMIT, refreshing: false });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { desired: true } })).desired).toBe("stopped");
  });

  it("should say the pod needs an update, sending nothing, when its client has not claimed the library", async () => {
    // Arrange
    await assistantOf(ALICE, ["deck-build"]);

    // Act
    const status = await jsonOf(await open({}));

    // Assert
    expect(status).toMatchObject({ pod: "unsupported", refreshing: false });
    expect(await prisma.assistantDocmosisLibrary.count()).toBe(0);
    expect(await events("assistant_docmosis_index")).toEqual([]);
  });

  it("should answer 404 for someone with no assistant, and on a deployment without virtual agents", async () => {
    // Arrange
    await assistantOf(ALICE);

    // Act
    const nobody = await open({}, "bob");
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    const off = await open({});
    const offEntries = await entriesAt(`/api/ui/assistant/docmosis-library/entries?commit=${COMMIT}&key=0f8a6a1e-1234-4000-8000-00000000000a`);

    // Assert
    expect(nobody.status).toBe(404);
    expect(off.status).toBe(404);
    expect(offEntries.status).toBe(404);
  });

  it("should refuse a force that is not a boolean, and a commit that is not one", async () => {
    // Arrange
    await assistantOf(ALICE);
    await open({});

    // Act
    const badForce = await open({ force: "yes" });
    const badCommit = await entriesOf("HEAD");
    const unknown = await entriesOf(NEXT);

    // Assert
    expect(badForce.status).toBe(400);
    expect(badCommit.status).toBe(400);
    expect(unknown.status).toBe(404);
  });

  it.each([
    ["null", "null"],
    ["a number", "7"],
    ["a string", '"force"'],
    ["an array", "[true]"]
  ])("should answer 400 rather than 500 when the body is %s", async (_label, body) => {
    // Arrange
    await assistantOf(ALICE);

    // Act
    const response = await openRaw(body);

    // Assert
    expect(response.status).toBe(400);
    expect(await prisma.assistantDocmosisLibrary.count()).toBe(0);
  });

  it("should open the library when the body is empty", async () => {
    // Arrange
    await assistantOf(ALICE);

    // Act
    const response = await openRaw("");

    // Assert
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ pod: "ok", refreshing: true });
  });

  it("should not ask again when the first check failed and there is no index, until five minutes have passed", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { error: "signed_out" }, later(1000));

    // Act
    const reopened = await openLibrary(prisma, ALICE.oid, { force: false }, later(2000));
    const stillWaiting = await openLibrary(prisma, ALICE.oid, { force: false }, later(1000 + INDEX_REVALIDATE_MS - 1));
    const asked = await openLibrary(prisma, ALICE.oid, { force: false }, later(1000 + INDEX_REVALIDATE_MS));

    // Assert
    expect(reopened).toMatchObject({ refreshing: false, commit: null, failure: { reason: "signed_out" } });
    expect(stillWaiting.refreshing).toBe(false);
    expect(asked.refreshing).toBe(true);
    expect(await events("assistant_docmosis_index")).toHaveLength(2);
  });

  it("should ask again when forced, when the first check failed and there is no index", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { error: "not_found" }, later(1000));

    // Act
    const forced = await openLibrary(prisma, ALICE.oid, { force: true }, later(2000));

    // Assert
    expect(forced.refreshing).toBe(true);
  });

  it("should not ask again before a rate limit resets when there is no index, and ask once it has", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(
      prisma,
      { id: assistant, ownerOid: ALICE.oid },
      await requestIdOf(ALICE.oid),
      { error: "rate_limited", reset_at: later(60_000).toISOString() },
      NOW
    );

    // Act
    const before = await openLibrary(prisma, ALICE.oid, { force: false }, later(60_000 - 1));
    const after = await openLibrary(prisma, ALICE.oid, { force: false }, later(60_000));

    // Assert
    expect(before.refreshing).toBe(false);
    expect(after.refreshing).toBe(true);
  });

  it("should refuse a forced check within 30 seconds of the last forced one when a check without force was asked for between them", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: true }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    await prisma.assistantDocmosisLibrary.update({
      where: { ownerOid_libraryId: { ownerOid: ALICE.oid, libraryId: "hmcts/rdo-docmosis@HEAD:Templates" } },
      data: { checkedAt: new Date(NOW.getTime() - INDEX_REVALIDATE_MS) }
    });
    await openLibrary(prisma, ALICE.oid, { force: false }, later(1000));
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { unchanged: true }, later(2000));

    // Act
    const refused = openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS - 1));

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 429 });
  });

  it("should serve the entries only at the owner's own address, when two people hold the same commit", async () => {
    // Arrange
    const alices = await assistantOf(ALICE);
    const bobs = await assistantOf(BOB);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await openLibrary(prisma, BOB.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: alices, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    await answerIndex(prisma, { id: bobs, ownerOid: BOB.oid }, await requestIdOf(BOB.oid), { commit: COMMIT, etag: null, entries: ENTRIES.slice(0, 1) }, NOW);

    // Act
    const alicesStatus = await openLibrary(prisma, ALICE.oid, { force: false }, later(1000));
    const bobsStatus = await openLibrary(prisma, BOB.oid, { force: false }, later(1000));
    const bobAtAlices = await entriesAt(alicesStatus.entries_url as string, "bob");
    const bobAtHis = await entriesAt(bobsStatus.entries_url as string, "bob");
    const noKey = await entriesAt(`/api/ui/assistant/docmosis-library/entries?commit=${COMMIT}`, "bob");

    // Assert
    expect(alicesStatus.entries_url).not.toBe(bobsStatus.entries_url);
    expect(bobAtAlices.status).toBe(404);
    expect(await jsonOf(bobAtHis)).toEqual({ commit: COMMIT, entries: ENTRIES.slice(0, 1) });
    expect(noKey.status).toBe(400);
  });

  it("should keep how many templates the pod left out, and keep it through an unchanged answer", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES, dropped: 12 }, NOW);
    await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REFRESH_MIN_MS));

    // Act
    await answerIndex(prisma, va, await requestIdOf(ALICE.oid), { unchanged: true }, later(FORCED_REFRESH_MIN_MS));
    const status = await openLibrary(prisma, ALICE.oid, { force: false }, later(FORCED_REFRESH_MIN_MS + 1000));

    // Assert
    expect(status).toMatchObject({ commit: COMMIT, entry_count: 2, dropped: 12 });
  });

  it("should neither frame nor keep a check for another of the owner's virtual agents", async () => {
    // Arrange
    await assistantOf(ALICE);
    const other = await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "own-licence", name: "other" });
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const requestId = await requestIdOf(ALICE.oid);

    // Act
    const frame = await pendingIndexFrame(prisma, { id: other.id, ownerOid: ALICE.oid }, requestId, NOW);
    await answerIndex(prisma, { id: other.id, ownerOid: ALICE.oid }, requestId, { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);

    // Assert
    expect(frame).toBeUndefined();
    expect(await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } })).toMatchObject({ commitSha: null, refreshId: requestId });
  });

  it("should replace a forced check pending for 15 seconds, the lost one's answer then ignored", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const lost = await requestIdOf(ALICE.oid);

    // Act
    const joined = await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REPLACES_PENDING_MS - 1));
    const joinedId = await requestIdOf(ALICE.oid);
    const replaced = await openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REPLACES_PENDING_MS));
    const current = await requestIdOf(ALICE.oid);
    await answerIndex(prisma, va, lost, { commit: COMMIT, etag: null, entries: ENTRIES }, later(FORCED_REPLACES_PENDING_MS + 1));

    // Assert
    expect(joined.refreshing).toBe(true);
    expect(joinedId).toBe(lost);
    expect(replaced.refreshing).toBe(true);
    expect(current).not.toBe(lost);
    expect(await pendingIndexFrame(prisma, va, current, later(FORCED_REPLACES_PENDING_MS + 1))).toMatchObject({ request_id: current });
    expect((await events("assistant_docmosis_index")).map((event) => (event as { request_id: string }).request_id)).toEqual([lost, current]);
    expect(await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } })).toMatchObject({ commitSha: null, refreshId: current });
  });

  it("should refuse a forced check that would replace a pending one within 30 seconds of the last forced one", async () => {
    // Arrange
    await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: true }, NOW);

    // Act
    const refused = openLibrary(prisma, ALICE.oid, { force: true }, later(FORCED_REPLACES_PENDING_MS));

    // Assert
    await expect(refused).rejects.toMatchObject({ status: 429 });
  });

  it("should read refreshing false once a check has gone two minutes unanswered, asking nothing", async () => {
    // Arrange
    await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    const lost = await requestIdOf(ALICE.oid);

    // Act
    const before = await readLibrary(prisma, ALICE.oid, later(INDEX_REFRESH_PENDING_MS - 1));
    const after = await readLibrary(prisma, ALICE.oid, later(INDEX_REFRESH_PENDING_MS));

    // Assert
    expect(before.refreshing).toBe(true);
    expect(after.refreshing).toBe(false);
    expect(await requestIdOf(ALICE.oid)).toBe(lost);
    expect(await events("assistant_docmosis_index")).toHaveLength(1);
  });

  it("should answer the status from GET without asking the pod, when no check has ever been asked for", async () => {
    // Arrange
    await assistantOf(ALICE);

    // Act
    const response = await read();

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await jsonOf(response)).toMatchObject({ library: "hmcts/rdo-docmosis@HEAD:Templates", pod: "ok", commit: null, refreshing: false, failure: null });
    expect(await prisma.assistantDocmosisLibrary.count()).toBe(0);
    expect(await events("assistant_docmosis_index")).toEqual([]);
  });

  it("should answer the status from GET without asking the pod, when a check is due", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await open({});
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES });
    await prisma.assistantDocmosisLibrary.updateMany({ where: { ownerOid: ALICE.oid }, data: { checkedAt: new Date(Date.now() - INDEX_REVALIDATE_MS) } });
    heard = [];

    // Act
    const status = await jsonOf(await read());

    // Assert
    expect(status).toMatchObject({ commit: COMMIT, entry_count: 2, refreshing: false });
    expect(await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid } })).toMatchObject({ refreshId: null });
    expect(await events("assistant_docmosis_index")).toEqual([]);
  });

  it("should say a stopped assistant is stopped from GET, and not start it, when there is no index", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await setDesired(prisma, ALICE.oid, assistant, "stopped");

    // Act
    const status = await jsonOf(await read());

    // Assert
    expect(status).toMatchObject({ pod: "stopped", commit: null, refreshing: false });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { desired: true } })).desired).toBe("stopped");
  });

  it("should answer 404 from GET for someone with no assistant, and on a deployment without virtual agents", async () => {
    // Arrange
    await assistantOf(ALICE);

    // Act
    const nobody = await read("bob");
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    const off = await read();

    // Assert
    expect(nobody.status).toBe(404);
    expect(off.status).toBe(404);
  });

  it("should not ask the pod from POST when no check is due, leaving the row unlocked and unchanged", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);
    const before = await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid }, select: { updatedAt: true } });

    // Act
    const status = await openLibrary(prisma, ALICE.oid, { force: false }, later(1000));

    // Assert
    expect(status).toMatchObject({ commit: COMMIT, refreshing: false });
    expect(await prisma.assistantDocmosisLibrary.findFirstOrThrow({ where: { ownerOid: ALICE.oid }, select: { updatedAt: true } })).toEqual(before);
    expect(await events("assistant_docmosis_index")).toHaveLength(1);
  });

  it("should hold a rate limit's reset to an hour from the answer, when the pod gives a later one", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);

    // Act
    await answerIndex(
      prisma,
      { id: assistant, ownerOid: ALICE.oid },
      await requestIdOf(ALICE.oid),
      { error: "rate_limited", reset_at: "9999-12-31T23:59:59Z" },
      NOW
    );

    // Assert
    expect((await readLibrary(prisma, ALICE.oid, later(1000))).failure).toEqual({ reason: "rate_limited", reset_at: later(MAX_RESET_MS).toISOString() });
    expect((await openLibrary(prisma, ALICE.oid, { force: false }, later(MAX_RESET_MS))).refreshing).toBe(true);
  });

  it("should serve the entries at the owner's key written in uppercase", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await openLibrary(prisma, ALICE.oid, { force: false }, NOW);
    await answerIndex(prisma, { id: assistant, ownerOid: ALICE.oid }, await requestIdOf(ALICE.oid), { commit: COMMIT, etag: null, entries: ENTRIES }, NOW);

    // Act
    const served = await entriesAt(`/api/ui/assistant/docmosis-library/entries?commit=${COMMIT}&key=${(await keyOf(ALICE.oid)).toUpperCase()}`);

    // Assert
    expect(served.status).toBe(200);
    expect(await jsonOf(served)).toEqual({ commit: COMMIT, entries: ENTRIES });
  });
});
