import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  deleteConversation,
  renameConversation,
  saveArtefact,
  sendAssistantMessage,
  setConversationProduct,
  stopAssistantAnswer,
  warmConversation
} from "@/app/_actions/assistant";
import { resetClaudeMd, saveClaudeMd, saveCredential } from "@/app/_actions/credentials";
import { shareChat, unshareChat } from "@/app/_actions/shares";
import { deleteTemplate, saveTemplate } from "@/app/_actions/templates";
import { pasteLoginCode, setVirtualAgentPlugins } from "@/app/_actions/virtual-agents";
import { connectionsData } from "@/assistant/connections";
import { assistantPluginsData } from "@/assistant/settings";
import { offeredTemplates } from "@/assistant/templates";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE, waitingDismissed } from "@/assistant/waiting";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { ShareGate } from "@/components/assistant/ShareGate";
import { requireViewer } from "@/viewer/current";
import { assistantConversation, assistantTemplates, chatShares, claudeMdSettings, openAssistant } from "@/web/data";

export const dynamic = "force-dynamic";

const ACTIONS: ChatActions = {
  send: sendAssistantMessage,
  warm: warmConversation,
  stop: stopAssistantAnswer,
  setProduct: setConversationProduct,
  rename: renameConversation,
  remove: deleteConversation,
  saveArtefact
};

/** One of the viewer's conversations. Anyone else's, or one deleted, is not found. */
export default async function ConversationPage({
  params,
  searchParams
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await requireViewer();
  const jar = await cookies();
  const theme = themeOf(jar.get(THEME_COOKIE)?.value);
  const { conversationId } = await params;
  const query = await searchParams;
  // Who the chat is shared with is read only when the dialog is being shown, and then beside the rest: it is two
  // queries to fill a dialog, and this is the page that loads most often.
  const sharing = query.share === "1";
  const [home, view, claudeMd, mine, shares] = await Promise.all([
    openAssistant(viewer),
    assistantConversation(viewer, conversationId),
    claudeMdSettings(viewer),
    assistantTemplates(viewer),
    sharing ? chatShares(viewer, conversationId) : undefined
  ]);
  if (view === undefined) {
    notFound();
  }
  const plugins = assistantPluginsData(home.assistant, home.plugins);
  const pluginSettings = plugins && { ...plugins, save: setVirtualAgentPlugins };
  return (
    <AssistantShell
      viewerName={viewer.name}
      groups={home.conversations}
      activeId={view.id}
      theme={theme}
      actions={ACTIONS}
      connections={connectionsData(home.assistant, home.credentials)}
      plugins={pluginSettings}
      claudeMd={{ settings: claudeMd, save: saveClaudeMd, reset: resetClaudeMd }}
      templates={{ mine, save: saveTemplate, remove: deleteTemplate }}
    >
      {/* Keyed on the agent, which a /clear in the session replaces, so the thread starts again from its page. */}
      <ChatView key={view.agentId} view={view} templates={offeredTemplates(mine)} viewerOid={viewer.oid} actions={ACTIONS} />
      <OnboardingGate
        assistant={home.assistant}
        statuses={home.credentials.available ? home.credentials.statuses : []}
        unavailable={home.credentials.available ? null : home.credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        dismissed={waitingDismissed(jar.get(WAITING_COOKIE)?.value, home.assistant.id, home.assistant.startedAt)}
        theme={theme}
      />
      <ShareGate conversationId={view.id} open={sharing} people={shares ?? []} share={shareChat} unshare={unshareChat} />
    </AssistantShell>
  );
}
