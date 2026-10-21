import { notFound } from "next/navigation";
import { deleteConversation, renameConversation, saveArtefact, sendAssistantMessage, setConversationProduct, warmConversation } from "@/app/_actions/assistant";
import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode } from "@/app/_actions/virtual-agents";
import { TEMPLATES } from "@/assistant/starters";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { requireViewer } from "@/viewer/current";
import { assistantConversation, openAssistant } from "@/web/data";

export const dynamic = "force-dynamic";

const ACTIONS: ChatActions = {
  send: sendAssistantMessage,
  warm: warmConversation,
  setProduct: setConversationProduct,
  rename: renameConversation,
  remove: deleteConversation,
  saveArtefact
};

/** One of the viewer's conversations. Anyone else's, or one deleted, is not found. */
export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const viewer = await requireViewer();
  const { conversationId } = await params;
  const [home, view] = await Promise.all([openAssistant(viewer), assistantConversation(viewer, conversationId)]);
  if (view === undefined) {
    notFound();
  }
  return (
    <AssistantShell viewerName={viewer.name} groups={home.conversations} activeId={view.id} hubLink>
      {/* Keyed on the agent, which a /clear in the session replaces, so the thread starts again from its page. */}
      <ChatView key={view.agentId} view={view} templates={TEMPLATES} actions={ACTIONS} />
      <OnboardingGate
        assistant={home.assistant}
        statuses={home.credentials.available ? home.credentials.statuses : []}
        unavailable={home.credentials.available ? null : home.credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
      />
    </AssistantShell>
  );
}
