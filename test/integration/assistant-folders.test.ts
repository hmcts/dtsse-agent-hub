import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import {
  createConversation,
  findConversation,
  folderConversations,
  folderedConversations,
  unsentConversation
} from "../../src/assistant/conversation-store.ts";
import { createFolder, deleteFolder, findFolder, listFolders, moveConversation, ownedFolderId, renameFolder } from "../../src/assistant/folder-store.ts";
import { FOLDER_LIMIT, FOLDER_NAME_MAX } from "../../src/assistant/folders.ts";
import { folderView, sidebarFolders, sidebarGroups } from "../../src/assistant/views.ts";
import { decodeEvent, HUB_CHANNEL } from "../../src/realtime/events.ts";
import { connect, insertUser, person, prisma, resetDatabase } from "./database.ts";

/** A person's folders: a label on their own chats, which nobody else's folder or chat can be given. */

const ALICE = person("alice");
const BOB = person("bob");
const NO_SUCH = "00000000-0000-0000-0000-000000000000";

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
  await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
  await ensureAssistant(prisma, { oid: BOB.oid, modelRoute: "own-licence" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A chat of `oid`'s with something in it, so the lists show it. */
async function chat(oid: string, folderId: string | null = null): Promise<string> {
  const conversation = await createConversation(prisma, oid, { product: "pcs", title: "A chat", folderId });
  await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { firstContentAt: new Date() } });
  return conversation.id;
}

async function folderOf(conversationId: string): Promise<string | null> {
  return (await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { folderId: true } })).folderId;
}

describe("folders", () => {
  it("should list only the owner's folders, by name", async () => {
    await createFolder(prisma, ALICE.oid, "welsh");
    await createFolder(prisma, ALICE.oid, "  Bulk   scan ");
    await createFolder(prisma, BOB.oid, "Bob's");

    expect((await listFolders(prisma, ALICE.oid)).map((folder) => folder.name)).toEqual(["Bulk scan", "welsh"]);
  });

  it("should refuse a blank or overlong name", async () => {
    await expect(createFolder(prisma, ALICE.oid, "  ")).rejects.toMatchObject({ status: 400 });
    await expect(createFolder(prisma, ALICE.oid, "a".repeat(FOLDER_NAME_MAX + 1))).rejects.toMatchObject({ status: 400 });
  });

  it("should refuse another folder when the owner has the most they may have", async () => {
    await prisma.assistantFolder.createMany({ data: Array.from({ length: FOLDER_LIMIT }, (_, at) => ({ ownerOid: ALICE.oid, name: `P${at}` })) });

    await expect(createFolder(prisma, ALICE.oid, "One more")).rejects.toMatchObject({ status: 409 });
    await expect(createFolder(prisma, BOB.oid, "Bob's first")).resolves.toMatchObject({ name: "Bob's first" });
  });

  it("should rename the owner's folder and report someone else's as missing", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "Old");

    await renameFolder(prisma, ALICE.oid, folder.id, "New");
    expect((await findFolder(prisma, ALICE.oid, folder.id))?.name).toBe("New");

    await expect(renameFolder(prisma, BOB.oid, folder.id, "Taken")).rejects.toMatchObject({ status: 404 });
    await expect(renameFolder(prisma, ALICE.oid, "not-a-uuid", "Taken")).rejects.toMatchObject({ status: 404 });
    await expect(renameFolder(prisma, ALICE.oid, folder.id, "")).rejects.toMatchObject({ status: 400 });
    expect((await findFolder(prisma, ALICE.oid, folder.id))?.name).toBe("New");
  });

  it("should not find someone else's folder, or an id that is not one", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "Mine");

    expect(await findFolder(prisma, BOB.oid, folder.id)).toBeUndefined();
    expect(await findFolder(prisma, ALICE.oid, "nope")).toBeUndefined();
    expect(await ownedFolderId(prisma, ALICE.oid, null)).toBeNull();
    await expect(ownedFolderId(prisma, BOB.oid, folder.id)).rejects.toMatchObject({ status: 404 });
  });

  it("should delete the folder and keep its chats, in no folder", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "Going");
    const kept = await chat(ALICE.oid, folder.id);

    await expect(deleteFolder(prisma, BOB.oid, folder.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteFolder(prisma, ALICE.oid, "nope")).rejects.toMatchObject({ status: 404 });
    await deleteFolder(prisma, ALICE.oid, folder.id);

    expect(await listFolders(prisma, ALICE.oid)).toEqual([]);
    expect(await findConversation(prisma, ALICE.oid, kept)).toBeDefined();
    expect(await folderOf(kept)).toBeNull();
  });
});

/** How many `assistant_conversation` announcements `act` makes, by conversation id. */
async function announced(act: () => Promise<unknown>): Promise<string[]> {
  const listener = await connect();
  try {
    const heard: string[] = [];
    listener.on("notification", (notification) => {
      const event = decodeEvent(notification.payload);
      if (event?.type === "assistant_conversation") {
        heard.push(event.conversation_id);
      }
    });
    await listener.query(`LISTEN ${HUB_CHANNEL}`);
    await act();
    await listener.query("SELECT 1");
    return heard;
  } finally {
    await listener.end();
  }
}

describe("folders made and deleted at once", () => {
  it("should not take the owner past the limit when two folders are made at the same moment", async () => {
    await prisma.assistantFolder.createMany({ data: Array.from({ length: FOLDER_LIMIT - 1 }, (_, at) => ({ ownerOid: ALICE.oid, name: `P${at}` })) });

    const results = await Promise.allSettled([createFolder(prisma, ALICE.oid, "One"), createFolder(prisma, ALICE.oid, "Two")]);

    expect(results.map((result) => result.status).sort((a, b) => a.localeCompare(b))).toEqual(["fulfilled", "rejected"]);
    expect(await prisma.assistantFolder.count({ where: { ownerOid: ALICE.oid } })).toBe(FOLDER_LIMIT);
  });

  it("should answer that the folder is missing when it is deleted while a chat is moved into it or started in it", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "Going");
    const conversation = await chat(ALICE.oid);
    const other = await connect();
    try {
      await other.query("BEGIN");
      await other.query("DELETE FROM assistant_folder WHERE id = $1", [folder.id]);
      const moving = moveConversation(prisma, ALICE.oid, conversation, folder.id);
      const starting = createConversation(prisma, ALICE.oid, { product: "pcs", folderId: folder.id });
      // Let both reach the folder's row lock before the delete commits.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await other.query("COMMIT");

      // Settled together: both reject at once, and awaiting one at a time leaves the other unhandled meanwhile.
      const [moved, started] = await Promise.allSettled([moving, starting]);
      expect(moved).toMatchObject({ status: "rejected", reason: { status: 404, message: "no such folder" } });
      expect(started).toMatchObject({ status: "rejected", reason: { status: 404, message: "no such folder" } });
    } finally {
      await other.end();
    }
    expect(await folderOf(conversation)).toBeNull();
  });

  it("should announce each chat a deleted folder held, so other tabs stop listing it there", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "Going");
    const held = [await chat(ALICE.oid, folder.id), await chat(ALICE.oid, folder.id)];
    await chat(ALICE.oid);

    const heard = await announced(() => deleteFolder(prisma, ALICE.oid, folder.id));

    expect(heard.sort((a, b) => a.localeCompare(b))).toEqual(held.sort((a, b) => a.localeCompare(b)));
  });
});

describe("chats in folders", () => {
  it("should read up to the limit of chats in each folder, the newest of each, rather than across them all", async () => {
    const busy = await createFolder(prisma, ALICE.oid, "Busy");
    const quiet = await createFolder(prisma, ALICE.oid, "Quiet");
    const busyChats = [await chat(ALICE.oid, busy.id), await chat(ALICE.oid, busy.id), await chat(ALICE.oid, busy.id)];
    const quietChat = await chat(ALICE.oid, quiet.id);
    await prisma.assistantConversation.update({ where: { id: quietChat }, data: { lastActiveAt: new Date("2020-01-01T00:00:00Z") } });
    for (const [at, id] of busyChats.entries()) {
      await prisma.assistantConversation.update({ where: { id }, data: { lastActiveAt: new Date(Date.UTC(2026, 0, 1 + at)) } });
    }

    const rows = await folderedConversations(prisma, ALICE.oid, 2);

    expect(rows.map((row) => [row.id, row.folderId])).toEqual([
      [busyChats[2], busy.id],
      [busyChats[1], busy.id],
      [quietChat, quiet.id]
    ]);
  });

  it("should start a chat in the owner's folder, and refuse someone else's", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "PCS");
    const conversation = await chat(ALICE.oid, folder.id);

    expect(await folderOf(conversation)).toBe(folder.id);
    await expect(createConversation(prisma, BOB.oid, { product: "pcs", folderId: folder.id })).rejects.toMatchObject({ status: 404 });
  });

  it("should move a chat into a folder and out again, announcing each move", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "PCS");
    const conversation = await chat(ALICE.oid);

    await moveConversation(prisma, ALICE.oid, conversation, folder.id);
    expect(await folderOf(conversation)).toBe(folder.id);

    await moveConversation(prisma, ALICE.oid, conversation, null);
    expect(await folderOf(conversation)).toBeNull();
  });

  it("should refuse to move someone else's chat, or into someone else's folder", async () => {
    const alices = await createFolder(prisma, ALICE.oid, "Alice's");
    const bobs = await createFolder(prisma, BOB.oid, "Bob's");
    const conversation = await chat(ALICE.oid);

    await expect(moveConversation(prisma, BOB.oid, conversation, bobs.id)).rejects.toMatchObject({ status: 404 });
    await expect(moveConversation(prisma, ALICE.oid, conversation, bobs.id)).rejects.toMatchObject({ status: 404 });
    await expect(moveConversation(prisma, ALICE.oid, "nope", alices.id)).rejects.toMatchObject({ status: 404 });
    await expect(moveConversation(prisma, ALICE.oid, NO_SUCH, alices.id)).rejects.toMatchObject({ status: 404 });
    await expect(moveConversation(prisma, ALICE.oid, conversation, "not-a-uuid")).rejects.toMatchObject({ status: 404, message: "no such folder" });
    expect(await folderOf(conversation)).toBeNull();
  });

  it("should list a folder's chats on its page, and say which folder each sidebar row is in", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "PCS");
    const inside = await chat(ALICE.oid, folder.id);
    const outside = await chat(ALICE.oid);

    expect((await folderConversations(prisma, ALICE.oid, folder.id)).map((row) => row.id)).toEqual([inside]);
    const view = await folderView(prisma, ALICE.oid, folder.id);
    expect(view).toMatchObject({ id: folder.id, name: "PCS", chats: [{ id: inside, folderId: folder.id }] });
    expect(await folderView(prisma, BOB.oid, folder.id)).toBeUndefined();

    const rows = (await sidebarGroups(prisma, ALICE.oid)).flatMap((group) => group.items);
    expect(rows.find((row) => row.id === inside)).toMatchObject({ folderId: folder.id });
    expect(rows.find((row) => row.id === outside)).toMatchObject({ folderId: null });
  });

  it("should give the sidebar each of the owner's folders with every chat in it, newest first, however old", async () => {
    const pcs = await createFolder(prisma, ALICE.oid, "PCS");
    const empty = await createFolder(prisma, ALICE.oid, "Empty");
    const older = await chat(ALICE.oid, pcs.id);
    const newer = await chat(ALICE.oid, pcs.id);
    await chat(ALICE.oid);
    await prisma.assistantConversation.update({ where: { id: older }, data: { lastActiveAt: new Date("2020-01-01T00:00:00Z") } });
    await prisma.assistantConversation.update({ where: { id: newer }, data: { title: null } });
    await chat(BOB.oid, (await createFolder(prisma, BOB.oid, "Bob's")).id);

    expect(await sidebarFolders(prisma, ALICE.oid)).toEqual([
      { id: empty.id, name: "Empty", chats: [] },
      {
        id: pcs.id,
        name: "PCS",
        chats: [
          { id: newer, title: "New chat" },
          { id: older, title: "A chat" }
        ]
      }
    ]);
  });

  it("should hand back an unsent chat only to the screen it was opened from", async () => {
    const folder = await createFolder(prisma, ALICE.oid, "PCS");
    const conversation = await createConversation(prisma, ALICE.oid, { product: "pcs", folderId: folder.id });
    await prisma.assistantUpload.create({
      data: {
        conversationId: conversation.id,
        ownerOid: ALICE.oid,
        fileName: "a.pdf",
        storedName: "a.pdf",
        mediaType: "application/pdf",
        bytes: 1n,
        state: "stored"
      }
    });

    expect((await unsentConversation(prisma, ALICE.oid, folder.id))?.id).toBe(conversation.id);
    expect(await unsentConversation(prisma, ALICE.oid)).toBeUndefined();
  });
});
