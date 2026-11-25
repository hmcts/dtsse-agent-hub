import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, ConversationNotFound, SELECT, toRow } from "./conversation-row.ts";
import { byFolderName, FOLDER_LIMIT, FOLDER_NAME_RULE, folderName } from "./folders.ts";

/**
 * A person's folders: listing, creating, renaming and deleting them, and moving a chat into one or out of it.
 * Every folder belongs to one person, and only their own chats go in it; someone else's folder or chat is reported
 * as missing, as a conversation is.
 */

export interface Folder {
  id: string;
  name: string;
}

export class FolderNotFound extends HttpError {
  constructor() {
    super(404, "no such folder");
  }
}

/** The owner's folders, by name. Ordered before the limit too, so which folders come back never depends on the plan. */
export async function listFolders(db: Database, ownerOid: string): Promise<Folder[]> {
  const rows = await db.assistantFolder.findMany({
    where: { ownerOid },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: FOLDER_LIMIT
  });
  return rows.sort(byFolderName);
}

/** The folder, if `ownerOid` owns it. */
export async function findFolder(db: Database, ownerOid: string, id: string): Promise<Folder | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.assistantFolder.findFirst({ where: { id, ownerOid }, select: { id: true, name: true } });
  return row ?? undefined;
}

/**
 * The folder's id once it is known to be the owner's; `null` stays null, for no folder. Called inside the transaction
 * that files a chat in it, whose `FOR SHARE` holds a concurrent delete of the folder until that transaction ends, so
 * the chat is never filed in a folder that has just gone: either the delete waits, or this answers that it is missing.
 */
export async function ownedFolderId(db: Database, ownerOid: string, id: string | null): Promise<string | null> {
  if (id === null) {
    return null;
  }
  if (!isUuid(id)) {
    throw new FolderNotFound();
  }
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM assistant_folder WHERE id = ${id}::uuid AND owner_oid = ${ownerOid} FOR SHARE
  `;
  if (row === undefined) {
    throw new FolderNotFound();
  }
  return row.id;
}

function nameOf(value: unknown): string {
  const name = folderName(value);
  if (name === null) {
    throw new HttpError(400, FOLDER_NAME_RULE);
  }
  return name;
}

/**
 * Makes a folder, unless the owner has as many as they may have. The count and the insert run under a lock on the owner
 * for the transaction, so two made at once cannot both pass the count and take them past the limit.
 */
export async function createFolder(prisma: PrismaClient, ownerOid: string, name: unknown): Promise<Folder> {
  const checked = nameOf(name);
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('assistant_folder'), hashtext(${ownerOid}))`;
    if ((await tx.assistantFolder.count({ where: { ownerOid } })) >= FOLDER_LIMIT) {
      throw new HttpError(409, `you can have up to ${FOLDER_LIMIT} folders; delete one to make another`);
    }
    return await tx.assistantFolder.create({ data: { ownerOid, name: checked }, select: { id: true, name: true } });
  });
}

export async function renameFolder(db: Database, ownerOid: string, id: string, name: unknown): Promise<void> {
  const checked = nameOf(name);
  if (!isUuid(id)) {
    throw new FolderNotFound();
  }
  const { count } = await db.assistantFolder.updateMany({ where: { id, ownerOid }, data: { name: checked, updatedAt: new Date() } });
  if (count === 0) {
    throw new FolderNotFound();
  }
}

/**
 * Deletes the folder. Its chats are kept, out of any folder, which the foreign key's `ON DELETE SET NULL` does, and
 * each is announced, so the owner's other tabs stop listing it under the folder.
 */
export async function deleteFolder(prisma: PrismaClient, ownerOid: string, id: string): Promise<void> {
  if (!isUuid(id)) {
    throw new FolderNotFound();
  }
  await prisma.$transaction(async (tx) => {
    const chats = await tx.assistantConversation.findMany({ where: { folderId: id, ownerOid }, select: SELECT });
    const { count } = await tx.assistantFolder.deleteMany({ where: { id, ownerOid } });
    if (count === 0) {
      throw new FolderNotFound();
    }
    for (const chat of chats) {
      await announce(tx, toRow(chat));
    }
  });
}

/** Puts the owner's chat in one of their folders, or in none when `folderId` is null. */
export async function moveConversation(prisma: PrismaClient, ownerOid: string, conversationId: string, folderId: string | null): Promise<void> {
  if (!isUuid(conversationId)) {
    throw new ConversationNotFound();
  }
  await prisma.$transaction(async (tx) => {
    const row = await tx.assistantConversation.findFirst({ where: { id: conversationId, ownerOid }, select: SELECT });
    if (row === null) {
      throw new ConversationNotFound();
    }
    const target = await ownedFolderId(tx, ownerOid, folderId);
    await tx.assistantConversation.update({ where: { id: conversationId }, data: { folderId: target, updatedAt: new Date() } });
    await announce(tx, toRow(row));
  });
}
