import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  deleteConversation,
  exportArtefactToConfluence,
  exportArtefactToGithub,
  exportArtefactToJira,
  pinConversation,
  removeArtefact,
  removeDocmosisTemplate,
  removeNotifyTemplate,
  renameConversation,
  saveArtefact,
  sendAssistantMessage,
  setConversationProduct,
  stopAssistantAnswer,
  warmConversation
} from "@/app/_actions/assistant";
import { removeDeck, restoreDeckVersion, saveDeck } from "@/app/_actions/decks";
import { moveConversationToFolder } from "@/app/_actions/folders";
import { offerChatFork, withdrawChatFork } from "@/app/_actions/forks";
import { answerAgentQuestion } from "@/app/_actions/questions";
import { shareChat, unshareChat } from "@/app/_actions/shares";
import { startAssistant } from "@/app/_actions/virtual-agents";
import { AssistantShellFrame, loadFrame } from "@/app/assistant/frame";
import { offeredTemplates } from "@/assistant/templates";
import { AssistantGate } from "@/components/assistant/AssistantGate";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { ShareGate } from "@/components/assistant/ShareGate";
import { requireViewer } from "@/viewer/current";
import { assistantConversation, assistantConversationTitle, chatForks, chatShares } from "@/web/data";

export const dynamic = "force-dynamic";

const ACTIONS: ChatActions = {
  startAssistant,
  send: sendAssistantMessage,
  warm: warmConversation,
  stop: stopAssistantAnswer,
  setProduct: setConversationProduct,
  rename: renameConversation,
  pin: pinConversation,
  remove: deleteConversation,
  move: moveConversationToFolder,
  answerQuestion: answerAgentQuestion,
  removeArtefact,
  removeDeck,
  removeDocmosisTemplate,
  removeNotifyTemplate,
  saveArtefact,
  exportToJira: exportArtefactToJira,
  exportToGithub: exportArtefactToGithub,
  exportToConfluence: exportArtefactToConfluence,
  restoreDeck: restoreDeckVersion,
  saveDeck
};

/** The tab title: "CFT - " and the conversation's name. A missing one gets the default and the page answers not found. */
export async function generateMetadata({ params }: { params: Promise<{ conversationId: string }> }): Promise<Metadata> {
  const title = await assistantConversationTitle(await requireViewer(), (await params).conversationId);
  return title === undefined ? {} : { title: title.trim() || "New chat" };
}

/** One of the viewer's conversations. Anyone else's, or one deleted, is not found. */
export default async function ConversationPage({
  params,
  searchParams
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireViewer();
  const { conversationId } = await params;
  const query = await searchParams;
  // Who the chat is shared with is read only when the dialog is being shown, and then beside the rest: it is two
  // queries to fill a dialog, and this is the page that loads most often.
  const sharing = query.share === "1";
  const forking = !sharing && query.fork === "1";
  const [frame, view, shares, forks] = await Promise.all([
    loadFrame(viewer),
    assistantConversation(viewer, conversationId),
    sharing ? chatShares(viewer, conversationId) : undefined,
    forking ? chatForks(viewer, conversationId) : undefined
  ]);
  if (view === undefined) {
    notFound();
  }
  const { home, mine, defaults, theme, atlassian: jira } = frame;
  return (
    <AssistantShellFrame frame={frame} activeId={view.id}>
      {/* `local` so a chat on the person's own computer is not held behind credentials only a pod needs. */}
      <AssistantGate home={home} waiting={frame.waiting} theme={theme} local={view.local}>
        {/* Keyed on the agent, which a /clear in the session replaces, so the thread starts again from its page. */}
        <ChatView
          key={view.agentId}
          view={view}
          templates={offeredTemplates(mine)}
          viewerOid={viewer.oid}
          actions={ACTIONS}
          jira={jira}
          defaults={defaults}
          folders={home.folders}
        />
      </AssistantGate>
      <ShareGate conversationId={view.id} open={sharing} people={shares ?? []} share={shareChat} unshare={unshareChat} />
      <ShareGate mode="fork" conversationId={view.id} open={forking} people={forks ?? []} share={offerChatFork} unshare={withdrawChatFork} />
    </AssistantShellFrame>
  );
}
