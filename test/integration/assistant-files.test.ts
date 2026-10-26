// The copies of a person's attachments on their assistant's own volume, end to end through Postgres: the pod's
// report, what the settings read from it, who may read and clear it, and the handshake that ends a deletion request.
//
// The pod's own half — measuring the volume and deleting the files — is in the client package's
// `src/assistant/disk.test.ts` and `src/assistant/attachments.test.ts`.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation, ensureAssistant } from "../../src/assistant/store.ts";
import { pendingUploadDeletions, reportedUploadIds, reportUploadsOnDisk, requestUploadRemoval, uploadsOnDisk } from "../../src/assistant/upload-disk.ts";
import { devIdentity, type Viewer } from "../../src/viewer/identity.ts";
import { assistantFiles } from "../../src/web/data.ts";
import { connect, insertUser, type Person, prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/assistant-files.ts");

function persona(name: string): Person {
  const identity = devIdentity(name);
  return { oid: identity.oid, name: identity.name, email: identity.email! };
}

const ALICE = persona("alice");
const BOB = persona("bob");

const viewer = (who: Person): Viewer => ({ ...who, tid: "dev", modelRoute: "own-licence" });

const client = await connect();

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await resetDatabase();
  actAs("alice");
});

/**
 * The person's assistant, running, with its own session registered as its current agent — which is where the `files`
 * claim lives, because the supervisor is what reports and what deletes, not a conversation's session.
 */
async function assistantOf(who: Person, features: string[] | null = ["files"], status: "running" | "stopped" = "running"): Promise<string> {
  await insertUser(who);
  const assistant = await ensureAssistant(prisma, viewer(who));
  const agent = await prisma.agent.create({
    data: {
      ownerOid: who.oid,
      sessionId: `${who.oid}-pod`,
      name: "assistant",
      virtualAgentId: assistant.id,
      ...(features === null ? {} : { clientFeatures: features })
    },
    select: { id: true }
  });
  await prisma.virtualAgent.update({ where: { id: assistant.id }, data: { status, agentId: agent.id } });
  return assistant.id;
}

/** An attachment that reached a message, as a pod would have fetched it, with one part row still held. */
async function sentUpload(who: Person, conversationId: string, name: string, bytes: number): Promise<string> {
  const message = await prisma.message.create({
    data: { kind: "direct", body: `I have attached ${name}.`, authorOid: who.oid },
    select: { id: true }
  });
  const upload = await prisma.assistantUpload.create({
    data: {
      conversationId,
      ownerOid: who.oid,
      messageId: message.id,
      fileName: name,
      storedName: name,
      mediaType: "application/pdf",
      bytes: BigInt(bytes),
      state: "fetched"
    },
    select: { id: true }
  });
  await prisma.assistantUploadPart.create({ data: { uploadId: upload.id, index: 0, data: new Uint8Array(4) } });
  return upload.id;
}

async function chat(who: Person, title: string): Promise<string> {
  const conversation = await createConversation(prisma, who.oid, { title });
  return conversation.id;
}

function report(files: { upload_id: string; bytes: number }[], uploadsBytes = files.reduce((total, file) => total + file.bytes, 0)) {
  return { uploads_bytes: uploadsBytes, volume_used_bytes: 30 * 1024 ** 3, volume_total_bytes: 32 * 1024 ** 3, files };
}

async function uploadRow(id: string) {
  return await prisma.assistantUpload.findUniqueOrThrow({
    where: { id },
    select: { state: true, podDeleteRequestedAt: true, podDeletedAt: true, _count: { select: { parts: true } } }
  });
}

describe("the files on an assistant's disk", () => {
  it("should show what the pod reported, dated, with each file named from its own row", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);

    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    const view = await uploadsOnDisk(prisma, ALICE.oid, assistant);

    expect(view?.disk).toMatchObject({ reported: true, uploadsBytes: 2048, volumeUsedBytes: 30 * 1024 ** 3, volumeTotalBytes: 32 * 1024 ** 3, stopped: false });
    expect(view?.files).toEqual([
      { uploadId: upload, name: "bundle.pdf", bytes: 2048, conversationId: conversation, conversationTitle: "Possession claim", deleting: false }
    ]);
  });

  // The totals are the truth about the disk; an id the hub has no row for has nothing a person could be told about
  // it, so it is counted and not listed.
  it("should count a file it has no row for towards the size, and leave it out of the list", async () => {
    const assistant = await assistantOf(ALICE);

    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: "0f8a6a1e-0000-4000-8000-00000000dead", bytes: 4096 }]));
    const view = await uploadsOnDisk(prisma, ALICE.oid, assistant);

    expect(view?.disk).toMatchObject({ reported: true, uploadsBytes: 4096 });
    expect(view?.files).toEqual([]);
  });

  // Never zero for "we have not heard": that would read as "you have no files".
  it("should report nothing, rather than an empty disk, before the pod has said anything", async () => {
    const assistant = await assistantOf(ALICE);

    expect((await uploadsOnDisk(prisma, ALICE.oid, assistant))?.disk).toEqual({ reported: false, reason: "waiting" });
  });

  it("should say the client is too old when the pod's own session never claimed the feature", async () => {
    const assistant = await assistantOf(ALICE, null);

    expect((await uploadsOnDisk(prisma, ALICE.oid, assistant))?.disk).toEqual({ reported: false, reason: "older_client" });
  });

  it("should say nothing has looked when the assistant is stopped and has never reported", async () => {
    const assistant = await assistantOf(ALICE, ["files"], "stopped");

    expect((await uploadsOnDisk(prisma, ALICE.oid, assistant))?.disk).toEqual({ reported: false, reason: "not_running" });
  });

  it("should replace the last report, not add to it, when the pod reports again", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);

    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    await reportUploadsOnDisk(prisma, assistant, report([]));

    expect(await uploadsOnDisk(prisma, ALICE.oid, assistant)).toMatchObject({ files: [], disk: { reported: true, uploadsBytes: 0 } });
  });
});

describe("asking an assistant to delete its files", () => {
  it("should drop the hub's own bytes at once and leave the request for the pod, when the owner deletes one", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));

    expect(await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload])).toBe("requested");

    // The hub's copy is gone for good, which is what stops the thread offering a download back.
    expect(await uploadRow(upload)).toMatchObject({ state: "expired", podDeletedAt: null, _count: { parts: 0 } });
    expect(await pendingUploadDeletions(prisma, assistant)).toEqual([{ conversation_id: conversation, upload_ids: [upload] }]);
    expect((await uploadsOnDisk(prisma, ALICE.oid, assistant))?.files[0]?.deleting).toBe(true);
  });

  // The row stays whatever happens: the thread goes on saying a file was attached.
  it("should keep the upload row when the pod confirms the file is gone", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload]);

    await reportUploadsOnDisk(prisma, assistant, report([]));

    expect(await uploadRow(upload)).toMatchObject({ state: "expired" });
    expect((await uploadRow(upload)).podDeletedAt).not.toBeNull();
    expect(await pendingUploadDeletions(prisma, assistant)).toEqual([]);
  });

  // A request for a file the pod never had has nothing to carry out, and would otherwise be replayed for ever.
  it("should end a request the pod's next report does not name at all, whether it deleted it or never had it", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload]);

    await reportUploadsOnDisk(prisma, assistant, report([]));

    expect((await uploadsOnDisk(prisma, ALICE.oid, assistant))?.deleting).toBe(0);
  });

  // A pod that failed its deletion reports the file again, and asking a second time has to mean something.
  it("should take a fresh request for a file the pod reported back after one was already confirmed", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload]);
    await reportUploadsOnDisk(prisma, assistant, report([]));
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));

    await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload]);

    expect(await pendingUploadDeletions(prisma, assistant)).toEqual([{ conversation_id: conversation, upload_ids: [upload] }]);
  });

  it("should group the outstanding requests by conversation, as one frame each, when they span chats", async () => {
    const assistant = await assistantOf(ALICE);
    const first = await chat(ALICE, "Possession claim");
    const second = await chat(ALICE, "Rent arrears");
    const here = await sentUpload(ALICE, first, "bundle.pdf", 2048);
    const there = await sentUpload(ALICE, second, "notes.txt", 64);
    await reportUploadsOnDisk(
      prisma,
      assistant,
      report([
        { upload_id: here, bytes: 2048 },
        { upload_id: there, bytes: 64 }
      ])
    );

    await requestUploadRemoval(prisma, ALICE.oid, assistant, [here, there]);

    expect(await pendingUploadDeletions(prisma, assistant)).toEqual([
      { conversation_id: [first, second].sort()[0], upload_ids: [[first, second].sort()[0] === first ? here : there] },
      { conversation_id: [first, second].sort()[1], upload_ids: [[first, second].sort()[1] === first ? here : there] }
    ]);
  });

  // The hub would otherwise have thrown its own bytes away to promise a deletion that silently never happens.
  it("should refuse the request, and keep the hub's bytes, when the pod's client cannot act on it", async () => {
    const assistant = await assistantOf(ALICE, ["attachments", "stop"]);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);

    expect(await requestUploadRemoval(prisma, ALICE.oid, assistant, [upload])).toBe("unsupported_client");
    expect(await uploadRow(upload)).toMatchObject({ state: "fetched", podDeleteRequestedAt: null, _count: { parts: 1 } });
    expect(await pendingUploadDeletions(prisma, assistant)).toEqual([]);
  });

  // No pod ever fetched it, so there is no copy of it on any disk to ask about.
  it("should refuse an upload that never reached a message", async () => {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const unsent = await prisma.assistantUpload.create({
      data: {
        conversationId: conversation,
        ownerOid: ALICE.oid,
        fileName: "draft.pdf",
        storedName: "draft.pdf",
        mediaType: "application/pdf",
        bytes: 10n,
        state: "stored"
      },
      select: { id: true }
    });

    expect(await requestUploadRemoval(prisma, ALICE.oid, assistant, [unsent.id])).toBe("no_such_upload");
    expect(await uploadRow(unsent.id)).toMatchObject({ state: "stored", podDeleteRequestedAt: null });
  });

  it("should refuse an id that names nothing at all", async () => {
    const assistant = await assistantOf(ALICE);

    expect(await requestUploadRemoval(prisma, ALICE.oid, assistant, ["0f8a6a1e-0000-4000-8000-00000000dead"])).toBe("no_such_upload");
  });
});

describe("who may see and clear an assistant's files", () => {
  async function alicesFile(): Promise<{ assistant: string; upload: string }> {
    const assistant = await assistantOf(ALICE);
    const conversation = await chat(ALICE, "Possession claim");
    const upload = await sentUpload(ALICE, conversation, "bundle.pdf", 2048);
    await reportUploadsOnDisk(prisma, assistant, report([{ upload_id: upload, bytes: 2048 }]));
    return { assistant, upload };
  }

  // A grant is over sessions a person chose to share, and what is on their assistant's volume is neither. The rule
  // in `src/access/rules.ts` is what refuses it, not the shape of a query.
  it("should tell somebody else nothing about an assistant's files, by the rule and not by the query", async () => {
    const { assistant } = await alicesFile();
    await insertUser(BOB);

    expect(await uploadsOnDisk(prisma, BOB.oid, assistant)).toBeUndefined();
    expect(await reportedUploadIds(prisma, BOB.oid, assistant)).toEqual([]);
  });

  it("should refuse somebody else clearing an assistant's file, and change nothing", async () => {
    const { assistant, upload } = await alicesFile();
    await insertUser(BOB);

    expect(await requestUploadRemoval(prisma, BOB.oid, assistant, [upload])).toBe("no_such_upload");
    expect(await uploadRow(upload)).toMatchObject({ state: "fetched", podDeleteRequestedAt: null, _count: { parts: 1 } });
  });

  it("should act on Bob's own assistant, not Alice's, when Bob posts the delete-everything action", async () => {
    const { assistant: alices, upload: hers } = await alicesFile();
    const bobs = await assistantOf(BOB);
    const conversation = await chat(BOB, "His chat");
    const his = await sentUpload(BOB, conversation, "his.pdf", 64);
    await reportUploadsOnDisk(prisma, bobs, report([{ upload_id: his, bytes: 64 }]));
    actAs("bob");

    expect(await actions.deleteAllAssistantFiles(new FormData())).toMatchObject({ ok: true });

    expect(await uploadRow(hers)).toMatchObject({ state: "fetched", podDeleteRequestedAt: null });
    expect((await uploadRow(his)).podDeleteRequestedAt).not.toBeNull();
    expect(await pendingUploadDeletions(prisma, alices)).toEqual([]);
  });

  it("should refuse a hand-rolled post naming somebody else's file", async () => {
    const { upload } = await alicesFile();
    await assistantOf(BOB);
    actAs("bob");

    const form = new FormData();
    form.set("id", upload);

    expect(await actions.deleteAssistantFile(form)).toEqual({ ok: false, error: "that is not one of your assistant's files" });
    expect(await uploadRow(upload)).toMatchObject({ state: "fetched", podDeleteRequestedAt: null });
  });

  it("should give the viewer their own assistant's files through the page's read seam", async () => {
    const { upload } = await alicesFile();

    expect((await assistantFiles(viewer(ALICE)))?.files.map((file) => file.uploadId)).toEqual([upload]);
  });

  // Every word of the confirmation is about which copy goes and when. "Deleted" would be a claim the hub cannot make.
  it("should promise when the assistant deletes its copy, and say the hub's own has gone, when one is deleted", async () => {
    const { upload } = await alicesFile();
    const form = new FormData();
    form.set("id", upload);

    const result = await actions.deleteAssistantFile(form);

    expect(result).toMatchObject({ ok: true });
    const confirmation = (result as { confirmation: string }).confirmation;
    expect(confirmation).toContain("within 10 minutes");
    expect(confirmation).toContain("no longer download it back");
  });

  it("should promise the next start, rather than ten minutes, when the assistant is stopped", async () => {
    const { assistant, upload } = await alicesFile();
    await prisma.virtualAgent.update({ where: { id: assistant }, data: { status: "stopped" } });
    const form = new FormData();
    form.set("id", upload);

    const result = await actions.deleteAssistantFile(form);

    expect((result as { confirmation: string }).confirmation).toContain("stopped, so it deletes that file the next time it starts");
  });

  it("should refuse the delete-everything action, saying so, when the pod has reported no files", async () => {
    await assistantOf(ALICE);

    expect(await actions.deleteAllAssistantFiles(new FormData())).toEqual({ ok: false, error: "your assistant has not reported any files to delete" });
  });

  it("should ignore a report for a virtual agent that does not exist", async () => {
    await expect(reportUploadsOnDisk(prisma, "0f8a6a1e-0000-4000-8000-00000000dead", report([]))).resolves.toBeUndefined();
  });
});
