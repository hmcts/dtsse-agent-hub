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

/** The owner's folders, by name. */
export async function listFolders(db: Database, ownerOid: string): Promise<Folder[]> {
  const rows = await db.assistantFolder.findMany({ where: { ownerOid }, select: { id: true, name: true }, take: FOLDER_LIMIT });
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

/** The folder's id once it is known to be the owner's; `null` stays null, for no folder. */
export async function ownedFolderId(db: Database, ownerOid: string, id: string | null): Promise<string | null> {
  if (id === null) {
    return null;
  }
  const folder = await findFolder(db, ownerOid, id);
  if (folder === undefined) {
    throw new FolderNotFound();
  }
  return folder.id;
}

function nameOf(value: unknown): string {
  const name = folderName(value);
  if (name === null) {
    throw new HttpError(400, FOLDER_NAME_RULE);
  }
  return name;
}

export async function createFolder(db: Database, ownerOid: string, name: unknown): Promise<Folder> {
  const checked = nameOf(name);
  if ((await db.assistantFolder.count({ where: { ownerOid } })) >= FOLDER_LIMIT) {
    throw new HttpError(409, `you can have up to ${FOLDER_LIMIT} folders; delete one to make another`);
  }
  return await db.assistantFolder.create({ data: { ownerOid, name: checked }, select: { id: true, name: true } });
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

/** Deletes the folder. Its chats are kept, out of any folder, which the foreign key's `ON DELETE SET NULL` does. */
export async function deleteFolder(db: Database, ownerOid: string, id: string): Promise<void> {
  if (!isUuid(id)) {
    throw new FolderNotFound();
  }
  const { count } = await db.assistantFolder.deleteMany({ where: { id, ownerOid } });
  if (count === 0) {
    throw new FolderNotFound();
  }
}

/** Puts the owner's chat in one of their folders, or in none when `folderId` is null. */
export async function moveConversation(prisma: PrismaClient, ownerOid: string, conversationId: string, folderId: string | null): Promise<void> {
  if (!isUuid(conversationId)) {
    throw new ConversationNotFound();
  }
  const target = await ownedFolderId(prisma, ownerOid, folderId);
  await prisma.$transaction(async (tx) => {
    const row = await tx.assistantConversation.findFirst({ where: { id: conversationId, ownerOid }, select: SELECT });
    if (row === null) {
      throw new ConversationNotFound();
    }
    await tx.assistantConversation.update({ where: { id: conversationId }, data: { folderId: target, updatedAt: new Date() } });
    await announce(tx, toRow(row));
  });
}
