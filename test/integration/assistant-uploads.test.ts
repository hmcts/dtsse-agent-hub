// Files attached to an HMCTS Assistant message, end to end through Postgres: the browser's parts, the message that
// claims them, the frame that names them, the pod's fetch, and the sweep that is the backstop for all of it.
//
// The two assertions in "the hub's memory" are the point of the transport's design and not a formality: every byte of
// an upload crosses a heap capped at 768 MB on two replicas, so one part at a time has to be measured rather than
// reasoned about. Both measure the bytes the hub pulled from a client's body, which is the route's own behaviour,
// rather than `process.memoryUsage()`, which is the whole worker's and moves with everything else sharing it.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { assistantEnvelope, type EnvelopeMessage, fetchAttachments, type PodApi, parseAssistantFrame, parseAttachments } from "pod-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as attachmentFetchedRoute from "../../src/app/api/agent/[agentId]/attachments/[uploadId]/fetched/route.ts";
import * as attachmentPartRoute from "../../src/app/api/agent/[agentId]/attachments/[uploadId]/parts/[index]/route.ts";
import * as streamRoute from "../../src/app/api/agent/[agentId]/stream/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as contentRoute from "../../src/app/api/ui/uploads/[uploadId]/content/route.ts";
import * as partRoute from "../../src/app/api/ui/uploads/[uploadId]/parts/[index]/route.ts";
import * as discardRoute from "../../src/app/api/ui/uploads/[uploadId]/route.ts";
import * as uploadRoute from "../../src/app/api/ui/uploads/route.ts";
import * as conversationsRoute from "../../src/app/api/virtual/[virtualAgentId]/conversations/route.ts";
import { createConversation, ensureAssistant, linkLocalSession } from "../../src/assistant/store.ts";
import { startUploadSweep, sweepUploads } from "../../src/assistant/upload-sweep.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_CONVERSATION_BYTES, MAX_UPLOAD_BYTES, PART_BYTES } from "../../src/assistant/uploads.ts";
import { unsentChat } from "../../src/assistant/views.ts";
import { realtime } from "../../src/realtime/process.ts";
import type { PrismaClient } from "../../src/store/prisma.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { DEV_PERSONA_COOKIE } from "../../src/viewer/identity.ts";
import { type ClaimResult, createVirtualAgent } from "../../src/virtual-agents/store.ts";
import { assistantSuite } from "./assistant-suite.ts";
import { insertUser, type Person, prisma } from "./database.ts";
import { jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";
import { until } from "./waits.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const actions = await import("../../src/app/_actions/assistant.ts");
const { assistantConversation } = await import("../../src/web/data.ts");

const ALICE: Person = { oid: "dev-alice", name: "Dev alice (sign-in disabled)", email: "alice@dev.invalid" };
const BOB: Person = { oid: "dev-bob", name: "Dev bob (sign-in disabled)", email: "bob@dev.invalid" };
const VIEWER = { ...ALICE, tid: "dev", modelRoute: "own-licence" as const };

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

type UiHandler<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response>;

/** `NextRequest` narrows `signal`, so its own init type is what a hand-built request has to be given. */
type NextInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex?: "half" };

/** A `/api/ui/*` call as the browser makes it: the session cookie, and a JSON or raw body. */
async function ui<P>(
  handler: UiHandler<P>,
  {
    path,
    params,
    method = "GET",
    json,
    bytes,
    as = "alice"
  }: { path: string; params?: P; method?: string; json?: unknown; bytes?: Uint8Array<ArrayBuffer>; as?: string }
): Promise<Response> {
  const body = bytes === undefined ? (json === undefined ? undefined : JSON.stringify(json)) : bytes;
  const request = new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      cookie: `${DEV_PERSONA_COOKIE}=${as}`,
      ...(bytes === undefined ? (json === undefined ? {} : { "content-type": "application/json" }) : { "content-type": "application/octet-stream" })
    },
    ...(body === undefined ? {} : { body, duplex: "half" })
  } as NextInit);
  return await handler(request, { params: Promise.resolve((params ?? {}) as P) });
}

async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    signal,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function orchestrator<P>(handler: Handler<P>, path: string, params: P, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "x-dev-orchestrator": "preview-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await handler(request, { params: Promise.resolve(params) });
}

/** The person's assistant, claimed and running, with its pod's launch token. */
async function startedAssistant(): Promise<{ id: string; token: string }> {
  await insertUser(ALICE);
  const assistant = await ensureAssistant(prisma, VIEWER);
  const claim = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, { cluster: "preview-01" });
  const claimed = (await jsonOf<ClaimResult>(claim)).virtual_agents.find((entry) => entry.id === assistant.id)!;
  await orchestrator(
    observedRoute.POST,
    `/api/orchestrator/virtual-agents/${assistant.id}/observed`,
    { id: assistant.id },
    { generation: claimed.generation, replicas_ready: 1, pod_phase: "Running" }
  );
  return { id: assistant.id, token: claimed.launch_token as string };
}

async function sessionOf(conversationId: string): Promise<{ agentId: string; sessionId: string }> {
  const conversation = await prisma.assistantConversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { agent: { select: { id: true, sessionId: true } } }
  });
  return { agentId: conversation.agent!.id, sessionId: conversation.agent!.sessionId };
}

function register(token: string, sessionId: string, conversationId: string): Promise<Response> {
  return pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", { session_id: sessionId, name: "session", conversation_id: conversationId });
}

interface Created {
  uploadId: string;
  partBytes: number;
  parts: number;
}

async function startUpload(conversationId: string, file: { name: string; size: number; mediaType?: string }): Promise<Response> {
  return await ui(uploadRoute.POST, {
    path: "/api/ui/uploads",
    method: "POST",
    json: { conversationId, name: file.name, size: file.size, mediaType: file.mediaType ?? "application/pdf" }
  });
}

async function putPart(uploadId: string, index: number, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  return await ui(partRoute.PUT, {
    path: `/api/ui/uploads/${uploadId}/parts/${index}`,
    params: { uploadId, index: String(index) },
    method: "PUT",
    bytes
  });
}

/** A whole file uploaded as the browser would, in `partBytes` slices, answering the upload id. */
async function upload(conversationId: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const created = await jsonOf<Created>(await startUpload(conversationId, { name, size: bytes.byteLength }));
  for (let index = 0; index < created.parts; index += 1) {
    const slice = bytes.subarray(index * created.partBytes, Math.min(bytes.byteLength, (index + 1) * created.partBytes));
    const response = await putPart(created.uploadId, index, slice);
    if (!response.ok) {
      throw new Error(`part ${index} was refused: ${response.status} ${await response.text()}`);
    }
  }
  return created.uploadId;
}

function filled(length: number, value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(value);
}

assistantSuite([ALICE, BOB]);

describe("uploading a file", () => {
  it("should become stored once every part has arrived, whatever order they arrive in", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const bytes = PART_BYTES + 100;
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "my letter (final).pdf", size: bytes }));

    // Act: the last part first, as a browser uploading in parallel may well do.
    const second = await putPart(created.uploadId, 1, filled(100, 2));
    const first = await putPart(created.uploadId, 0, filled(PART_BYTES, 1));

    // Assert
    expect(created).toEqual({ uploadId: created.uploadId, partBytes: PART_BYTES, parts: 2 });
    expect(await jsonOf(second)).toEqual({ received: 100 });
    expect(await jsonOf(first)).toEqual({ received: bytes });
    const row = await prisma.assistantUpload.findUniqueOrThrow({ where: { id: created.uploadId } });
    expect(row).toMatchObject({ state: "stored", fileName: "my letter (final).pdf", storedName: "my_letter_final_.pdf", bytes: BigInt(bytes) });
    expect(await prisma.assistantUploadPart.count({ where: { uploadId: created.uploadId } })).toBe(2);
  });

  it("should refuse a part larger than the part size, rather than read it into memory", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: PART_BYTES + 100 }));

    // Act
    const response = await putPart(created.uploadId, 0, filled(PART_BYTES + 1, 9));

    // Assert
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toEqual({ reason: "part_too_big", error: `this part of the file is larger than ${PART_BYTES} bytes` });
    expect(await prisma.assistantUploadPart.count({ where: { uploadId: created.uploadId } })).toBe(0);
  });

  it("should refuse a part shorter than the part size, since a short part would leave a hole in the file", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: PART_BYTES + 100 }));

    // Act
    const response = await putPart(created.uploadId, 0, filled(10, 9));

    // Assert
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toEqual({ reason: "part_wrong_length", error: `part 0 of this file is ${PART_BYTES} bytes` });
  });

  it("should refuse a part number past the end of the file", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: 10 }));

    // Act
    const response = await putPart(created.uploadId, 1, filled(10, 9));

    // Assert
    expect(response.status).toBe(404);
  });

  it("should replace a part sent twice, so a client that retries after a lost response has no gap", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: 4 }));

    // Act
    await putPart(created.uploadId, 0, filled(4, 1));
    const again = await putPart(created.uploadId, 0, filled(4, 2));

    // Assert
    expect(await jsonOf(again)).toEqual({ received: 4 });
    expect(await prisma.assistantUploadPart.count({ where: { uploadId: created.uploadId } })).toBe(1);
  });

  it("should refuse a file bigger than the cap, an empty one and a size that is not a whole number", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });

    // Act & Assert
    for (const size of [0, MAX_UPLOAD_BYTES + 1, 1.5, "10"]) {
      const response = await startUpload(conversation.id, { name: "a.pdf", size: size as number });
      expect(response.status, `size ${size}`).toBe(400);
    }
    expect((await startUpload(conversation.id, { name: "a.pdf", size: MAX_UPLOAD_BYTES })).status).toBe(201);
  });

  it("should refuse more files than a message carries, so an abandoned composer cannot fill the database", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    for (let n = 0; n < MAX_ATTACHMENTS_PER_MESSAGE; n += 1) {
      expect((await startUpload(conversation.id, { name: `a${n}.pdf`, size: 4 })).status).toBe(201);
    }

    // Act
    const response = await startUpload(conversation.id, { name: "one-too-many.pdf", size: 4 });

    // Assert
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toEqual({ reason: "too_many_files", error: `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files` });
  });

  it("should refuse a file that would take the conversation past its total", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    // Already fetched by the pod, and still counted: those bytes are on the pod's disk, which is the thing the total
    // is protecting. The per-file cap means this takes several rows.
    const full = Math.floor(MAX_CONVERSATION_BYTES / MAX_UPLOAD_BYTES);
    for (let n = 0; n < full; n += 1) {
      await prisma.assistantUpload.create({
        data: {
          conversationId: conversation.id,
          ownerOid: ALICE.oid,
          fileName: `big-${n}.pdf`,
          storedName: `big-${n}.pdf`,
          mediaType: "application/pdf",
          bytes: BigInt(MAX_UPLOAD_BYTES),
          state: "fetched"
        }
      });
    }

    // Act
    const response = await startUpload(conversation.id, { name: "a.pdf", size: MAX_UPLOAD_BYTES });

    // Assert
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({ error: expect.stringContaining("add up to at most") });
  });

  it("should let only four through when five tabs start an upload at the same moment", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    // Connections opened first: five transactions each waiting on a new connection would be serialised by that wait
    // rather than by the lock, and the test would pass without proving anything.
    await Promise.all([1, 2, 3, 4, 5].map(() => prisma.$queryRaw`SELECT 1`));

    // Act
    const responses = await Promise.all([1, 2, 3, 4, 5].map((n) => startUpload(conversation.id, { name: `a${n}.pdf`, size: 4 })));

    // Assert
    expect(responses.filter((response) => response.status === 201)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(await prisma.assistantUpload.count()).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  it("should refuse a conversation that is not the signed-in person's", async () => {
    // Arrange
    await startedAssistant();
    await insertUser(BOB);
    await createVirtualAgent(prisma, { owner: BOB, modelRoute: "gateway", name: "bobs" });
    const bobs = await createConversation(prisma, BOB.oid, { product: "pcs" });

    // Act
    const response = await startUpload(bobs.id, { name: "a.pdf", size: 4 });

    // Assert
    expect(response.status).toBe(404);
  });

  it("should answer 404 for every upload route on a deployment without virtual agents", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: 4 }));
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    // Act & Assert
    expect((await startUpload(conversation.id, { name: "a.pdf", size: 4 })).status).toBe(404);
    expect((await putPart(created.uploadId, 0, filled(4, 1))).status).toBe(404);
    expect(
      (await ui(discardRoute.DELETE, { path: `/api/ui/uploads/${created.uploadId}`, params: { uploadId: created.uploadId }, method: "DELETE" })).status
    ).toBe(404);
  });

  it("should throw away a discarded upload and its parts", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "a.pdf", filled(4, 1));

    // Act
    const response = await ui(discardRoute.DELETE, { path: `/api/ui/uploads/${uploadId}`, params: { uploadId }, method: "DELETE" });

    // Assert
    expect(response.status).toBe(204);
    expect(await prisma.assistantUpload.count()).toBe(0);
    expect(await prisma.assistantUploadPart.count()).toBe(0);
  });

  it("should treat another person's upload, and one that never existed, alike", async () => {
    // Arrange
    await startedAssistant();
    await insertUser(BOB);
    await createVirtualAgent(prisma, { owner: BOB, modelRoute: "gateway", name: "bobs" });
    const bobs = await createConversation(prisma, BOB.oid, { product: "pcs" });
    const theirs = await prisma.assistantUpload.create({
      data: { conversationId: bobs.id, ownerOid: BOB.oid, fileName: "a.pdf", storedName: "a.pdf", mediaType: "application/pdf", bytes: 4n },
      select: { id: true }
    });

    // Act & Assert
    expect((await putPart(theirs.id, 0, filled(4, 1))).status).toBe(404);
    expect((await putPart("11111111-2222-3333-4444-555555555555", 0, filled(4, 1))).status).toBe(404);
    expect((await putPart("not-a-uuid", 0, filled(4, 1))).status).toBe(404);
  });
});

describe("sending a message with attachments", () => {
  it("should stamp the message on each file and show them in the thread", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const first = await upload(conversation.id, "letter.pdf", filled(6, 1));
    const second = await upload(conversation.id, "scan.png", filled(3, 2));

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "what do these say?", uploadIds: [first, second] });

    // Assert
    expect(result).toMatchObject({ ok: true });
    const sent = (result as { message: { id: string; attachments?: unknown } }).message;
    expect(sent.attachments).toEqual([
      { id: first, name: "letter.pdf", bytes: 6, media_type: "application/pdf", available_until: expect.any(String) },
      { id: second, name: "scan.png", bytes: 3, media_type: "application/pdf", available_until: expect.any(String) }
    ]);
    // The window the chip reads to decide whether it can offer the file back, from the hub rather than the browser.
    const held = (sent.attachments as { available_until: string }[])[0]!.available_until;
    expect(Date.parse(held)).toBeGreaterThan(Date.now());
    expect(await prisma.assistantUpload.findMany({ where: { messageId: BigInt(sent.id) }, select: { id: true } })).toHaveLength(2);
  });

  it("should send nothing at all when one of the files belongs to another conversation", async () => {
    // Arrange
    await startedAssistant();
    const mine = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const other = await createConversation(prisma, ALICE.oid, { product: "ccd" });
    const good = await upload(mine.id, "letter.pdf", filled(6, 1));
    const elsewhere = await upload(other.id, "stray.pdf", filled(6, 2));

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: mine.id, body: "look at these", uploadIds: [good, elsewhere] });

    // Assert
    expect(result).toEqual({ ok: false, error: "one of those files is not ready to send; remove it and attach it again" });
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.assistantUpload.count({ where: { messageId: { not: null } } })).toBe(0);
  });

  it("should send nothing when a file is still arriving, is someone else's, or is already on a message", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const pending = await jsonOf<Created>(await startUpload(conversation.id, { name: "half.pdf", size: 10 }));
    const used = await upload(conversation.id, "used.pdf", filled(6, 1));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "first", uploadIds: [used] });

    // Act & Assert
    for (const uploadIds of [[pending.uploadId], [used], ["11111111-2222-3333-4444-555555555555"]]) {
      expect(await actions.sendAssistantMessage({ conversationId: conversation.id, body: "again", uploadIds })).toMatchObject({ ok: false });
    }
    expect(await prisma.message.count()).toBe(1);
  });

  it("should refuse the same file twice on one message, and more files than a message carries", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const one = await upload(conversation.id, "a.pdf", filled(6, 1));

    // Act & Assert
    expect(await actions.sendAssistantMessage({ conversationId: conversation.id, body: "x", uploadIds: [one, one] })).toEqual({
      ok: false,
      error: "the same file is attached twice"
    });
    expect(await actions.sendAssistantMessage({ conversationId: conversation.id, body: "x", uploadIds: [one, one, one, one, one] })).toEqual({
      ok: false,
      error: `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`
    });
    expect(await prisma.message.count()).toBe(0);
  });

  it("should put a file on one message only when two tabs send it at the same time", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const only = await upload(conversation.id, "letter.pdf", filled(6, 1));

    // Act
    const results = await Promise.all([
      actions.sendAssistantMessage({ conversationId: conversation.id, body: "one", uploadIds: [only] }),
      actions.sendAssistantMessage({ conversationId: conversation.id, body: "two", uploadIds: [only] })
    ]);

    // Assert
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await prisma.assistantUpload.count({ where: { messageId: { not: null } } })).toBe(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it("should send as it always did when no files are attached", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "no files here" });

    // Assert
    expect(result).toMatchObject({ ok: true, message: { body: "no files here", attachments: [] } });
  });
});

describe("the frame the pod reads", () => {
  it("should name the attachments on the replay of a queued message", async () => {
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(PART_BYTES + 5, 1));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();

    // Assert
    expect(JSON.parse(direct!.data!).assistant.attachments).toEqual([
      { upload_id: uploadId, name: "letter.pdf", bytes: PART_BYTES + 5, media_type: "application/pdf", part_bytes: PART_BYTES, parts: 2 }
    ]);
  });

  it("should name the attachments on a message that arrives while the stream is open", async () => {
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    await stream.drain(200);
    const uploadId = await upload(conversation.id, "scan.png", filled(9, 2));

    // Act
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "and this", uploadIds: [uploadId] });
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();

    // Assert
    expect(JSON.parse(direct!.data!).assistant.attachments).toEqual([
      { upload_id: uploadId, name: "scan.png", bytes: 9, media_type: "application/pdf", part_bytes: PART_BYTES, parts: 1 }
    ]);
  });

  it("should carry an empty attachments array for a message nothing was attached to", async () => {
    // Nothing holds this back any more, so every delivery names its files — none of them, here. A client that
    // predates the field ignores it, which is what makes sending it to every pod safe.
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "just words" });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();

    // Assert
    const { assistant } = JSON.parse(direct!.data!);
    expect(assistant).toMatchObject({ conversation_id: conversation.id, product: "pcs" });
    expect(assistant.attachments).toEqual([]);
  });
});

describe("the pod fetching an attachment", () => {
  async function attached(name = "letter.pdf", bytes = filled(PART_BYTES + 5, 1)) {
    const started = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, name, bytes);
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const session = await sessionOf(conversation.id);
    await register(started.token, session.sessionId, conversation.id);
    return { ...started, ...session, conversationId: conversation.id, uploadId, bytes };
  }

  function partPath(agentId: string, uploadId: string, index: number): string {
    return `/api/agent/${agentId}/attachments/${uploadId}/parts/${index}`;
  }

  it("should serve each part's raw bytes", async () => {
    // Arrange
    const { token, agentId, uploadId, bytes } = await attached();

    // Act
    const first = await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 0), { agentId, uploadId, index: "0" });
    const second = await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 1), { agentId, uploadId, index: "1" });

    // Assert
    expect(first.headers.get("content-type")).toBe("application/octet-stream");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await first.arrayBuffer()).byteLength).toBe(PART_BYTES);
    const tail = new Uint8Array(await second.arrayBuffer());
    expect([...tail]).toEqual([...bytes.subarray(PART_BYTES)]);
  });

  it("should mark the upload fetched and keep its parts, which the owner's download needs, when the pod reports it", async () => {
    // The report no longer takes the bytes: the retention window does, on one clock for every upload, and until it
    // closes these part rows are the person's only copy of a file they attached from a browser that has moved on.
    // Arrange
    const { token, agentId, uploadId } = await attached();

    // Act
    const response = await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST");

    // Assert
    expect(response.status).toBe(204);
    expect(await prisma.assistantUploadPart.count({ where: { uploadId } })).toBe(2);
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "fetched", fileName: "letter.pdf" });
  });

  it("should answer a second fetched report the same way, so a pod that lost the first is not stuck", async () => {
    // Arrange
    const { token, agentId, uploadId } = await attached();
    const path = `/api/agent/${agentId}/attachments/${uploadId}/fetched`;
    await pod(attachmentFetchedRoute.POST, token, path, { agentId, uploadId }, "POST");

    // Act
    const again = await pod(attachmentFetchedRoute.POST, token, path, { agentId, uploadId }, "POST");

    // Assert
    expect(again.status).toBe(204);
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "fetched" });
  });

  it("should stop serving parts to the pod once they have been reported fetched, though the rows are still there", async () => {
    // Arrange
    const { token, agentId, uploadId } = await attached();
    await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST");

    // Act
    const response = await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 0), { agentId, uploadId, index: "0" });

    // Assert
    expect(response.status).toBe(404);
  });

  it("should refuse an upload that is not this conversation's, or still being composed", async () => {
    // Arrange
    const { token, agentId, conversationId } = await attached();
    const other = await createConversation(prisma, ALICE.oid, { product: "ccd" });
    const elsewhere = await upload(other.id, "stray.pdf", filled(4, 2));
    await actions.sendAssistantMessage({ conversationId: other.id, body: "theirs", uploadIds: [elsewhere] });
    const unsent = await upload(conversationId, "unsent.pdf", filled(4, 3));

    // Act & Assert
    for (const id of [elsewhere, unsent, "11111111-2222-3333-4444-555555555555"]) {
      const response = await pod(attachmentPartRoute.GET, token, partPath(agentId, id, 0), { agentId, uploadId: id, index: "0" });
      expect(response.status, id).toBe(404);
    }
  });

  it("should answer 404 for an agent that is not a conversation's at all", async () => {
    // Arrange
    const { token, uploadId } = await attached();
    const stray = await pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", { session_id: "sid-stray", name: "own" });
    const agentId = (await jsonOf<{ agent_id: string }>(stray)).agent_id;

    // Act
    const response = await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 0), { agentId, uploadId, index: "0" });

    // Assert
    expect(response.status).toBe(404);
  });

  it("should put both pod routes out of reach on a deployment without virtual agents", async () => {
    // 401 rather than 404: a conversation's agent is only ever reached with a virtual agent's launch token, and
    // without virtual agents that token is not honoured at all, so the refusal comes before the route is entered.
    // Arrange
    const { token, agentId, uploadId } = await attached();
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    // Act & Assert
    expect((await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 0), { agentId, uploadId, index: "0" })).status).toBe(401);
    expect((await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST")).status).toBe(
      401
    );
  });

  it("should list the virtual agent's conversations for the pod to reconcile its directories against", async () => {
    // Arrange
    const { id, token } = await startedAssistant();
    const one = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const two = await createConversation(prisma, ALICE.oid, { product: "ccd" });

    // Act
    const response = await pod(conversationsRoute.GET, token, `/api/virtual/${id}/conversations`, { virtualAgentId: id });

    // Assert
    const { conversations } = await jsonOf<{ conversations: { id: string }[] }>(response);
    expect(conversations.map((conversation) => conversation.id).sort(byCodePoint)).toEqual([one.id, two.id].sort(byCodePoint));
  });
});

/**
 * The person downloading their own file back, which is the only way they ever see it again: the browser that picked
 * it has moved on, and the pod's copy is on a volume they have no route to.
 */
describe("downloading an attachment back", () => {
  function download(uploadId: string, as = "alice"): Promise<Response> {
    return ui(contentRoute.GET, { path: `/api/ui/uploads/${uploadId}/content`, params: { uploadId }, as });
  }

  /**
   * A file on a sent message, with the bytes it went up as, in a conversation of its own. The assistant is started
   * here only the first time: a claim answers for an unclaimed virtual agent, so a second call would find nothing.
   */
  async function sentFile(name: string, bytes: Uint8Array<ArrayBuffer>, mediaType = "application/pdf") {
    if ((await prisma.virtualAgent.count()) === 0) {
      await startedAssistant();
    }
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name, size: bytes.byteLength, mediaType }));
    for (let index = 0; index < created.parts; index += 1) {
      const slice = bytes.subarray(index * created.partBytes, Math.min(bytes.byteLength, (index + 1) * created.partBytes));
      expect((await putPart(created.uploadId, index, slice)).ok, `part ${index}`).toBe(true);
    }
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [created.uploadId] });
    return { conversationId: conversation.id, uploadId: created.uploadId };
  }

  it("should answer the exact bytes that went in, every one of them, for a file of several parts", async () => {
    // Compared byte for byte rather than sampled: a stream that reads part rows in turn can drop one, repeat one or
    // put them back in the wrong order, and every one of those shows up only in the whole file.
    // Arrange
    const sent = new Uint8Array(PART_BYTES * 2 + 1234);
    for (let at = 0; at < sent.byteLength; at += 1) {
      sent[at] = (at * 31 + (at >> 11)) & 0xff;
    }
    const { uploadId } = await sentFile("my letter (final).pdf", sent);

    // Act
    const response = await download(uploadId);

    // Assert
    expect(response.status).toBe(200);
    const back = new Uint8Array(await response.arrayBuffer());
    expect(back.byteLength).toBe(sent.byteLength);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(sent))).toBe(0);
  });

  it("should still answer the file after the pod has fetched it, which is when every real download happens", async () => {
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const sent = filled(PART_BYTES + 7, 3);
    const uploadId = await upload(conversation.id, "letter.pdf", sent);
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST");

    // Act
    const response = await download(uploadId);

    // Assert
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "fetched" });
    expect(Buffer.compare(Buffer.from(new Uint8Array(await response.arrayBuffer())), Buffer.from(sent))).toBe(0);
  });

  it("should name the sanitised file and tell the browser to save rather than render it", async () => {
    // Arrange
    const { uploadId } = await sentFile("my report <script>.html", filled(9, 4), "text/html");

    // Act
    const response = await download(uploadId);

    // Assert: the `stored_name`, which the CHECK constrains, never the person's own name in a header.
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="my_report_script_.html"');
    expect(response.headers.get("content-type")).toBe("text/html");
    // Which is why the type they claimed is safe to answer: saved, not rendered as a page of this origin.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe("9");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should give someone else nothing, and say no more than it says about an upload that never existed", async () => {
    // Arrange
    const { uploadId } = await sentFile("letter.pdf", filled(12, 5));
    await insertUser(BOB);
    await createVirtualAgent(prisma, { owner: BOB, modelRoute: "gateway", name: "bobs" });

    // Act
    const theirs = await download(uploadId, "bob");
    const invented = await download("11111111-2222-3333-4444-555555555555", "bob");
    const nonsense = await download("not-a-uuid", "bob");

    // Assert
    expect([theirs.status, invented.status, nonsense.status]).toEqual([404, 404, 404]);
    expect(await jsonOf(theirs)).toEqual({ reason: "no_such_upload", error: "no such upload" });
    expect(await jsonOf(invented)).toEqual({ reason: "no_such_upload", error: "no such upload" });
  });

  it("should refuse a signed-out caller before it looks the upload up at all", async () => {
    // Arrange
    const { uploadId } = await sentFile("letter.pdf", filled(12, 5));
    vi.stubEnv("AUTH_DISABLED", "false");

    // Act
    const response = await download(uploadId);

    // Assert
    expect(response.status).toBe(401);
  });

  it("should tell the owner plainly that a file the sweep has taken is no longer held", async () => {
    // Arrange
    const { uploadId } = await sentFile("letter.pdf", filled(12, 6));
    await prisma.assistantUpload.update({ where: { id: uploadId }, data: { createdAt: new Date(Date.now() - 99 * 3_600_000) } });
    await sweepUploads(prisma, { retentionHours: 3 });

    // Act
    const response = await download(uploadId);

    // Assert
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "expired" });
    expect(response.status).toBe(410);
    expect(await jsonOf(response)).toEqual({ reason: "no_longer_held", error: "that file is no longer held here" });
  });

  it("should refuse a file past its window even before the sweep has reached it, and say so in the thread", async () => {
    // The sweep runs every ten minutes, so there is always a slice of time where the bytes are there and the window
    // has gone. The window decides, in the route and in the chip alike.
    // Arrange
    const { conversationId, uploadId } = await sentFile("letter.pdf", filled(12, 7));
    await prisma.assistantUpload.update({ where: { id: uploadId }, data: { createdAt: new Date(Date.now() - 99 * 3_600_000) } });

    // Act
    const response = await download(uploadId);

    // Assert
    expect(await prisma.assistantUploadPart.count({ where: { uploadId } })).toBe(1);
    expect(response.status).toBe(410);
    // And the chip the person is looking at says so without being asked: its window is already in the past.
    const page = await assistantConversation(VIEWER, conversationId);
    const attachments = page!.page.messages.flatMap((message) => message.attachments ?? []);
    expect(attachments).toHaveLength(1);
    expect(Date.parse(attachments[0]!.available_until!)).toBeLessThan(Date.now());
  });

  it("should offer no window at all on a file whose bytes have gone, so the chip cannot offer a download", async () => {
    // Arrange
    const { conversationId, uploadId } = await sentFile("letter.pdf", filled(12, 8));
    await prisma.assistantUpload.update({ where: { id: uploadId }, data: { state: "expired" } });

    // Act
    const page = await assistantConversation(VIEWER, conversationId);

    // Assert
    const attachments = page!.page.messages.flatMap((message) => message.attachments ?? []);
    expect(attachments).toEqual([{ id: uploadId, name: "letter.pdf", bytes: 12, media_type: "application/pdf", available_until: null }]);
  });

  it("should refuse an upload still arriving, whose parts would make a file with holes in it", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "half.pdf", size: PART_BYTES + 10 }));
    await putPart(created.uploadId, 0, filled(PART_BYTES, 1));

    // Act
    const response = await download(created.uploadId);

    // Assert
    expect(response.status).toBe(410);
  });

  it("should answer 404 on a deployment without virtual agents, as every other upload route does", async () => {
    // Arrange
    const { uploadId } = await sentFile("letter.pdf", filled(12, 9));
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    // Act
    const response = await download(uploadId);

    // Assert
    expect(response.status).toBe(404);
    expect(await jsonOf(response)).toMatchObject({ reason: "unavailable" });
  });

  it("should answer a large file in parts rather than in one piece, which is what keeps it off the heap", async () => {
    // The outbound counterpart of "should not take a whole file into memory when a client streams one at a single
    // part". What is asserted is the *shape* of the response rather than a memory reading, because the reading cannot
    // tell one part from six through undici, Prisma and an allocator that keeps freed external memory for reuse: it
    // was tried, and two runs of the same 24 MB download differed by more than the whole file.
    //
    // A route that read the part rows into one buffer would answer 24 MB as a single chunk, which is what this
    // refuses. How many rows are read before a chunk is taken is counted exactly, against a database that answers
    // one row at a time, in `src/assistant/upload-store.test.ts`.
    // Arrange
    const sent = filled(PART_BYTES * 6, 7);
    const { uploadId } = await sentFile("large.pdf", sent);

    // Act
    const response = await download(uploadId);
    const reader = response.body!.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value.byteLength);
    }

    // Assert
    const measured = `a ${(sent.byteLength / MB).toFixed(0)} MB download arrived in ${chunks.length} chunks, the largest ${(Math.max(...chunks) / MB).toFixed(1)} MB`;
    // Printed as well as asserted, as the inbound measurements are: this is the figure the direction was accepted on.
    console.info(measured);
    expect(
      chunks.reduce((total, length) => total + length, 0),
      measured
    ).toBe(sent.byteLength);
    expect(Math.max(...chunks), measured).toBeLessThanOrEqual(PART_BYTES);
    expect(chunks.length, measured).toBeGreaterThan(1);
  });
});

describe("deleting a conversation", () => {
  it("should take its uploads and their parts with it, with no change to deleteConversation", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const attachedId = await upload(conversation.id, "letter.pdf", filled(6, 1));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [attachedId] });
    const composing = await upload(conversation.id, "draft.pdf", filled(6, 2));

    // Act
    await actions.deleteConversation({ conversationId: conversation.id });

    // Assert: the attached row cascades from the message, the composing one from the conversation.
    expect(await prisma.assistantUpload.count()).toBe(0);
    expect(await prisma.assistantUploadPart.count()).toBe(0);
    expect(composing).not.toBe(attachedId);
  });
});

describe("the upload sweep", () => {
  async function stale(conversationId: string, hoursAgo: number, state: "pending" | "stored" | "fetched"): Promise<string> {
    const created = await prisma.assistantUpload.create({
      data: {
        conversationId,
        ownerOid: ALICE.oid,
        fileName: "a.pdf",
        storedName: "a.pdf",
        mediaType: "application/pdf",
        bytes: 4n,
        state,
        createdAt: new Date(Date.now() - hoursAgo * 3_600_000)
      },
      select: { id: true }
    });
    await prisma.assistantUploadPart.create({ data: { uploadId: created.id, index: 0, data: filled(4, 1) } });
    return created.id;
  }

  /**
   * A conversation that has been spoken in. These tests are about the bytes going, so the conversation is one the
   * other half of the sweep leaves alone — a conversation with no message and nothing but an old upload is swept
   * whole, which `the sweep of conversations attaching left behind` covers.
   */
  async function spokenIn(): Promise<string> {
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "hello" });
    return conversation.id;
  }

  it("should drop the bytes of anything nothing fetched in time and leave a recent upload alone", async () => {
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    const abandoned = await stale(conversationId, 5, "stored");
    const neverFinished = await stale(conversationId, 5, "pending");
    const recent = await stale(conversationId, 1, "stored");

    // Act
    const result = await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(result).toEqual({ expired: 2, parts: 2, conversations: 0 });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: abandoned } })).toMatchObject({ state: "expired" });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: neverFinished } })).toMatchObject({ state: "expired" });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: recent } })).toMatchObject({ state: "stored" });
    expect(await prisma.assistantUploadPart.findMany({ select: { uploadId: true } })).toEqual([{ uploadId: recent }]);
  });

  it("should keep the metadata row, so the thread can still say a file was attached", async () => {
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    await stale(conversationId, 5, "stored");

    // Act
    await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(await prisma.assistantUpload.count()).toBe(1);
  });

  it("should take a fetched upload's bytes on the same clock as any other, since the window is what bounds them", async () => {
    // The window, not the pod's report, is what ends an upload's time in Postgres: holding a fetched one for longer
    // would keep the owner's download alive past what the retention design pays for.
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    const old = await stale(conversationId, 99, "fetched");
    const recent = await stale(conversationId, 1, "fetched");

    // Act
    const result = await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(result).toEqual({ expired: 1, parts: 1, conversations: 0 });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ state: "expired" });
    expect(await prisma.assistantUploadPart.findMany({ select: { uploadId: true } })).toEqual([{ uploadId: recent }]);
  });

  it("should do nothing at all when every upload is still inside its window", async () => {
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    await stale(conversationId, 1, "fetched");
    await stale(conversationId, 1, "stored");

    // Act
    const result = await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(result).toEqual({ expired: 0, parts: 0, conversations: 0 });
    expect(await prisma.assistantUploadPart.count()).toBe(2);
  });

  it("should take only a batch at a time, so a backlog drains over several ticks", async () => {
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    for (let n = 0; n < 3; n += 1) {
      await stale(conversationId, 5, "stored");
    }

    // Act
    const first = await sweepUploads(prisma, { retentionHours: 3, batch: 2 });
    const second = await sweepUploads(prisma, { retentionHours: 3, batch: 2 });

    // Assert
    expect(first).toEqual({ expired: 2, parts: 2, conversations: 0 });
    expect(second).toEqual({ expired: 1, parts: 1, conversations: 0 });
  });

  it("should leave the sweep to the other pod when one already holds the lock", async () => {
    // Arrange
    await startedAssistant();
    const conversationId = await spokenIn();
    await stale(conversationId, 5, "stored");

    // Act: two sweeps in one transaction each, started together, so one finds the advisory lock taken.
    const [one, two] = await Promise.all([sweepUploads(prisma, { retentionHours: 3 }), sweepUploads(prisma, { retentionHours: 3 })]);

    // Assert
    expect([one, two].filter((result) => result === undefined).length).toBeLessThanOrEqual(1);
    expect(await prisma.assistantUploadPart.count()).toBe(0);
  });

  describe("startUploadSweep", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should log what a tick took, and nothing for a tick that found nothing", async () => {
      // Arrange: one upload past the window, which the default retention is the same 3 hours as every test above
      // passes explicitly. The spy goes on after the fixtures, which announce an orchestrator lease of their own.
      await startedAssistant();
      await stale(await spokenIn(), 5, "stored");
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const transaction = vi.spyOn(prisma, "$transaction");

      // Act
      const sweeper = startUploadSweep(prisma, 10);
      try {
        await until(() => info.mock.calls.length > 0);
        // Two more ticks after the one that took it, so the quiet is a tick that ran and found nothing rather than
        // a tick that had yet to happen.
        const calls = transaction.mock.calls.length;
        await until(() => transaction.mock.calls.length >= calls + 2);
      } finally {
        await sweeper.stop();
      }

      // Assert
      expect(info.mock.calls).toEqual([["upload sweep: 1 uploads past their window expired, 1 part rows deleted"]]);
      expect(await prisma.assistantUploadPart.count()).toBe(0);
    });

    it("should warn when a tick fails, and skip ticks while one is still running", async () => {
      // Arrange: a client whose every tick rejects, the second with something that is not an `Error`, since the
      // warning reads the message off one.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const failures: unknown[] = [new Error("database gone"), "not an error"];
      let started = 0;
      const failing = {
        $transaction: () => {
          const failure = failures[started++ % failures.length];
          return new Promise((_unused, reject) => setTimeout(() => reject(failure), 50));
        }
      } as unknown as PrismaClient;

      // Act: an interval an order of magnitude shorter than a tick takes, so a tick is always still running when
      // the next one is due.
      const sweeper = startUploadSweep(failing, 5);
      try {
        await until(() => warn.mock.calls.length >= 2);
      } finally {
        await sweeper.stop();
      }

      // Assert
      expect(warn.mock.calls.slice(0, 2)).toEqual([["the upload sweep failed: database gone"], ["the upload sweep failed: not an error"]]);
      expect(started).toBeLessThanOrEqual(warn.mock.calls.length + 1);
    });
  });
});

const MB = 1024 * 1024;

/** Clients streaming at once in the reading measurement below; also the per-message file cap. */
const CONCURRENT_UPLOADS = 4;

describe("the hub's memory", () => {
  it("should read no more than a part from each of several clients streaming a whole file at once", async () => {
    // Arrange: `CONCURRENT_UPLOADS` clients that each offer a whole 24 MB file at part 0, with every request in
    // flight together — the shape a buffering reader multiplies. What is counted is the bytes the hub pulled, not
    // the heap it was seen holding: the reads are the route's own behaviour, where `heapUsed + arrayBuffers` is the
    // whole worker's and moves with the Prisma pool, undici's buffers and the allocator's retained externals.
    // Each body is generated chunk by chunk from one small buffer, so the test holds no copy of any file.
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const offered = PART_BYTES * 6;
    const chunk = 64 * 1024;
    let pulled = 0;
    // Four at once is the per-message cap, and none of these is ever sent, so one conversation holds them all.
    const created = await Promise.all(
      Array.from(
        { length: CONCURRENT_UPLOADS },
        async (_unused, n) => await jsonOf<Created>(await startUpload(conversation.id, { name: `whole${n}.pdf`, size: offered }))
      )
    );

    const streamWholeFile = async (upload: Created): Promise<number> => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= offered) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunk).fill(7));
          sent += chunk;
          pulled += chunk;
        }
      });
      const request = new NextRequest(`http://localhost:3000/api/ui/uploads/${upload.uploadId}/parts/0`, {
        method: "PUT",
        headers: { cookie: `${DEV_PERSONA_COOKIE}=alice`, "content-type": "application/octet-stream" },
        body,
        duplex: "half"
      } as NextInit);
      const response = await partRoute.PUT(request, { params: Promise.resolve({ uploadId: upload.uploadId, index: "0" }) });
      return response.status;
    };

    // Act
    const statuses = await Promise.all(created.map(streamWholeFile));

    // Assert
    expect(statuses).toEqual(created.map(() => 413));
    const measured = `${CONCURRENT_UPLOADS} clients streaming ${offered / MB} MB files at one part got through ${(pulled / MB).toFixed(1)} MB between them`;
    // Printed as well as asserted: this is one of the two measurements the transport was accepted on.
    console.info(measured);
    // An unbounded read pulls every offered byte — CONCURRENT_UPLOADS × 24 MB — and this reader stops a chunk past
    // each part's length, so the allowance of two parts per request in flight sits far below that and just above
    // what a part-at-a-time reader can pull.
    expect(pulled, measured).toBeLessThan(CONCURRENT_UPLOADS * PART_BYTES * 2);
  });

  it("should not take a whole file into memory when a client streams one at a single part", async () => {
    // Arrange: the failure this transport is guarded against. A client that sends its whole 24 MB file at part 0 is
    // refused, but a reader built on `request.arrayBuffer()` would have all 24 MB in memory before it could refuse.
    // The body is generated chunk by chunk from one small buffer, so the test holds no copy of it and the only thing
    // the measurement can see is what the route itself keeps.
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const offered = PART_BYTES * 6;
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "whole.pdf", size: offered }));
    const chunk = 64 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= offered) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk).fill(7));
        sent += chunk;
      }
    });
    const request = new NextRequest(`http://localhost:3000/api/ui/uploads/${created.uploadId}/parts/0`, {
      method: "PUT",
      headers: { cookie: `${DEV_PERSONA_COOKIE}=alice`, "content-type": "application/octet-stream" },
      body,
      duplex: "half"
    } as NextInit);
    // Act
    const response = await partRoute.PUT(request, { params: Promise.resolve({ uploadId: created.uploadId, index: "0" }) });

    // Assert
    expect(response.status).toBe(413);
    const measured = `a client streaming a ${offered / MB} MB file at one part got through ${(sent / MB).toFixed(1)} MB before being refused`;
    // Printed as well as asserted: this is one of the two measurements the transport was accepted on.
    console.info(measured);
    // How much of the body the hub pulled, not how much heap it was seen holding: `arrayBuffer()` consumes an
    // in-memory stream in one run of microtasks, so no interval sampler gets to look while the peak is there. The
    // bytes it asked for are the measurement that cannot be missed — an unbounded read pulls all 24 MB, and this
    // reader stops a chunk past the part's length.
    expect(sent, measured).toBeLessThan(PART_BYTES * 2);
  });
});

/**
 * The seam between the two halves of this feature, which neither half's own tests reach.
 *
 * The hub's tests above stop at the `direct` frame; the client's tests in `packages/agent-hub` start from a frame a
 * test wrote and an `api` a test stubbed. So a file had never been carried the whole way: through the browser-facing
 * routes, onto a message, out in a real frame, through the client's own parser, down the pod-facing routes and onto a
 * disk, and finally named in the envelope the session reads. Each end agreed with its own idea of the contract.
 *
 * `api` here calls the route handlers directly rather than over HTTP, which is the only part that is not real — the
 * frame, the parse, the part fetching, the fetched report, the bytes on disk and the envelope all are.
 */
describe("a file from the browser to the session's envelope", () => {
  /** An `Api` whose two attachment calls are the hub's real pod-facing routes, with the pod's own launch token. */
  function podApi(token: string): PodApi {
    return {
      attachmentPart: async (agentId, uploadId, index) => {
        const response = await pod(attachmentPartRoute.GET, token, `/api/agent/${agentId}/attachments/${uploadId}/parts/${index}`, {
          agentId,
          uploadId,
          index: String(index)
        });
        if (!response.ok) {
          throw new Error(`part ${index} was refused: ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      attachmentFetched: async (agentId, uploadId) => {
        const response = await pod(
          attachmentFetchedRoute.POST,
          token,
          `/api/agent/${agentId}/attachments/${uploadId}/fetched`,
          { agentId, uploadId },
          "POST",
          {}
        );
        if (!response.ok) {
          throw new Error(`the fetched report was refused: ${response.status}`);
        }
        return null;
      }
    };
  }

  /** The `direct` frame the pod would really receive for the conversation's one message. */
  async function frameFor(token: string, agentId: string): Promise<{ message: EnvelopeMessage; assistant: unknown }> {
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();
    return JSON.parse(direct!.data!) as { message: EnvelopeMessage; assistant: unknown };
  }

  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "agent-hub-uploads-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("should put the person's bytes on the pod's disk and name that path to the session, dropping the parts on the way", async () => {
    // Arrange: a file big enough to be more than one part, so the join is tested part by part rather than in one go.
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const bytes = filled(PART_BYTES + 1234, 7);
    bytes[0] = 1;
    bytes[bytes.byteLength - 1] = 255;
    const uploadId = await upload(conversation.id, "my scanned letter.pdf", bytes);
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "What does this letter say?", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act: exactly what `bridge.ts` does on a `direct` — parse the frame, fetch what it names, then build the envelope.
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const attachments = parseAttachments(assistant?.attachments);
    const outcomes = await fetchAttachments({ api: podApi(token), agentId, conversationId: conversation.id, attachments, root });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: outcomes });

    // Assert: the client was willing to act on the frame the route really produced.
    expect(attachments).toEqual([{ uploadId, name: "my_scanned_letter.pdf", bytes: bytes.byteLength, mediaType: "application/pdf", parts: 2 }]);

    // The file on disk is the person's file, byte for byte, under the conversation's own directory.
    const written = path.join(root, conversation.id, `${uploadId}-my_scanned_letter.pdf`);
    expect(outcomes).toEqual([{ name: "my_scanned_letter.pdf", path: written, media_type: "application/pdf", bytes: bytes.byteLength }]);
    const onDisk = new Uint8Array(await fs.readFile(written));
    expect(onDisk.byteLength).toBe(bytes.byteLength);
    expect(onDisk[0]).toBe(1);
    expect(onDisk[PART_BYTES]).toBe(7);
    expect(onDisk[onDisk.byteLength - 1]).toBe(255);

    // The envelope names that absolute path, which is the session's only route to the bytes: the message is delivered
    // over the messaging socket with `skipAttachments`, so an `@name` in the body would be inert.
    expect(content).toContain(written);
    expect(content).toContain("already saved on this machine");
    expect(content).toContain("What does this letter say?");

    // And the fetched report the client sent through the real route marked the upload without taking its bytes: the
    // pod has the file and so, until the window closes, does the person who attached it.
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "fetched" });
    expect(await prisma.assistantUploadPart.count({ where: { uploadId } })).toBe(2);
  });

  it("should tell the session the file could not be retrieved, and still deliver the message, when the parts have gone", async () => {
    // Arrange: an upload the sweep has already expired, which is what a pod that never came up within the retention
    // window finds. The metadata row survives, so the frame still names a file whose bytes do not exist.
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(20, 3));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    await prisma.assistantUploadPart.deleteMany({ where: { uploadId } });

    // Act
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const outcomes = await fetchAttachments({
      api: podApi(token),
      agentId,
      conversationId: conversation.id,
      attachments: parseAttachments(assistant?.attachments),
      root
    });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: outcomes });

    // Assert: said so rather than dropped, because a silent omission leaves the person believing their file was read.
    expect(outcomes[0]).toMatchObject({ name: "letter.pdf", error: expect.stringContaining("404") });
    expect(outcomes[0]?.path).toBeUndefined();
    expect(content).toContain("could not be retrieved");
    expect(content).toContain("read this");
  });

  it("should tell the session the file could not be retrieved when the sweep expired one already on a sent message", async () => {
    // Arrange: a pod stopped for longer than the retention window, which is routine — the idle stop is 120 minutes
    // and there is an evening stop at 19:00. The sweep takes the bytes of a file already on a sent message, and this
    // is what the session must then be told, rather than being handed a message that names no file at all.
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "scan.png", filled(20, 3));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    await prisma.assistantUpload.update({ where: { id: uploadId }, data: { createdAt: new Date(Date.now() - 5 * 3_600_000) } });
    const swept = await sweepUploads(prisma, { retentionHours: 3 });

    // Act
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const attachments = parseAttachments(assistant?.attachments);
    const outcomes = await fetchAttachments({ api: podApi(token), agentId, conversationId: conversation.id, attachments, root });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: outcomes });

    // Assert: the expiry is narrated. The envelope names the file and says it could not be retrieved, so the session
    // cannot answer as though it had read it — and the message itself is still delivered.
    expect(content).toContain("A file the user attached could not be retrieved and is not on this machine: scan.png.");
    expect(content).toContain("ask them to attach it again");
    expect(content).toContain("read this");
    expect(content).not.toContain("already saved on this machine");
    // Which it can only say because the frame still named the file the sweep had taken the bytes of, and the fetch of
    // it was refused rather than the entry ceasing to exist.
    expect(swept).toMatchObject({ expired: 1, parts: 1 });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({ state: "expired" });
    expect(attachments).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ name: "scan.png", error: expect.stringContaining("404") });
  });

  it("should carry every file of a message with four of them, each to its own path", async () => {
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const names = ["one.pdf", "two.png", "three.csv", "four.txt"];
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      ids.push(await upload(conversation.id, name, filled(10 + index, index + 1)));
    }
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "all four", uploadIds: ids });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const outcomes = await fetchAttachments({
      api: podApi(token),
      agentId,
      conversationId: conversation.id,
      attachments: parseAttachments(assistant?.attachments),
      root
    });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: outcomes });

    // Assert
    expect(outcomes.map((outcome) => outcome.name)).toEqual(names);
    expect(outcomes.every((outcome) => typeof outcome.path === "string")).toBe(true);
    for (const [index, id] of ids.entries()) {
      const written = path.join(root, conversation.id, `${id}-${names[index]}`);
      expect((await fs.readFile(written)).byteLength).toBe(10 + index);
      expect(content).toContain(written);
    }
    expect(content).toContain("The user attached 4 files to this message");
    // Every one reported fetched, and every one's bytes still in Postgres for the owner's download until the window
    // closes on them.
    expect(await prisma.assistantUpload.count({ where: { state: "fetched" } })).toBe(4);
    expect(await prisma.assistantUploadPart.count()).toBe(4);
  });

  it("should name the real path above the skill line when the message is both a slash command and a file", async () => {
    // The two features meet here. Skills and attachments both reach the envelope through its options, and the order
    // is a decision: the skill line says "the rest of the message as its arguments", so it sits against the body
    // and the paths go above it. This checks that against a frame the route really built and a file really on disk,
    // rather than against hand-written outcomes.
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(16, 5));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "/cft-explain what does this say?", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act: exactly what the bridge does, with a session that has the skill.
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const outcomes = await fetchAttachments({
      api: podApi(token),
      agentId,
      conversationId: conversation.id,
      attachments: parseAttachments(assistant?.attachments),
      root
    });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { skills: new Set(["cft-explain"]), attachments: outcomes });

    // Assert: both instructions present, the skill line last, the real path above it.
    const lines = content.split("\n");
    const sep = lines.indexOf("---");
    expect(lines[sep - 1]).toBe(
      "It starts with /cft-explain: run the cft-explain skill with the rest of the message as its arguments, as if your user had typed it."
    );
    const written = path.join(root, conversation.id, `${uploadId}-letter.pdf`);
    expect(lines.indexOf(`- ${written} (application/pdf, 1 KB)`)).toBeLessThan(sep - 1);
    expect(content.endsWith("\n---\n/cft-explain what does this say?")).toBe(true);
    // And the file really is on disk at the path the session is told to read.
    expect((await fs.readFile(written)).byteLength).toBe(16);
  });

  it("should name the file to the session when the message carried no words at all", async () => {
    // Arrange: a message of files and nothing typed, which `checkBody` allows and the envelope has to stand up to.
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(12, 4));

    // Act
    const sent = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const outcomes = await fetchAttachments({
      api: podApi(token),
      agentId,
      conversationId: conversation.id,
      attachments: parseAttachments(assistant?.attachments),
      root
    });
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: outcomes });

    // Assert: the session gets the paths and a body saying what to do with them, rather than paths and silence.
    expect(sent).toMatchObject({ ok: true });
    expect(content).toContain(path.join(root, conversation.id, `${uploadId}-letter.pdf`));
    expect(content).toContain("already saved on this machine");
    expect(content).toContain("I have attached a file. Please take a look.");
    // The body counts the files; the names reach the session through the envelope above, never through a message
    // body that a read-only share of the conversation would carry.
    expect(content.slice(content.indexOf("I have attached"))).not.toContain("letter.pdf");
    // And the chat is named after the file, since there are no words to name it after.
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ title: "letter.pdf" });
  });

  it("should tell a client that cannot read the frame nothing at all, rather than mislead the person", async () => {
    // This is what stands in for the flag that used to hold the hub back. Every pod is now sent the attachments, so
    // the question is what a pod whose client predates them does — and the answer has to be "say nothing", not
    // "claim the file was read". `parseAttachments` answers `[]` for anything it will not act on, `attachmentLines`
    // then adds nothing, and the person's message is still delivered.
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(12, 4));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);

    // Act: the frame as it really is, then read as a client that knows nothing of the field would read it.
    const frame = await frameFor(token, agentId);
    const assistant = parseAssistantFrame(frame.assistant);
    const unreadable = parseAttachments(undefined);
    const content = assistantEnvelope(frame.message, assistant ?? {}, null, { attachments: unreadable });

    // Assert: the hub did send them, and an old client still says not a word about a file it never fetched.
    expect(parseAttachments(assistant?.attachments)).toHaveLength(1);
    expect(unreadable).toEqual([]);
    expect(content).not.toContain("attached");
    expect(content).toContain("read this");
    // And the bytes stay in Postgres for the pod that does understand, once one is running.
    expect(await prisma.assistantUploadPart.count({ where: { uploadId } })).toBe(1);
  });
});

describe("a message of files and no words", () => {
  it("should be given a body naming the files, which `message_body_present` requires and the session needs", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const first = await upload(conversation.id, "scanned letter.pdf", filled(6, 1));
    const second = await upload(conversation.id, "notes.txt", filled(3, 2));

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "   ", uploadIds: [first, second] });

    // Assert
    expect(result).toMatchObject({ ok: true, message: { body: "I have attached 2 files. Please take a look." } });
    // The chat is named after the file the person chose, not the sentence written for them.
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ title: "scanned letter.pdf" });
  });

  it("should refuse the send rather than write a wordless message when none of the files is ready", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const half = await jsonOf<Created>(await startUpload(conversation.id, { name: "half.pdf", size: 10 }));

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "", uploadIds: [half.uploadId] });

    // Assert
    expect(result).toEqual({ ok: false, error: "one of those files is not ready to send; remove it and attach it again" });
    expect(await prisma.message.count()).toBe(0);
  });

  it("should still be refused when there is neither a word nor a file", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });

    // Act
    const result = await actions.sendAssistantMessage({ conversationId: conversation.id, body: "  ", uploadIds: [] });

    // Assert
    expect(result).toEqual({ ok: false, error: "write something to send" });
    expect(await prisma.message.count()).toBe(0);
  });

  it("should keep the title the person's own words when they typed some as well", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(6, 1));

    // Act
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "What does this say?", uploadIds: [uploadId] });

    // Assert
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ title: "What does this say?" });
  });
});

describe("attaching on the new-chat screen", () => {
  it("should open an empty conversation for a file to belong to", async () => {
    // Arrange
    await startedAssistant();

    // Act
    const opened = await actions.openConversation({ product: "pcs" });

    // Assert
    expect(opened).toMatchObject({ ok: true });
    const id = (opened as { id: string }).id;
    expect(await prisma.assistantConversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ product: "pcs", title: null });
    // And a file can go into it straight away, which is the whole point of opening it early.
    expect(await startUpload(id, { name: "letter.pdf", size: 6 })).toMatchObject({ status: 201 });
  });

  it("should refuse to open one at all without virtual agents, since there would be no Assistant to attach to", async () => {
    // Arrange
    await startedAssistant();
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    // Act
    const opened = await actions.openConversation({ product: "pcs" });

    // Assert
    expect(opened).toEqual({ ok: false, error: "the HMCTS Assistant is not available on this deployment" });
    expect(await prisma.assistantConversation.count()).toBe(0);
  });
});

describe("the sweep of conversations attaching left behind", () => {
  /** A conversation whose only content is one upload, attached `hoursAgo` and never sent. */
  async function abandoned(hoursAgo: number): Promise<string> {
    const at = new Date(Date.now() - hoursAgo * 3_600_000);
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    // The conversation is backdated as well as its file: an upload cannot predate the conversation it belongs to,
    // and the sweep looks at both, so a helper that aged only one would be arranging something impossible.
    await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { createdAt: at } });
    await prisma.assistantUpload.create({
      data: {
        conversationId: conversation.id,
        ownerOid: ALICE.oid,
        fileName: "a.pdf",
        storedName: "a.pdf",
        mediaType: "application/pdf",
        bytes: 4n,
        state: "stored",
        createdAt: at
      }
    });
    return conversation.id;
  }

  it("should delete one whose only content was a file nobody sent, so it stops showing as a second New chat", async () => {
    // Arrange
    await startedAssistant();
    const id = await abandoned(4);

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 1 });
    expect(await prisma.assistantConversation.count({ where: { id } })).toBe(0);
    // The pre-created agent goes with it, which is the other row an abandoned chat holds.
    expect(await prisma.agent.count({ where: { assistantConversationId: id } })).toBe(0);
  });

  it("should leave one whose file was attached inside the window, since the person may still be composing", async () => {
    // Arrange
    await startedAssistant();
    const id = await abandoned(1);

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id } })).toBe(1);
  });

  it("should put the clock back when a second file was attached recently, rather than sweep a live composer", async () => {
    // Arrange
    await startedAssistant();
    const id = await abandoned(5);
    await startUpload(id, { name: "second.pdf", size: 6 });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id } })).toBe(1);
  });

  it("should leave a conversation that was spoken in, however old its files are", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(6, 1));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    await prisma.assistantUpload.updateMany({ where: { conversationId: conversation.id }, data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id: conversation.id } })).toBe(1);
  });

  it("should delete an old empty conversation whatever became of its files, since nobody ever spoke in it", async () => {
    // It used to take an upload still being present, which left anything whose file had been removed — or whose
    // very first message failed after the row was created — showing in the sidebar for ever with nothing to
    // collect it.
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 1 });
    expect(await prisma.assistantConversation.count({ where: { id: conversation.id } })).toBe(0);
  });

  /**
   * A conversation with no pod is a session on somebody's laptop, which the hub made for the session rather than for
   * a file. Nothing was abandoned, and the chat is empty until the person types into it — so without this it would be
   * swept within the window, taking the live session's `agent` row, its transcript and its place on the roster with
   * it.
   */
  it("should leave a conversation with no pod, which is a session on somebody's laptop", async () => {
    // Arrange
    const agent = await prisma.agent.create({ data: { ownerOid: ALICE.oid, sessionId: "alices-laptop", name: "alices-laptop" }, select: { id: true } });
    const local = (await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId: agent.id, name: "alices-laptop" }))!;
    await prisma.assistantConversation.update({ where: { id: local.id }, data: { createdAt: new Date(Date.now() - 48 * 3_600_000) } });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id: local.id } })).toBe(1);
    expect(await prisma.agent.count({ where: { id: agent.id } })).toBe(1);
  });

  it("should leave one whose session wrote a document before the person said anything", async () => {
    // Arrange
    await startedAssistant();
    const id = await abandoned(5);
    await prisma.assistantConversation.update({ where: { id }, data: { artefactVersion: 1, artefactMarkdown: "# what I found" } });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id } })).toBe(1);
  });

  it("should announce each deletion, so a sidebar still open stops showing a chat that has gone", async () => {
    // Arrange
    await startedAssistant();
    const id = await abandoned(4);
    const heard: unknown[] = [];
    const stop = realtime().hub.subscribe((event) => void heard.push(event));

    // Act
    await sweepUploads(prisma);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();

    // Assert
    expect(heard).toContainEqual(expect.objectContaining({ type: "assistant_conversation", conversation_id: id }));
  });
});

describe("the refusals the composer words for the person", () => {
  it("should say which cap a refusal is, so the two 409s can be told apart", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    for (let index = 0; index < MAX_ATTACHMENTS_PER_MESSAGE; index += 1) {
      await startUpload(conversation.id, { name: `f${index}.pdf`, size: 4 });
    }

    // Act
    const fifth = await startUpload(conversation.id, { name: "f4.pdf", size: 4 });

    // Assert
    expect(fifth.status).toBe(409);
    expect(await jsonOf(fifth)).toEqual({ reason: "too_many_files", error: `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files` });
  });

  it("should give the conversation's cap its own reason, which the browser cannot work out in advance", async () => {
    // Arrange: a conversation already holding its whole allowance. It takes eight rows, because the per-row CHECK
    // caps one file at 25 MB; they are `fetched`, so the per-message count of four does not refuse this first.
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    for (let index = 0; index < MAX_CONVERSATION_BYTES / MAX_UPLOAD_BYTES; index += 1) {
      await prisma.assistantUpload.create({
        data: {
          conversationId: conversation.id,
          ownerOid: ALICE.oid,
          messageId: null,
          fileName: `big${index}.zip`,
          storedName: `big${index}.zip`,
          mediaType: "application/zip",
          bytes: BigInt(MAX_UPLOAD_BYTES),
          state: "fetched"
        }
      });
    }

    // Act
    const refused = await startUpload(conversation.id, { name: "one.pdf", size: 4 });

    // Assert
    expect(refused.status).toBe(409);
    expect(await jsonOf(refused)).toEqual({
      reason: "conversation_full",
      error: "this conversation's files add up to at most 200 MB"
    });
  });

  it("should give a reason for each of the other refusals the composer has to render", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: PART_BYTES + 10 }));

    // Act
    const tooBig = await startUpload(conversation.id, { name: "huge.zip", size: MAX_UPLOAD_BYTES + 1 });
    const unknown = await ui(discardRoute.DELETE, {
      path: "/api/ui/uploads/99999999-9999-9999-9999-999999999999",
      params: { uploadId: "99999999-9999-9999-9999-999999999999" },
      method: "DELETE"
    });
    const partTooBig = await putPart(created.uploadId, 0, filled(PART_BYTES + 1, 9));
    const partWrong = await putPart(created.uploadId, 0, filled(10, 9));
    const noConversation = await ui(uploadRoute.POST, {
      path: "/api/ui/uploads",
      method: "POST",
      json: { conversationId: "99999999-9999-9999-9999-999999999999", name: "a.pdf", size: 4, mediaType: "application/pdf" }
    });

    // Assert
    expect([tooBig.status, unknown.status, partTooBig.status, partWrong.status, noConversation.status]).toEqual([400, 404, 413, 400, 404]);
    expect(await jsonOf<{ reason: string }>(tooBig)).toMatchObject({ reason: "file_too_big" });
    expect(await jsonOf<{ reason: string }>(unknown)).toMatchObject({ reason: "no_such_upload" });
    expect(await jsonOf<{ reason: string }>(partTooBig)).toMatchObject({ reason: "part_too_big" });
    expect(await jsonOf<{ reason: string }>(partWrong)).toMatchObject({ reason: "part_wrong_length" });
    expect(await jsonOf<{ reason: string }>(noConversation)).toMatchObject({ reason: "no_such_conversation" });
  });

  /**
   * The composer is the same one for both kinds of chat, so a person can attach a file to a session running on their
   * own computer. There is nothing to deliver it to: attachments ride the `assistant` frame of a direct, which only a
   * pod conversation's agent is sent, and that session reads files off its own disk anyway. Refused while the person
   * is still holding the file, rather than taken and left in Postgres for the sweep with nothing said.
   */
  it("should refuse a file for a conversation with no pod and still take one for a conversation with a pod", async () => {
    // Arrange
    await startedAssistant();
    const pods = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const agent = await prisma.agent.create({ data: { ownerOid: ALICE.oid, sessionId: "alices-laptop", name: "alices-laptop" }, select: { id: true } });
    const laptop = (await linkLocalSession(prisma, { ownerOid: ALICE.oid, agentId: agent.id, name: "alices-laptop" }))!;

    // Act
    const refused = await startUpload(laptop.id, { name: "notes.pdf", size: 4 });
    const taken = await startUpload(pods.id, { name: "notes.pdf", size: 4 });

    // Assert
    expect(refused.status).toBe(409);
    expect(await jsonOf(refused)).toEqual({ reason: "local_session", error: "a conversation that is a session on your own computer takes no files" });
    expect(taken.status).toBe(201);
    expect(await prisma.assistantUpload.count({ where: { conversationId: laptop.id } })).toBe(0);
  });

  it("should say the feature is unavailable rather than nothing without virtual agents", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    // Act
    const refused = await startUpload(conversation.id, { name: "a.pdf", size: 4 });

    // Assert
    expect(refused.status).toBe(404);
    expect(await jsonOf(refused)).toEqual({ reason: "unavailable", error: "attaching files is not available on this deployment" });
  });

  it("should answer 204 with no body when an upload is discarded, which is what the composer ignores the status of", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: 4 }));

    // Act
    const discarded = await ui(discardRoute.DELETE, {
      path: `/api/ui/uploads/${created.uploadId}`,
      params: { uploadId: created.uploadId },
      method: "DELETE"
    });

    // Assert
    expect(discarded.status).toBe(204);
    expect(await discarded.text()).toBe("");
    expect(await prisma.assistantUpload.count({ where: { id: created.uploadId } })).toBe(0);
  });
});

/**
 * The server half of the new-chat screen surviving a remount. The screen holds no copy of any of this: the bytes are
 * in Postgres against the conversation and the product is on its row, so the hub is asked rather than the browser.
 */
describe("the unsent new chat the screen comes back to", () => {
  it("should answer the conversation, its product and its finished files", async () => {
    // Arrange
    await startedAssistant();
    const opened = await actions.openConversation({ product: "pcs" });
    const id = (opened as { id: string }).id;
    const first = await upload(id, "scanned letter.pdf", filled(6, 1));
    const second = await upload(id, "notes.txt", filled(3, 2));

    // Act
    const resumed = await unsentChat(prisma, ALICE.oid);

    // Assert
    expect(resumed).toEqual({
      id,
      product: "pcs",
      attachments: [
        { id: first, name: "scanned letter.pdf", bytes: 6, media_type: "application/pdf", available_until: expect.any(String) },
        { id: second, name: "notes.txt", bytes: 3, media_type: "application/pdf", available_until: expect.any(String) }
      ]
    });
  });

  it("should answer nothing once the message has been sent, the moment the draft is discarded too", async () => {
    // The two have to agree: text coming back without the file it belonged with is the bug this prevents.
    // Arrange
    await startedAssistant();
    const opened = await actions.openConversation({ product: "pcs" });
    const id = (opened as { id: string }).id;
    const uploadId = await upload(id, "letter.pdf", filled(6, 1));

    // Act
    await actions.sendAssistantMessage({ conversationId: id, body: "what does this say?", uploadIds: [uploadId] });

    // Assert
    expect(await unsentChat(prisma, ALICE.oid)).toBeUndefined();
  });

  it("should answer nothing when the only file never finished uploading, since a half-sent file cannot be sent", async () => {
    // Arrange
    await startedAssistant();
    const opened = await actions.openConversation({ product: "pcs" });
    const id = (opened as { id: string }).id;
    await startUpload(id, { name: "half.pdf", size: PART_BYTES + 10 });

    // Act & Assert
    expect(await unsentChat(prisma, ALICE.oid)).toBeUndefined();
  });

  it("should answer nothing once the person has removed the only chip", async () => {
    // Arrange
    await startedAssistant();
    const opened = await actions.openConversation({ product: "pcs" });
    const id = (opened as { id: string }).id;
    const uploadId = await upload(id, "letter.pdf", filled(6, 1));

    // Act
    await ui(discardRoute.DELETE, { path: `/api/ui/uploads/${uploadId}`, params: { uploadId }, method: "DELETE" });

    // Assert
    expect(await unsentChat(prisma, ALICE.oid)).toBeUndefined();
  });

  it("should answer the newest when more than one was left unsent, since only one screen is composing", async () => {
    // Arrange
    await startedAssistant();
    const older = ((await actions.openConversation({ product: "ccd" })) as { id: string }).id;
    await upload(older, "old.pdf", filled(6, 1));
    await prisma.assistantConversation.update({ where: { id: older }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const newer = ((await actions.openConversation({ product: "pcs" })) as { id: string }).id;
    await upload(newer, "new.pdf", filled(6, 2));

    // Act & Assert
    expect(await unsentChat(prisma, ALICE.oid)).toMatchObject({ id: newer, product: "pcs" });
  });

  it("should never answer with somebody else's unsent chat", async () => {
    // Arrange
    await startedAssistant();
    const opened = ((await actions.openConversation({ product: "pcs" })) as { id: string }).id;
    await upload(opened, "letter.pdf", filled(6, 1));

    // Act & Assert
    expect(await unsentChat(prisma, BOB.oid)).toBeUndefined();
  });

  it("should answer nothing for a conversation that was spoken in and has a file still unsent", async () => {
    // A chat with a message in it is not the new-chat screen's to resume; its own page shows it.
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "hello" });
    await upload(conversation.id, "later.pdf", filled(6, 1));

    // Act & Assert
    expect(await unsentChat(prisma, ALICE.oid)).toBeUndefined();
  });
});

describe("the sweep and a conversation whose file was removed", () => {
  it("should delete one left empty by removing the only chip, which nothing else would ever collect", async () => {
    // Arrange: attached, then thought better of it. The upload row is gone, so a sweep that required one would
    // leave this conversation showing as a "New chat" the person cannot account for, for ever.
    await startedAssistant();
    const opened = ((await actions.openConversation({ product: "pcs" })) as { id: string }).id;
    const uploadId = await upload(opened, "letter.pdf", filled(6, 1));
    await ui(discardRoute.DELETE, { path: `/api/ui/uploads/${uploadId}`, params: { uploadId }, method: "DELETE" });
    await prisma.assistantConversation.update({ where: { id: opened }, data: { createdAt: new Date(Date.now() - 5 * 3_600_000) } });

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 1 });
    expect(await prisma.assistantConversation.count({ where: { id: opened } })).toBe(0);
  });

  it("should leave an empty conversation made within the window alone, since a screen may still be composing in it", async () => {
    // Arrange
    await startedAssistant();
    const opened = ((await actions.openConversation({ product: "pcs" })) as { id: string }).id;

    // Act
    const result = await sweepUploads(prisma);

    // Assert
    expect(result).toMatchObject({ conversations: 0 });
    expect(await prisma.assistantConversation.count({ where: { id: opened } })).toBe(1);
  });
});
