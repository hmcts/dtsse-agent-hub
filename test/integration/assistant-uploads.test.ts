// Files attached to an HMCTS Assistant message, end to end through Postgres: the browser's parts, the message that
// claims them, the frame that names them, the pod's fetch, and the sweep that is the backstop for all of it.
//
// The memory assertion in "the hub's memory" is the point of the transport's design and not a formality: every byte
// of an upload crosses a heap capped at 768 MB on two replicas, so one part at a time has to be measured rather than
// reasoned about.
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as attachmentFetchedRoute from "../../src/app/api/agent/[agentId]/attachments/[uploadId]/fetched/route.ts";
import * as attachmentPartRoute from "../../src/app/api/agent/[agentId]/attachments/[uploadId]/parts/[index]/route.ts";
import * as streamRoute from "../../src/app/api/agent/[agentId]/stream/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as partRoute from "../../src/app/api/ui/uploads/[uploadId]/parts/[index]/route.ts";
import * as discardRoute from "../../src/app/api/ui/uploads/[uploadId]/route.ts";
import * as uploadRoute from "../../src/app/api/ui/uploads/route.ts";
import * as conversationsRoute from "../../src/app/api/virtual/[virtualAgentId]/conversations/route.ts";
import { createConversation, ensureAssistant } from "../../src/assistant/store.ts";
import { sweepUploads } from "../../src/assistant/upload-sweep.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_CONVERSATION_BYTES, MAX_UPLOAD_BYTES, PART_BYTES } from "../../src/assistant/uploads.ts";
import { realtime } from "../../src/realtime/process.ts";
import { DEV_PERSONA_COOKIE } from "../../src/viewer/identity.ts";
import { type ClaimResult, createVirtualAgent } from "../../src/virtual-agents/store.ts";
import { insertUser, type Person, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/assistant.ts");

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

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("ASSISTANT_UPLOADS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
  await resetDatabase();
  actAs("alice");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

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
    expect(await jsonOf(response)).toEqual({ error: `this part of the file is larger than ${PART_BYTES} bytes` });
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
    expect(await jsonOf(response)).toEqual({ error: `part 0 of this file is ${PART_BYTES} bytes` });
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
    expect(await jsonOf(response)).toEqual({ error: `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files` });
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
    await createVirtualAgent(prisma, { owner: BOB, modelRoute: "bedrock", name: "bobs" });
    const bobs = await createConversation(prisma, BOB.oid, { product: "pcs" });

    // Act
    const response = await startUpload(bobs.id, { name: "a.pdf", size: 4 });

    // Assert
    expect(response.status).toBe(404);
  });

  it("should answer 404 for every upload route while the flag is off", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const created = await jsonOf<Created>(await startUpload(conversation.id, { name: "a.pdf", size: 4 }));
    vi.stubEnv("ASSISTANT_UPLOADS_ENABLED", "false");

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
    await createVirtualAgent(prisma, { owner: BOB, modelRoute: "bedrock", name: "bobs" });
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
      { id: first, name: "letter.pdf", bytes: 6, media_type: "application/pdf" },
      { id: second, name: "scan.png", bytes: 3, media_type: "application/pdf" }
    ]);
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

  it("should leave attachments off the frame entirely while the flag is off, so an older pod is never sent one", async () => {
    // Arrange
    const { token } = await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const uploadId = await upload(conversation.id, "letter.pdf", filled(6, 1));
    await actions.sendAssistantMessage({ conversationId: conversation.id, body: "read this", uploadIds: [uploadId] });
    const { agentId, sessionId } = await sessionOf(conversation.id);
    await register(token, sessionId, conversation.id);
    vi.stubEnv("ASSISTANT_UPLOADS_ENABLED", "false");

    // Act
    const abort = new AbortController();
    const stream = frames(await pod(streamRoute.GET, token, `/api/agent/${agentId}/stream`, { agentId }, "GET", undefined, abort.signal));
    const [direct] = await stream.named("direct", 1);
    abort.abort();
    await stream.cancel();

    // Assert
    const { assistant } = JSON.parse(direct!.data!);
    expect(assistant).toMatchObject({ conversation_id: conversation.id, product: "pcs" });
    expect("attachments" in assistant).toBe(false);
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

  it("should delete every part row when the pod reports it has the file, and keep the metadata", async () => {
    // Arrange
    const { token, agentId, uploadId } = await attached();

    // Act
    const response = await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST");

    // Assert
    expect(response.status).toBe(204);
    expect(await prisma.assistantUploadPart.count({ where: { uploadId } })).toBe(0);
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

  it("should stop serving parts once they have been reported fetched", async () => {
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

  it("should answer 404 on both pod routes while the flag is off", async () => {
    // Arrange
    const { token, agentId, uploadId } = await attached();
    vi.stubEnv("ASSISTANT_UPLOADS_ENABLED", "false");

    // Act & Assert
    expect((await pod(attachmentPartRoute.GET, token, partPath(agentId, uploadId, 0), { agentId, uploadId, index: "0" })).status).toBe(404);
    expect((await pod(attachmentFetchedRoute.POST, token, `/api/agent/${agentId}/attachments/${uploadId}/fetched`, { agentId, uploadId }, "POST")).status).toBe(
      404
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
    expect(conversations.map((conversation) => conversation.id).sort()).toEqual([one.id, two.id].sort());
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

  it("should drop the bytes of anything nothing fetched in time and leave a recent upload alone", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    const abandoned = await stale(conversation.id, 5, "stored");
    const neverFinished = await stale(conversation.id, 5, "pending");
    const recent = await stale(conversation.id, 1, "stored");

    // Act
    const result = await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(result).toEqual({ expired: 2, parts: 2 });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: abandoned } })).toMatchObject({ state: "expired" });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: neverFinished } })).toMatchObject({ state: "expired" });
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: recent } })).toMatchObject({ state: "stored" });
    expect(await prisma.assistantUploadPart.findMany({ select: { uploadId: true } })).toEqual([{ uploadId: recent }]);
  });

  it("should keep the metadata row, so the thread can still say a file was attached", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await stale(conversation.id, 5, "stored");

    // Act
    await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(await prisma.assistantUpload.count()).toBe(1);
  });

  it("should do nothing at all when every upload was fetched or is recent", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await stale(conversation.id, 99, "fetched");

    // Act
    const result = await sweepUploads(prisma, { retentionHours: 3 });

    // Assert
    expect(result).toEqual({ expired: 0, parts: 0 });
  });

  it("should take only a batch at a time, so a backlog drains over several ticks", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    for (let n = 0; n < 3; n += 1) {
      await stale(conversation.id, 5, "stored");
    }

    // Act
    const first = await sweepUploads(prisma, { retentionHours: 3, batch: 2 });
    const second = await sweepUploads(prisma, { retentionHours: 3, batch: 2 });

    // Assert
    expect(first).toEqual({ expired: 2, parts: 2 });
    expect(second).toEqual({ expired: 1, parts: 1 });
  });

  it("should leave the sweep to the other pod when one already holds the lock", async () => {
    // Arrange
    await startedAssistant();
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
    await stale(conversation.id, 5, "stored");

    // Act: two sweeps in one transaction each, started together, so one finds the advisory lock taken.
    const [one, two] = await Promise.all([sweepUploads(prisma, { retentionHours: 3 }), sweepUploads(prisma, { retentionHours: 3 })]);

    // Assert
    expect([one, two].filter((result) => result === undefined).length).toBeLessThanOrEqual(1);
    expect(await prisma.assistantUploadPart.count()).toBe(0);
  });
});

const MB = 1024 * 1024;

/**
 * The retained memory, not the allocated: a forced collection first, so what is left is what is still reachable.
 * `vitest.integration.config.mts` gives the worker `--expose-gc` for this; without it the reading is churn and says
 * nothing about what is held.
 *
 * `arrayBuffers` is counted as well as `heapUsed`, and is the half that matters here: a `Uint8Array` of a part's
 * worth of bytes has its backing store outside the V8 object heap, so `heapUsed` alone cannot see a buffered body at
 * all and would report a reader holding every file as using nothing.
 */
function retained(): number {
  (global as { gc?: () => void }).gc?.();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** Uploads `parts` parts of one file, one request at a time, from a buffer the caller owns. */
async function sequentially(created: Created, parts: number, body: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let index = 0; index < parts; index += 1) {
    const response = await putPart(created.uploadId, index, body);
    if (!response.ok) {
      throw new Error(`part ${index} was refused: ${response.status}`);
    }
  }
}

const CONCURRENT_UPLOADS = 4;

/**
 * The most the process retained at any moment while `CONCURRENT_UPLOADS` files of `parts` parts each were uploaded
 * together, one part in flight per file. Every body is the same shared buffer, so the test's own contribution is a
 * fixed 4 MiB whatever the file size is.
 */
async function peakWhileUploading(conversationId: string, parts: number, body: Uint8Array<ArrayBuffer>): Promise<number> {
  const size = PART_BYTES * parts;
  const files = await Promise.all(
    Array.from({ length: CONCURRENT_UPLOADS }, async (_unused, n) => await jsonOf<Created>(await startUpload(conversationId, { name: `f${n}.pdf`, size })))
  );
  let peak = retained();
  const sampler = setInterval(() => {
    peak = Math.max(peak, retained());
  }, 10);
  try {
    await Promise.all(files.map((created) => sequentially(created, parts, body)));
  } finally {
    clearInterval(sampler);
  }
  for (const created of files) {
    expect(await prisma.assistantUpload.findUniqueOrThrow({ where: { id: created.uploadId } })).toMatchObject({ state: "stored" });
  }
  return peak;
}

describe("the hub's memory", () => {
  it("should cost no more for a large file than a small one when several uploads run at once", async () => {
    // Arrange: the same four concurrent uploads at two file sizes, 4 MB and 24 MB. What is asserted is not an absolute
    // ceiling — a part costs several copies between undici, the reader and the Postgres driver, and Node's allocator
    // holds freed external memory for reuse, so the absolute figure is large and noisy either way. What distinguishes
    // a reader that holds one part from one that holds the body it was given is whether the peak follows the *file*
    // size: six times the file for the same number of requests in flight.
    expect((global as { gc?: () => void }).gc, "the measurement needs --expose-gc; see vitest.integration.config.mts").toBeTypeOf("function");
    await startedAssistant();
    const body = filled(PART_BYTES, 7);
    // A conversation of its own per measurement: four files at once is already the per-message cap, and none of these
    // is ever sent, so they stay unattached and a second round in the same conversation would be refused.
    const peak = async (parts: number) => {
      const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs" });
      return await peakWhileUploading(conversation.id, parts, body);
    };

    // Act: each size measured twice and the lower reading kept. The noise in this figure is all upward — a collection
    // the sampler happened to catch late — so the minimum is much the steadier of the two statistics.
    const small = Math.min(await peak(1), await peak(1));
    const large = Math.min(await peak(6), await peak(6));

    // Assert
    const measured = `${CONCURRENT_UPLOADS} concurrent uploads peaked at ${(small / MB).toFixed(0)} MB retained for ${PART_BYTES / MB} MB files and ${(large / MB).toFixed(0)} MB for ${(PART_BYTES * 6) / MB} MB files`;
    // Printed, not only asserted: this is the measurement the transport was accepted on, so a run should say what it
    // actually was rather than only that it passed.
    console.info(measured);
    // Measured: the two readings stay within about 20 MB of each other however the files are sized. A reader that
    // kept each body would add CONCURRENT_UPLOADS × 20 MB — 80 MB, and 83 MB when that was deliberately tried — so
    // the allowance of two parts per upload in flight sits well above the noise and well below the signal.
    expect(large, measured).toBeLessThan(small + CONCURRENT_UPLOADS * PART_BYTES * 2);
  });

  it("should not take a whole file into memory when a client streams one at a single part", async () => {
    // Arrange: the failure this transport is guarded against. A client that sends its whole 24 MB file at part 0 is
    // refused, but a reader built on `request.arrayBuffer()` would have all 24 MB in memory before it could refuse.
    // The body is generated chunk by chunk from one small buffer, so the test holds no copy of it and the only thing
    // the measurement can see is what the route itself keeps.
    expect((global as { gc?: () => void }).gc, "the measurement needs --expose-gc; see vitest.integration.config.mts").toBeTypeOf("function");
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
