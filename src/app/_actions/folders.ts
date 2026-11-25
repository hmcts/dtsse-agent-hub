"use server";

import { revalidatePath } from "next/cache";
import { createFolder as create, moveConversation as move, deleteFolder as remove, renameFolder as rename } from "@/assistant/folder-store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { virtualAgentsEnabled } from "@/virtual-agents/settings";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * The signed-in person's folders. Each action re-reads the viewer and hands that oid to the store as the owner,
 * so the only folders and chats a request can reach are the requester's own.
 *
 * Each revalidates `/assistant` as a layout, because the sidebar lists the folders on every page of it.
 */

const OFF: { ok: false; error: string } = { ok: false, error: "the CFT Workspace is not available on this deployment" };

function revalidate(): void {
  revalidatePath("/assistant", "layout");
}

export async function createFolder(input: { name: unknown }): Promise<ActionResult<{ id: string }>> {
  return await runAction<{ id: string }>("create folder", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const folder = await create(prisma, viewer.oid, input.name);
    revalidate();
    return { ok: true, id: folder.id };
  });
}

export async function renameFolder(input: { folderId: unknown; name: unknown }): Promise<ActionResult> {
  return await runAction("rename folder", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await rename(prisma, viewer.oid, text(input.folderId), input.name);
    revalidate();
    return { ok: true };
  });
}

/** Deletes the folder and keeps its chats, which are then in no folder. */
export async function deleteFolder(input: { folderId: unknown }): Promise<ActionResult> {
  return await runAction("delete folder", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    await remove(prisma, viewer.oid, text(input.folderId));
    revalidate();
    return { ok: true };
  });
}

/** Puts one of the viewer's chats in one of their folders, or takes it out of any when `folderId` is null. */
export async function moveConversationToFolder(input: { conversationId: unknown; folderId: unknown }): Promise<ActionResult> {
  return await runAction("move chat", async () => {
    if (!virtualAgentsEnabled()) {
      return OFF;
    }
    const viewer = await requireViewer();
    const folderId = input.folderId === null ? null : text(input.folderId);
    await move(prisma, viewer.oid, text(input.conversationId), folderId);
    revalidate();
    return { ok: true };
  });
}
