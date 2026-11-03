import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import * as assetRoute from "../../src/app/api/agent/[agentId]/deck/assets/[sha256]/route.ts";
import * as deckRoute from "../../src/app/api/agent/[agentId]/deck/route.ts";
import * as pptxRoute from "../../src/app/api/agent/[agentId]/deck/versions/[version]/pptx/route.ts";
import * as browserAssetRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/assets/[sha256]/route.ts";
import * as browserDeckRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/route.ts";
import * as browserPptxRoute from "../../src/app/api/ui/assistant/decks/[conversationId]/versions/[version]/pptx/route.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import {
  ASSET_GRACE_MS,
  assetRef,
  type DeckOutline,
  imageInfo,
  jsonbText,
  KEEP_PPTX,
  KEEP_VERSIONS,
  MAX_ASSET_BYTES,
  MAX_HELD_ASSET_BYTES,
  MAX_OUTLINE_BYTES,
  withSlideIds
} from "../../src/assistant/deck.ts";
import { putDeckAsset, putDeckPptx, readDeck, writeDeck } from "../../src/assistant/deck-store.ts";
import { assistantFrame } from "../../src/assistant/frame.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { devUser, type Person, prisma } from "./database.ts";
import { jsonOf } from "./routes.ts";

/**
 * A conversation's slide deck: the session writes outlines in versions through the agent API, with pictures and each
 * version's .pptx beside them, and the browser reads the pictures and the .pptx back for the owner and for anyone the
 * chat is shared with. Every write applies the retention in its own transaction.
 */

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const assistantActions = await import("../../src/app/_actions/assistant.ts");
const shareActions = await import("../../src/app/_actions/shares.ts");
const forkActions = await import("../../src/app/_actions/forks.ts");
const { assistantConversation, sharedChat } = await import("../../src/web/data.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");
const CAROL = persona("carol");

assistantSuite([ALICE, BOB, CAROL]);

const viewerOf = (who: Person) => ({ ...who, tid: "dev", modelRoute: "own-licence" as const });

interface Chat {
  id: string;
  agentId: string;
  row: { id: string; virtualAgentId: string | null; ownerOid: string };
}

async function chat(): Promise<Chat> {
  actAs("alice");
  await ensureAssistant(prisma, viewerOf(ALICE));
  const started = await assistantActions.startConversation({ product: "general", body: "Make me some slides" });
  const id = (started as { ok: true; id: string }).id;
  const row = await prisma.assistantConversation.findUniqueOrThrow({
    where: { id },
    select: { id: true, agentId: true, virtualAgentId: true, ownerOid: true }
  });
  return { id, agentId: row.agentId!, row: { id, virtualAgentId: row.virtualAgentId, ownerOid: row.ownerOid } };
}

/** A real PNG header of the given size, padded to `length` bytes, so each call can be a distinct picture. */
function png(seed: number, length = 64, width = 640): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(320, 20);
  bytes.writeUInt32BE(seed, 28);
  return bytes;
}

const PPTX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function outline(pictures: string[] = [], title = "Ways of working"): DeckOutline {
  return {
    title,
    slides: [
      { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
      { layout: "HMCTS_CONTENT", title: "What to do", bullets: ["Build", "Test"] },
      ...pictures.map((sha, index) => ({ layout: "HMCTS_IMAGE" as const, title: `Picture ${index}`, image: { asset: assetRef(sha), alt: `Picture ${index}` } }))
    ]
  };
}

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

/** The session's own call, as Alice: the development header stands in for her token. */
async function agent<P>(handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown): Promise<Response> {
  const bytes = body instanceof Uint8Array;
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      "x-dev-user": devUser(ALICE),
      ...(body === undefined ? {} : { "content-type": bytes ? "application/octet-stream" : "application/json" })
    },
    ...(body === undefined ? {} : { body: bytes ? (body as Uint8Array).slice() : JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function browser<P>(
  handler: (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>,
  as: string,
  path: string,
  params: P,
  headers: Record<string, string> = {}
) {
  return await handler(new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: `ah_dev_persona=${as}`, ...headers } }), {
    params: Promise.resolve(params)
  });
}

async function upload(chatOf: Chat, bytes: Buffer, sha = digest(bytes)): Promise<Response> {
  return await agent(assetRoute.PUT, `/api/agent/${chatOf.agentId}/deck/assets/${sha}`, { agentId: chatOf.agentId, sha256: sha }, "PUT", new Uint8Array(bytes));
}

async function store(chatOf: Chat, bytes: Buffer): Promise<string> {
  const sha = digest(bytes);
  expect(await putDeckAsset(prisma, chatOf.id, sha, bytes, imageInfo(bytes)!)).toBe("stored");
  return sha;
}

describe("the deck routes", () => {
  it("should write the deck against its version, give slides ids and keep them, and refuse a stale version", async () => {
    const mine = await chat();
    const route = (method: string, body?: unknown) =>
      agent(method === "GET" ? deckRoute.GET : deckRoute.PUT, `/api/agent/${mine.agentId}/deck`, { agentId: mine.agentId }, method, body);

    expect(await jsonOf(await route("GET"))).toEqual({ title: null, outline: null, version: 0, updated_by: null, updated_at: null, pptx: false });

    const first = await jsonOf(await route("PUT", { outline: outline(), base_version: 0, summary: "First draft" }));
    expect(first.version).toBe(1);
    const [why, given] = first.outline.slides.map((slide: { id: string }) => slide.id);
    expect(why).toBe("why");
    expect(given).toMatch(/^s_[0-9a-f]{4}$/);

    const second = await jsonOf(await route("PUT", { outline: first.outline, base_version: 1 }));
    expect(second.outline.slides.map((slide: { id: string }) => slide.id)).toEqual([why, given]);

    const stale = await route("PUT", { outline: outline(), base_version: 1 });
    expect(stale.status).toBe(409);
    expect((await jsonOf(stale)).current).toMatchObject({ title: "Ways of working", version: 2, updated_by: "agent", pptx: false });

    const read = await jsonOf(await route("GET"));
    expect(read).toMatchObject({ title: "Ways of working", version: 2, updated_by: "agent", outline: second.outline });
    const row = await prisma.assistantDeckVersion.findUniqueOrThrow({ where: { conversationId_version: { conversationId: mine.id, version: 1 } } });
    expect(row).toMatchObject({ by: "agent", summary: "First draft" });
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id }, select: { firstContentAt: true } })).not.toMatchObject({
      firstContentAt: null
    });
  });

  it("should tell the session the deck's version and who wrote it on its frame", async () => {
    const mine = await chat();
    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 0, deck_updated_by: null });

    await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: 0, by: "agent", summary: null });

    expect(await assistantFrame(prisma, mine.agentId)).toMatchObject({ deck_version: 1, deck_updated_by: "agent" });
  });

  it("should refuse an outline the plugin could not build, and one naming a picture the deck does not hold", async () => {
    const mine = await chat();
    const put = (body: unknown) => agent(deckRoute.PUT, `/api/agent/${mine.agentId}/deck`, { agentId: mine.agentId }, "PUT", body);
    const missing = digest(png(9));

    const invalid = await put({ outline: { title: "Deck", slides: [{ layout: "HMCTS_TITLE", title: "No" }] }, base_version: 0 });
    expect(invalid.status).toBe(400);
    expect((await jsonOf(invalid)).error).toMatch(/^outline\.slides\[0\]/);

    const unheld = await put({ outline: outline([missing]), base_version: 0 });
    expect(unheld.status).toBe(400);
    expect(await jsonOf(unheld)).toMatchObject({ missing: [assetRef(missing)] });
    // The refusal rolled the version back with it.
    expect((await readDeck(prisma, mine.id)).version).toBe(0);
  });

  it("should store an outline at exactly the column's limit as Postgres measures it, and refuse one byte more with a 400", async () => {
    const mine = await chat();
    const put = (body: unknown) => agent(deckRoute.PUT, `/api/agent/${mine.agentId}/deck`, { agentId: mine.agentId }, "PUT", body);
    // Slides without ids, so the ids the hub gives them are part of what it measures.
    const sized = (extra: number): DeckOutline => ({
      title: "Deck",
      notes: "x".repeat(extra),
      slides: Array.from({ length: 20 }, (_, index) => ({ layout: "HMCTS_SECTION" as const, title: `Part ${index}`, notes: "n".repeat(9800) }))
    });
    const measured = (value: DeckOutline) => Buffer.byteLength(jsonbText(withSlideIds(value)) ?? "");
    const fits = MAX_OUTLINE_BYTES - measured(sized(0));

    const over = await put({ outline: sized(fits + 1), base_version: 0 });
    expect(over.status).toBe(400);
    expect((await jsonOf(over)).error).toBe(`the outline is larger than ${MAX_OUTLINE_BYTES} bytes`);

    const exact = await put({ outline: sized(fits), base_version: 0 });
    expect(exact.status).toBe(200);
    const [row] = await prisma.$queryRaw<{ bytes: number; text: string; outline: DeckOutline }[]>`
      SELECT octet_length(outline::text) AS bytes, outline::text AS text, outline FROM assistant_deck_version WHERE conversation_id = ${mine.id}::uuid
    `;
    expect(row?.bytes).toBe(MAX_OUTLINE_BYTES);
    expect(jsonbText(row?.outline)).toBe(row?.text);

    const nul = await put({ outline: { ...outline(), notes: "a\u0000b" }, base_version: 1 });
    expect(nul.status).toBe(400);
  });

  it("should answer 404 for the deck of an agent that is not a conversation's", async () => {
    const mine = await chat();
    const other = await prisma.agent.create({ data: { ownerOid: ALICE.oid, sessionId: "laptop-session", name: "laptop" }, select: { id: true } });

    expect((await agent(deckRoute.GET, `/api/agent/${other.id}/deck`, { agentId: other.id })).status).toBe(404);
    expect(mine.id).toBeDefined();
  });

  it("should store a picture under its digest once, read it back typed as what it is, and refuse what is not one", async () => {
    const mine = await chat();
    const picture = png(1);

    expect((await upload(mine, picture)).status).toBe(201);
    const again = await upload(mine, picture);
    expect(again.status).toBe(200);
    expect(await jsonOf(again)).toEqual({ asset: assetRef(digest(picture)) });

    const read = await agent(assetRoute.GET, `/api/agent/${mine.agentId}/deck/assets/${digest(picture)}`, { agentId: mine.agentId, sha256: digest(picture) });
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(picture);

    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect((await upload(mine, svg)).status).toBe(400);
    expect((await upload(mine, png(2), digest(png(3)))).status).toBe(400);
    expect((await upload(mine, png(2), "NOT-A-DIGEST")).status).toBe(400);
    const huge = await upload(mine, png(6, 64, 2 ** 31));
    expect(huge.status).toBe(400);
    expect((await jsonOf(huge)).error).toBe("that is not a PNG, JPEG or GIF of 1 to 65535 pixels each way");
    const absent = digest(png(4));
    expect((await agent(assetRoute.GET, `/api/agent/${mine.agentId}/deck/assets/${absent}`, { agentId: mine.agentId, sha256: absent })).status).toBe(404);
  });

  it("should refuse a picture over 5 MiB, and one that would take the pictures a deck is using past 20 MiB", async () => {
    const mine = await chat();

    expect((await upload(mine, png(1, MAX_ASSET_BYTES + 1))).status).toBe(413);
    for (const seed of [1, 2, 3, 4]) {
      expect((await upload(mine, png(seed, MAX_ASSET_BYTES))).status).toBe(201);
    }
    const full = await upload(mine, png(5));
    expect(full.status).toBe(409);
    expect((await jsonOf(full)).error).toMatch(/at most 20971520 bytes of pictures/);
  });

  it("should keep each recent version's .pptx and refuse one for a version too old or not yet written", async () => {
    const mine = await chat();
    const put = (version: string, body: Uint8Array = new Uint8Array(PPTX)) =>
      agent(pptxRoute.PUT, `/api/agent/${mine.agentId}/deck/versions/${version}/pptx`, { agentId: mine.agentId, version }, "PUT", body);
    await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: 0, by: "agent", summary: null });

    expect((await put("2")).status).toBe(404);
    expect((await put("0")).status).toBe(400);
    expect((await put("1", new TextEncoder().encode("not a zip"))).status).toBe(400);
    expect((await put("1")).status).toBe(204);
    expect((await readDeck(prisma, mine.id)).pptx).toBe(true);

    for (let base = 1; base <= KEEP_PPTX; base += 1) {
      await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: base, by: "agent", summary: null });
    }
    expect((await readDeck(prisma, mine.id)).pptx).toBe(false);
    expect((await put("1")).status).toBe(409);
    expect(await putDeckPptx(prisma, mine.row, 2, PPTX)).toBe("stored");
  });
});

describe("the deck's retention", () => {
  it("should keep the latest 100 versions, and the .pptx of the latest 3 only", async () => {
    const mine = await chat();
    for (let base = 0; base < KEEP_VERSIONS + 3; base += 1) {
      await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: base, by: "agent", summary: null });
      await putDeckPptx(prisma, mine.row, base + 1, PPTX);
    }

    const versions = await prisma.assistantDeckVersion.findMany({
      where: { conversationId: mine.id },
      select: { version: true, pptx: true },
      orderBy: { version: "asc" }
    });
    expect(versions).toHaveLength(KEEP_VERSIONS);
    expect(versions[0]?.version).toBe(4);
    // The newest .pptx is put after the write that prunes, so the three newest hold one and nothing older does.
    expect(versions.filter((row) => row.pptx !== null).map((row) => row.version)).toEqual([101, 102, 103]);
  });

  it("should delete a picture no kept version names once its grace has passed, and keep a fresh one", async () => {
    const mine = await chat();
    const old = await store(mine, png(1));
    await writeDeck(prisma, mine.row, { outline: outline([old]), baseVersion: 0, by: "agent", summary: null });
    const fresh = await store(mine, png(2));
    const later = new Date(Date.now() + ASSET_GRACE_MS + 60_000);
    await prisma.assistantDeckAsset.update({ where: { conversationId_sha256: { conversationId: mine.id, sha256: fresh } }, data: { createdAt: later } });

    // Still named by version 1, which is kept, so nothing goes.
    await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: 1, by: "agent", summary: null }, later);
    expect((await prisma.assistantDeckAsset.findMany({ where: { conversationId: mine.id } })).length).toBe(2);

    // Once version 1 is pruned, no kept version names `old`, and its grace is long over.
    await prisma.assistantDeckVersion.delete({ where: { conversationId_version: { conversationId: mine.id, version: 1 } } });
    await writeDeck(prisma, mine.row, { outline: outline(), baseVersion: 2, by: "agent", summary: null }, later);

    const left = await prisma.assistantDeckAsset.findMany({ where: { conversationId: mine.id }, select: { sha256: true } });
    expect(left.map((asset) => asset.sha256)).toEqual([fresh]);
  });

  it("should take a replacement picture at the cap once the latest version no longer names the one it replaces", async () => {
    const mine = await chat();
    const pictures = [1, 2, 3, 4].map((seed) => png(seed, MAX_ASSET_BYTES));
    const shas = pictures.map(digest);
    for (const picture of pictures) {
      expect((await upload(mine, picture)).status).toBe(201);
    }
    await writeDeck(prisma, mine.row, { outline: outline(shas), baseVersion: 0, by: "agent", summary: null });
    // Past their grace, so only being named counts them.
    await prisma.assistantDeckAsset.updateMany({ where: { conversationId: mine.id }, data: { createdAt: new Date(Date.now() - ASSET_GRACE_MS - 60_000) } });

    // At the cap, a fifth picture is refused while the latest version names all four.
    const replacement = png(5, MAX_ASSET_BYTES);
    expect((await upload(mine, replacement)).status).toBe(409);

    // A version without the fourth leaves its bytes held, for version 1, but not counted.
    await writeDeck(prisma, mine.row, { outline: outline(shas.slice(0, 3)), baseVersion: 1, by: "agent", summary: null });
    expect((await upload(mine, replacement)).status).toBe(201);
    await writeDeck(prisma, mine.row, { outline: outline([...shas.slice(0, 3), digest(replacement)]), baseVersion: 2, by: "agent", summary: null });

    expect(await prisma.assistantDeckAsset.count({ where: { conversationId: mine.id } })).toBe(5);
    expect(await prisma.assistantDeckVersion.count({ where: { conversationId: mine.id } })).toBe(3);
  });

  it("should drop the oldest versions, never the newest 3, and then their pictures, when an upload would pass the conversation's ceiling", async () => {
    const mine = await chat();
    const pictures = MAX_HELD_ASSET_BYTES / MAX_ASSET_BYTES;
    const long = new Date(Date.now() - ASSET_GRACE_MS - 60_000);
    // Each version names one picture of its own, so every picture is held by one version and counted by none but the latest.
    for (let seed = 1; seed <= pictures; seed += 1) {
      const sha = await store(mine, png(seed, MAX_ASSET_BYTES));
      await writeDeck(prisma, mine.row, { outline: outline([sha]), baseVersion: seed - 1, by: "agent", summary: null });
      await prisma.assistantDeckAsset.update({ where: { conversationId_sha256: { conversationId: mine.id, sha256: sha } }, data: { createdAt: long } });
    }
    const first = digest(png(1, MAX_ASSET_BYTES));
    const latest = digest(png(pictures, MAX_ASSET_BYTES));
    expect(await prisma.assistantDeckAsset.count({ where: { conversationId: mine.id } })).toBe(pictures);

    // One more picture: version 1 and its picture go to make room for it.
    expect((await upload(mine, png(100, MAX_ASSET_BYTES))).status).toBe(201);
    const versions = await prisma.assistantDeckVersion.findMany({ where: { conversationId: mine.id }, select: { version: true }, orderBy: { version: "asc" } });
    expect(versions.map((row) => row.version)).toEqual(Array.from({ length: pictures - 1 }, (_, index) => index + 2));
    const held = await prisma.assistantDeckAsset.findMany({ where: { conversationId: mine.id }, select: { sha256: true } });
    expect(held.map((asset) => asset.sha256)).not.toContain(first);
    expect(held.map((asset) => asset.sha256)).toContain(latest);
    expect(held).toHaveLength(pictures);

    // Each upload past the ceiling drops one more of the oldest, and the latest stays. Fresh pictures are counted by
    // the 20 MiB rule, which refuses the third.
    expect((await upload(mine, png(101, MAX_ASSET_BYTES))).status).toBe(201);
    expect((await upload(mine, png(102, MAX_ASSET_BYTES))).status).toBe(201);
    const left = await prisma.assistantDeckVersion.findMany({ where: { conversationId: mine.id }, select: { version: true }, orderBy: { version: "asc" } });
    expect(left.map((row) => row.version)).toEqual(Array.from({ length: pictures - 3 }, (_, index) => index + 4));
    expect((await upload(mine, png(103, MAX_ASSET_BYTES))).status).toBe(409);
    expect((await readDeck(prisma, mine.id)).version).toBe(pictures);
  });

  it("should refuse a picture with a 409 naming the ceiling, deleting nothing, when only the newest 3 versions could make room", async () => {
    const mine = await chat();
    const long = new Date(Date.now() - ASSET_GRACE_MS - 60_000);
    // Twelve pictures past their grace, 60 MiB in all, named 4, 5 and 3 by the only three versions.
    const shas: string[] = [];
    for (let seed = 1; seed <= MAX_HELD_ASSET_BYTES / MAX_ASSET_BYTES; seed += 1) {
      const bytes = png(seed, MAX_ASSET_BYTES);
      await prisma.assistantDeckAsset.create({
        data: { conversationId: mine.id, sha256: digest(bytes), mime: "image/png", bytes: new Uint8Array(bytes), width: 640, height: 320, createdAt: long }
      });
      shas.push(digest(bytes));
    }
    await writeDeck(prisma, mine.row, { outline: outline(shas.slice(0, 4)), baseVersion: 0, by: "agent", summary: null }, long);
    await writeDeck(prisma, mine.row, { outline: outline(shas.slice(4, 9)), baseVersion: 1, by: "agent", summary: null }, long);
    await writeDeck(prisma, mine.row, { outline: outline(shas.slice(9)), baseVersion: 2, by: "agent", summary: null }, long);

    // The latest names 15 MiB, so the 20 MiB rule lets a fifth in; only the 60 MiB one refuses it.
    const refused = await upload(mine, png(100, MAX_ASSET_BYTES));

    expect(refused.status).toBe(409);
    expect((await jsonOf(refused)).error).toBe(
      `a conversation holds at most ${MAX_HELD_ASSET_BYTES} bytes of pictures, and the latest ${KEEP_PPTX} versions, which are never deleted to make room, name too many to take this one`
    );
    const versions = await prisma.assistantDeckVersion.findMany({ where: { conversationId: mine.id }, select: { version: true }, orderBy: { version: "asc" } });
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(await prisma.assistantDeckAsset.count({ where: { conversationId: mine.id } })).toBe(shas.length);

    // A fourth version, naming nothing new, lets version 1 go, and with it the room the picture needs.
    await writeDeck(prisma, mine.row, { outline: outline(shas.slice(9)), baseVersion: 3, by: "agent", summary: null }, long);
    expect((await upload(mine, png(100, MAX_ASSET_BYTES))).status).toBe(201);
    const left = await prisma.assistantDeckVersion.findMany({ where: { conversationId: mine.id }, select: { version: true }, orderBy: { version: "asc" } });
    expect(left.map((row) => row.version)).toEqual([2, 3, 4]);
  });

  it("should take the deck's versions and pictures with the conversation when it is deleted", async () => {
    const mine = await chat();
    const sha = await store(mine, png(1));
    await writeDeck(prisma, mine.row, { outline: outline([sha]), baseVersion: 0, by: "agent", summary: null });

    expect(await assistantActions.deleteConversation({ conversationId: mine.id })).toEqual({ ok: true });

    expect(await prisma.assistantDeckVersion.count({ where: { conversationId: mine.id } })).toBe(0);
    expect(await prisma.assistantDeckAsset.count({ where: { conversationId: mine.id } })).toBe(0);
  });
});

describe("reading a deck in the browser", () => {
  async function deckWithPicture(): Promise<{ mine: Chat; sha: string }> {
    const mine = await chat();
    const sha = await store(mine, png(1));
    await writeDeck(prisma, mine.row, { outline: outline([sha], 'Plan: "Q4"/é'), baseVersion: 0, by: "agent", summary: null });
    await putDeckPptx(prisma, mine.row, 1, PPTX);
    return { mine, sha };
  }

  const picture = (as: string, id: string, sha: string, headers: Record<string, string> = {}) =>
    browser(browserAssetRoute.GET, as, `/api/ui/assistant/decks/${id}/assets/${sha}`, { conversationId: id, sha256: sha }, headers);
  const outlineOf = (as: string, id: string) => browser(browserDeckRoute.GET, as, `/api/ui/assistant/decks/${id}`, { conversationId: id });
  const download = (as: string, id: string, version = "1") =>
    browser(browserPptxRoute.GET, as, `/api/ui/assistant/decks/${id}/versions/${version}/pptx`, { conversationId: id, version });

  it("should give the owner the deck's pictures to revalidate on every use, and its .pptx to download under the deck's title", async () => {
    const { mine, sha } = await deckWithPicture();

    const read = await picture("alice", mine.id, sha);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-cache");
    expect(read.headers.get("etag")).toBe(`"${sha}"`);
    expect(read.headers.get("content-type")).toBe("image/png");

    const file = await download("alice", mine.id);
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe("no-store");
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="Plan Q4 _.pptx"; filename*=UTF-8''${encodeURIComponent("Plan Q4 é.pptx")}`);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PPTX);
    expect((await download("alice", mine.id, "2")).status).toBe(404);
    expect((await download("alice", mine.id, "latest")).status).toBe(404);
  });

  it("should encode every character RFC 5987 does not allow in the download's filename*", async () => {
    const mine = await chat();
    await writeDeck(prisma, mine.row, { outline: outline([], "Team's plan (draft)"), baseVersion: 0, by: "agent", summary: null });
    await putDeckPptx(prisma, mine.row, 1, PPTX);

    const file = await download("alice", mine.id);

    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="Team's plan (draft).pptx"; filename*=UTF-8''Team%27s%20plan%20%28draft%29.pptx`
    );
  });

  it("should download the .pptx, with the emoji left out whole, when the deck's title has one straddling the filename's limit", async () => {
    const mine = await chat();
    await writeDeck(prisma, mine.row, { outline: outline([], `${"a".repeat(79)}😀 plan`), baseVersion: 0, by: "agent", summary: null });
    await putDeckPptx(prisma, mine.row, 1, PPTX);

    const file = await download("alice", mine.id);

    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe(`attachment; filename="${"a".repeat(79)}.pptx"; filename*=UTF-8''${"a".repeat(79)}.pptx`);
  });

  it("should give the owner, and anyone the chat is shared with, the latest outline with its pictures' sizes, never to be cached", async () => {
    const { mine, sha } = await deckWithPicture();

    const own = await outlineOf("alice", mine.id);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    const read = await jsonOf(own);
    expect(read).toMatchObject({ title: 'Plan: "Q4"/é', version: 1, updatedBy: "agent", pptx: true, sizes: { [sha]: { width: 640, height: 320 } } });
    expect(read.outline.slides).toHaveLength(3);

    expect((await outlineOf("bob", mine.id)).status).toBe(404);
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    expect((await outlineOf("bob", mine.id)).status).toBe(200);

    const empty = await chat();
    expect((await outlineOf("alice", empty.id)).status).toBe(404);
  });

  it("should answer 304 with no bytes to a revalidation the viewer may still read, and 404 once the share is taken away", async () => {
    const { mine, sha } = await deckWithPicture();
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    const held = { "if-none-match": `W/"${digest(png(9))}", "${sha}"` };

    const own = await picture("alice", mine.id, sha, held);
    expect(own.status).toBe(304);
    expect(own.headers.get("cache-control")).toBe("private, no-cache");
    expect((await own.arrayBuffer()).byteLength).toBe(0);
    expect((await picture("bob", mine.id, sha, held)).status).toBe(304);
    expect((await picture("bob", mine.id, sha, { "if-none-match": `"${digest(png(9))}"` })).status).toBe(200);
    expect((await picture("carol", mine.id, sha, held)).status).toBe(404);

    actAs("alice");
    await shareActions.unshareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    expect((await picture("bob", mine.id, sha, held)).status).toBe(404);
    expect((await picture("bob", mine.id, sha, { "if-none-match": "*" })).status).toBe(404);
    const gone = digest(png(8));
    expect((await picture("alice", mine.id, gone, { "if-none-match": `"${gone}"` })).status).toBe(404);
  });

  it("should refuse someone the chat is not shared with, and serve someone it is until the share is taken away", async () => {
    const { mine, sha } = await deckWithPicture();

    expect((await picture("bob", mine.id, sha)).status).toBe(404);
    expect((await download("bob", mine.id)).status).toBe(404);

    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    expect((await picture("bob", mine.id, sha)).status).toBe(200);
    expect((await download("bob", mine.id)).status).toBe(200);
    expect((await picture("carol", mine.id, sha)).status).toBe(404);

    actAs("alice");
    await shareActions.unshareChat({ conversationId: mine.id, recipientOid: BOB.oid });
    expect((await picture("bob", mine.id, sha)).status).toBe(404);
  });

  it("should carry the deck's version, without its outline, on the owner's page and on the share page", async () => {
    const { mine, sha } = await deckWithPicture();
    actAs("alice");
    await shareActions.shareChat({ conversationId: mine.id, recipientOid: CAROL.oid });

    const own = await assistantConversation(viewerOf(ALICE), mine.id);
    // The version and no more: the panel reads the outline itself.
    expect(own?.deck).toEqual({ title: 'Plan: "Q4"/é', version: 1, updatedBy: "agent", pptx: true });
    expect(sha).toBeDefined();

    const shared = await sharedChat(viewerOf(CAROL), mine.id);
    expect(shared?.deck).toEqual({ title: 'Plan: "Q4"/é', version: 1, updatedBy: "agent", pptx: true });
  });
});

describe("forking a chat with a deck", () => {
  it("should give the copy the source's latest deck as its version 1, said to be the person's, with its pictures and .pptx", async () => {
    const mine = await chat();
    const named = await store(mine, png(1));
    const unnamed = await store(mine, png(2));
    await writeDeck(prisma, mine.row, { outline: outline([unnamed]), baseVersion: 0, by: "agent", summary: null });
    const latest = await writeDeck(prisma, mine.row, { outline: outline([named], "Final deck"), baseVersion: 1, by: "agent", summary: "Final" });
    await putDeckPptx(prisma, mine.row, 2, PPTX);
    await forkActions.offerChatFork({ conversationId: mine.id, recipientOid: BOB.oid });

    actAs("bob");
    const taken = await forkActions.forkChat({ conversationId: mine.id });
    const copy = (taken as { ok: true; id: string }).id;

    const deck = await readDeck(prisma, copy);
    expect(deck).toMatchObject({ title: "Final deck", version: 1, updatedBy: "user", pptx: true, outline: latest.outline });
    const assets = await prisma.assistantDeckAsset.findMany({ where: { conversationId: copy }, select: { sha256: true } });
    expect(assets.map((asset) => asset.sha256)).toEqual([named]);
    const copyAgent = (await prisma.assistantConversation.findUniqueOrThrow({ where: { id: copy }, select: { agentId: true } })).agentId!;
    expect(await assistantFrame(prisma, copyAgent)).toMatchObject({ deck_version: 1, deck_updated_by: "user" });
  });

  it("should give the copy no deck when the source has none", async () => {
    const mine = await chat();
    await forkActions.offerChatFork({ conversationId: mine.id, recipientOid: BOB.oid });

    actAs("bob");
    const taken = await forkActions.forkChat({ conversationId: mine.id });

    expect((await readDeck(prisma, (taken as { ok: true; id: string }).id)).version).toBe(0);
  });
});
