import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { openConversation, sendAssistantMessage, setConversationProduct, startConversation } from "@/app/_actions/assistant";
import { deleteFolder, renameFolder } from "@/app/_actions/folders";
import { AssistantShellFrame, loadFrame } from "@/app/assistant/frame";
import { folderHref } from "@/assistant/folders";
import { STARTERS } from "@/assistant/starters";
import { offeredTemplates } from "@/assistant/templates";
import { AssistantGate } from "@/components/assistant/AssistantGate";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { requireViewer } from "@/viewer/current";
import { assistantFolder, assistantFolderName, unsentNewChat } from "@/web/data";

export const dynamic = "force-dynamic";

const CHAT_ACTIONS: EmptyChatActions = {
  start: startConversation,
  open: openConversation,
  send: sendAssistantMessage,
  setProduct: setConversationProduct
};

export async function generateMetadata({ params }: Readonly<{ params: Promise<{ folderId: string }> }>): Promise<Metadata> {
  return { title: (await assistantFolderName(await requireViewer(), (await params).folderId)) ?? "Folder" };
}

/**
 * One of the viewer's folders: a new chat that starts in it, and the chats already in it. Not found for a folder
 * that is not theirs, as a conversation is.
 */
export default async function FolderPage({ params }: Readonly<{ params: Promise<{ folderId: string }> }>) {
  const viewer = await requireViewer();
  const { folderId } = await params;
  const folder = await assistantFolder(viewer, folderId);
  if (folder === undefined) {
    notFound();
  }
  const [frame, unsent] = await Promise.all([loadFrame(viewer), unsentNewChat(viewer, folder.id)]);
  const { home, mine, theme } = frame;
  return (
    <AssistantShellFrame frame={frame} activeId={folderHref(folder.id)}>
      <AssistantGate home={home} waiting={frame.waiting} theme={theme}>
        <EmptyChat
          // Keyed on the folder, so moving between folders' pages starts each with its own product and draft.
          key={folder.id}
          starters={STARTERS}
          templates={offeredTemplates(mine)}
          skills={home.skills}
          viewerOid={viewer.oid}
          unsent={unsent}
          actions={CHAT_ACTIONS}
          folder={{ ...folder, rename: renameFolder, remove: deleteFolder }}
        />
      </AssistantGate>
    </AssistantShellFrame>
  );
}
