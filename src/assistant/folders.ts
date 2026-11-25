/**
 * What a folder is allowed to be called, and how many a person may have. A folder is only a label on a
 * person's own chats: it carries nothing to their sessions.
 *
 * Pure, so the rules are unit-tested; `folder-store.ts` holds the reads and writes that apply them.
 */

/**
 * Where a folder's own page is, which is also the `activeId` it passes, so its sidebar row reads as open. Here rather
 * than beside the sidebar's list, so the server's page can call it as well as the client's row.
 */
export function folderHref(id: string): string {
  return `/assistant/folders/${id}`;
}

/** The longest name a folder can carry. */
export const FOLDER_NAME_MAX = 80;

/** How many folders one person may have; far more than a sidebar section is useful for, so it only bounds the list. */
export const FOLDER_LIMIT = 100;

/** The name as stored: trimmed, with runs of whitespace as one space. */
export function folderName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim().replace(/\s+/g, " ");
  return name === "" || name.length > FOLDER_NAME_MAX ? null : name;
}

/** What the person is told when the name is refused. */
export const FOLDER_NAME_RULE = `a folder name is 1 to ${FOLDER_NAME_MAX} characters`;

/**
 * Each folder with its chats, from one list of chats in any folder: each chat goes under the folder it names, keeping
 * the list's own order, and a chat naming a folder not given is left out.
 */
export function withChats<F extends { id: string }, C extends { folderId: string | null }>(folders: readonly F[], chats: readonly C[]): (F & { chats: C[] })[] {
  const byFolder = new Map<string, C[]>();
  for (const chat of chats) {
    if (chat.folderId === null) {
      continue;
    }
    const filed = byFolder.get(chat.folderId);
    if (filed === undefined) {
      byFolder.set(chat.folderId, [chat]);
    } else {
      filed.push(chat);
    }
  }
  return folders.map((folder) => ({ ...folder, chats: byFolder.get(folder.id) ?? [] }));
}

/** Folders in the order the sidebar lists them: by name, as a person reads it, then by id so ties never move. */
export function byFolderName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  const named = a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" });
  if (named !== 0) {
    return named;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
