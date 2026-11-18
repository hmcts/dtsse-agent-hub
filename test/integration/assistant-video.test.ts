import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as completeRoute from "../../src/app/api/agent/[agentId]/video/[videoId]/complete/route.ts";
import * as postedRoute from "../../src/app/api/agent/[agentId]/video/[videoId]/posted/route.ts";
import * as videoRoute from "../../src/app/api/agent/[agentId]/video/route.ts";
import { shareConversation } from "../../src/assistant/shares.ts";
import { sharedConversation } from "../../src/assistant/sharing.ts";
import { videoPath } from "../../src/assistant/video.ts";
import { hasReadyVideo, MAX_OPEN_UPLOADS, sweepVideos } from "../../src/assistant/video-store.ts";
import { conversationView } from "../../src/assistant/views.ts";
import { readableCaptions, readableVideo, videoAccess } from "../../src/web/data.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { devUser, prisma } from "./database.ts";
import { ALICE, BOB, CAROL, type Chat, chat, viewerOf } from "./deck-chats.ts";
import { jsonOf } from "./routes.ts";

/**
 * A conversation's journey video: the session records an upload through the agent API and puts the MP4 to Azurite by
 * the URL it is given, and the hub makes it the conversation's video once the blob is there at the declared size.
 */

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

/**
 * Blob Storage in memory, as the video routes, the page reads and the sweep see it through `videoBlobs()`: CI has no
 * Azurite. A URL names its blob by path, and `put` is the pod's PUT to one.
 */
const storage = vi.hoisted(() => {
  const blobs = new Map<string, { bytes: Buffer; etag: string }>();
  let writes = 0;
  const pathOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
  return {
    blobs,
    pathOf,
    put(url: string, bytes: Buffer) {
      writes += 1;
      blobs.set(pathOf(url), { bytes, etag: `"etag-${writes}"` });
    },
    fake: {
      uploadUrl: async (path: string) => `https://blobs.test/${path}?sp=cw`,
      readUrl: async (path: string) => `https://blobs.test/${path}?sp=r`,
      putBlob: async (path: string, bytes: Uint8Array, _contentType?: string) => {
        writes += 1;
        blobs.set(path, { bytes: Buffer.from(bytes), etag: `"etag-${writes}"` });
      },
      statOf: async (path: string) => {
        const found = blobs.get(path);
        return found === undefined ? undefined : { size: found.bytes.length, etag: found.etag };
      },
      sizeOf: async (path: string) => blobs.get(path)?.bytes.length,
      listNames: async (prefix: string) => [...blobs.keys()].filter((name) => name.startsWith(prefix)),
      deleteBlobs: async (paths: readonly string[]) => {
        for (const path of paths) {
          blobs.delete(path);
        }
        return [];
      },
      deletePrefix: async (prefix: string) => {
        const names = [...blobs.keys()].filter((name) => name.startsWith(prefix));
        for (const name of names) {
          blobs.delete(name);
        }
        return names.length;
      }
    }
  };
});

vi.mock("../../src/assistant/video-blob.ts", () => ({ videoBlobs: () => storage.fake }));

assistantSuite([ALICE, BOB, CAROL]);

beforeEach(() => {
  storage.blobs.clear();
});

const MP4 = Buffer.from("pretend this is an mp4");

const begin = (overrides: Record<string, unknown> = {}) => ({
  name: "pcs-journey",
  bytes: MP4.length,
  captions: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n",
  chapters: [
    { at: 0, title: "Sign in" },
    { at: 65, title: "Submit" }
  ],
  coverage: "# Coverage\n\n2 of 3 stories and 7 ACs are shown.\n",
  coverage_summary: "2 of 3 stories and 7 ACs are shown.",
  content_mismatches: "# Mismatches\n",
  jira_key: "HDPI-1234",
  ...overrides
});

function request(method: string, of: Chat, path: string, body?: unknown): Request {
  return new Request(`http://localhost:3000/api/agent/${of.agentId}/video${path}`, {
    method,
    headers: { "x-dev-user": devUser(ALICE), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function started(of: Chat, overrides: Record<string, unknown> = {}): Promise<{ video_id: string; upload_url: string }> {
  const response = await videoRoute.POST(request("POST", of, "", begin(overrides)), { params: Promise.resolve({ agentId: of.agentId }) });
  expect(response.status).toBe(200);
  return (await jsonOf(response)) as { video_id: string; upload_url: string };
}

/** The pod's PUT to a write URL. */
async function putBytes(url: string, bytes: Buffer): Promise<void> {
  storage.put(url, bytes);
}

const complete = (of: Chat, videoId: string) =>
  completeRoute.POST(request("POST", of, `/${videoId}/complete`, {}), { params: Promise.resolve({ agentId: of.agentId, videoId }) });

async function published(of: Chat, overrides: Record<string, unknown> = {}, bytes = MP4): Promise<string> {
  const { video_id, upload_url } = await started(of, { bytes: bytes.length, ...overrides });
  await putBytes(upload_url, bytes);
  expect((await complete(of, video_id)).status).toBe(200);
  return video_id;
}

describe("publishing a video", () => {
  it("should make the upload the conversation's video and serve it when the blob is there at its size", async () => {
    const mine = await chat();

    const { video_id, upload_url } = await started(mine);
    expect(await readableVideo(viewerOf(ALICE), mine.id)).toBeUndefined();
    expect(await jsonOf(await complete(mine, video_id))).toEqual({ error: "the video has not been put to the upload URL yet" });
    await putBytes(upload_url, Buffer.from("short"));
    expect((await jsonOf(await complete(mine, video_id))) as { error: string }).toMatchObject({
      error: expect.stringMatching(/is 5 bytes and the upload declared/)
    });
    await putBytes(upload_url, MP4);
    expect(await jsonOf(await complete(mine, video_id))).toEqual({ video_id });
    expect(await jsonOf(await complete(mine, video_id))).toEqual({ video_id });

    const read = await readableVideo(viewerOf(ALICE), mine.id);
    expect(read).toMatchObject({
      video_id,
      name: "pcs-journey",
      bytes: MP4.length,
      has_captions: true,
      chapters: [
        { at: 0, title: "Sign in" },
        { at: 65, title: "Submit" }
      ],
      coverage_summary: "2 of 3 stories and 7 ACs are shown.",
      jira_key: "HDPI-1234",
      posted: null
    });
    expect(storage.blobs.get(storage.pathOf(read!.play_url))?.bytes.equals(MP4)).toBe(true);
    expect(await readableCaptions(viewerOf(ALICE), mine.id)).toMatch(/^WEBVTT/);

    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row).toMatchObject({ videoVersion: 1, videoName: "pcs-journey" });
    expect(row.firstContentAt).not.toBeNull();
    expect(await hasReadyVideo(prisma, mine.id, video_id)).toBe(true);
  });

  it("should replace the video and delete the old blob when the next one is published", async () => {
    const mine = await chat();
    const first = await published(mine);
    const second = await published(mine, { name: "second" }, Buffer.from("a second recording"));

    const got = await videoRoute.GET(request("GET", mine, ""), { params: Promise.resolve({ agentId: mine.agentId }) });
    const body = (await jsonOf(got)) as { video_id: string; download_url: string };
    expect(body.video_id).toBe(second);
    expect(storage.blobs.get(storage.pathOf(body.download_url))?.bytes.toString()).toBe("a second recording");
    const blobs = storage.fake;
    expect(await blobs.sizeOf(videoPath(mine.id, first))).toBeUndefined();
    expect(await prisma.assistantVideo.count({ where: { conversationId: mine.id } })).toBe(1);
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } })).videoVersion).toBe(2);
  });

  it("should refuse a body the hub cannot store, and refuse an upload when the conversation has too many open", async () => {
    const mine = await chat();

    const bad = await videoRoute.POST(request("POST", mine, "", begin({ chapters: "none" })), { params: Promise.resolve({ agentId: mine.agentId }) });
    expect(bad.status).toBe(400);
    for (let i = 0; i < MAX_OPEN_UPLOADS; i += 1) {
      await started(mine);
    }
    const tooMany = await videoRoute.POST(request("POST", mine, "", begin()), { params: Promise.resolve({ agentId: mine.agentId }) });
    expect(tooMany.status).toBe(429);
    const none = await videoRoute.GET(request("GET", await chat(), ""), { params: Promise.resolve({ agentId: (await chat()).agentId }) });
    expect(none.status).toBe(404);
  });

  it("should serve nothing, when the blob is written again with the upload URL after the upload finished", async () => {
    const mine = await chat();
    const { video_id, upload_url } = await started(mine);
    await putBytes(upload_url, MP4);
    expect((await complete(mine, video_id)).status).toBe(200);
    expect(await readableVideo(viewerOf(ALICE), mine.id)).toMatchObject({ video_id });

    await putBytes(upload_url, Buffer.from("something else entirely"));

    expect(await readableVideo(viewerOf(ALICE), mine.id)).toBeUndefined();
    const got = await videoRoute.GET(request("GET", mine, ""), { params: Promise.resolve({ agentId: mine.agentId }) });
    expect(got.status).toBe(404);
  });

  it("should record where the video was posted, and show it on the conversation's page", async () => {
    const mine = await chat();
    const id = await published(mine);

    const response = await postedRoute.POST(request("POST", mine, `/${id}/posted`, { issue_key: "HDPI-99" }), {
      params: Promise.resolve({ agentId: mine.agentId, videoId: id })
    });
    expect(response.status).toBe(204);
    expect((await readableVideo(viewerOf(ALICE), mine.id))?.posted).toMatchObject({ key: "HDPI-99", url: "https://hmcts.atlassian.net/browse/HDPI-99" });
    const stranger = await postedRoute.POST(request("POST", mine, `/${randomUUID()}/posted`, { issue_key: "HDPI-99" }), {
      params: Promise.resolve({ agentId: mine.agentId, videoId: randomUUID() })
    });
    expect(stranger.status).toBe(404);

    const row = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: mine.id } });
    expect((await conversationView(prisma, row as never, mine.agentId)).canPostVideo).toBe(true);
    expect((await conversationView(prisma, row as never, mine.agentId)).video).toMatchObject({ name: "pcs-journey", version: 1 });
    expect((await sharedConversation(prisma, row as never, "reader"))?.video).toMatchObject({ name: "pcs-journey", version: 1 });
  });
});

describe("who may watch", () => {
  it("should let a share's recipient watch and nobody else when the video is shared", async () => {
    const mine = await chat();
    await published(mine);
    await shareConversation(prisma, ALICE.oid, mine.id, BOB.oid);

    expect(await videoAccess(viewerOf(ALICE), mine.id)).toBe("owner");
    expect(await videoAccess(viewerOf(CAROL), mine.id)).toBeUndefined();
    expect(await readableVideo(viewerOf(CAROL), mine.id)).toBeUndefined();
    expect(await readableCaptions(viewerOf(CAROL), mine.id)).toBeUndefined();
    expect(await videoAccess(viewerOf(BOB), mine.id)).toBe("reader");
    expect(await readableVideo(viewerOf(BOB), mine.id)).toMatchObject({ name: "pcs-journey" });
  });
});

describe("deleting and sweeping", () => {
  it("should delete a conversation's blobs when the conversation is deleted", async () => {
    const mine = await chat();
    const id = await published(mine);
    const blobs = storage.fake;
    expect(await blobs.sizeOf(videoPath(mine.id, id))).toBe(MP4.length);

    const { actAs } = await import("./web-session.ts");
    actAs("alice");
    const actions = await import("../../src/app/_actions/assistant.ts");
    expect(await actions.deleteConversation({ conversationId: mine.id })).toEqual({ ok: true });

    expect(await blobs.sizeOf(videoPath(mine.id, id))).toBeUndefined();
    expect(await prisma.assistantVideo.count({ where: { videoId: id } })).toBe(0);
  });

  it("should delete unfinished uploads and unnamed blobs and keep what a row names when the sweep runs", async () => {
    const mine = await chat();
    const kept = await published(mine);
    const stale = await started(mine);
    await putBytes(stale.upload_url, MP4);
    await prisma.assistantVideo.update({ where: { videoId: stale.video_id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
    const fresh = await started(mine);
    await putBytes(fresh.upload_url, MP4);
    const blobs = storage.fake;
    const orphan = videoPath(randomUUID(), randomUUID());
    await blobs.putBlob(orphan, MP4, "video/mp4");
    await blobs.putBlob("not-ours/thing.txt", MP4, "text/plain");

    const result = await sweepVideos(prisma, blobs);

    expect(result?.stale).toBe(1);
    expect(result?.orphans).toBe(1);
    expect(await blobs.sizeOf(orphan)).toBeUndefined();
    expect(await blobs.sizeOf(videoPath(mine.id, stale.video_id))).toBeUndefined();
    expect(await blobs.sizeOf(videoPath(mine.id, kept))).toBe(MP4.length);
    expect(await blobs.sizeOf(videoPath(mine.id, fresh.video_id))).toBe(MP4.length);
    expect(await blobs.sizeOf("not-ours/thing.txt")).toBe(MP4.length);
    expect(await prisma.assistantVideo.count({ where: { videoId: stale.video_id } })).toBe(0);
  });
});
