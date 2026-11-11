import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  deleteConversation,
  exportArtefactToConfluence,
  exportArtefactToGithub,
  exportArtefactToJira,
  pinConversation,
  renameConversation,
  saveArtefact,
  saveAssistantModel,
  sendAssistantMessage,
  setConversationProduct,
  startConversation,
  stopAssistantAnswer,
  warmConversation
} from "@/app/_actions/assistant";
import { deleteAllAssistantFiles, deleteAssistantFile } from "@/app/_actions/assistant-files";
import { readAssistantAgent, readGitIdentity } from "@/app/_actions/assistant-settings";
import { clearGitIdentity, removeCredential, resetClaudeMd, saveClaudeMd, saveCredential, saveGitIdentity } from "@/app/_actions/credentials";
import { restoreDeckVersion, saveDeck } from "@/app/_actions/decks";
import { saveExportDefaults } from "@/app/_actions/export-defaults";
import { offerChatFork, withdrawChatFork } from "@/app/_actions/forks";
import { answerAgentQuestion } from "@/app/_actions/questions";
import { shareChat, unshareChat } from "@/app/_actions/shares";
import { deleteTemplate, saveTemplate } from "@/app/_actions/templates";
import { pasteLoginCode, reconnectSignIn, restartVirtualAgent, saveVirtualAgentPod } from "@/app/_actions/virtual-agents";
import { SHARING_SETTINGS } from "@/app/assistant/sharing";
import { connectionsData } from "@/assistant/connections";
import { savedCredentialsData } from "@/assistant/saved-credentials";
import { assistantPluginsData } from "@/assistant/settings";
import { offeredTemplates } from "@/assistant/templates";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE } from "@/assistant/waiting";
import { AssistantGate } from "@/components/assistant/AssistantGate";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import { ShareGate } from "@/components/assistant/ShareGate";
import { requireViewer } from "@/viewer/current";
import {
  assistantConversation,
  assistantExportDefaults,
  assistantFiles,
  assistantModel,
  assistantSize,
  assistantTemplates,
  chatForks,
  chatShares,
  claudeMdSettings,
  openAssistant
} from "@/web/data";

export const dynamic = "force-dynamic";

const ACTIONS: ChatActions = {
  send: sendAssistantMessage,
  warm: warmConversation,
  stop: stopAssistantAnswer,
  setProduct: setConversationProduct,
  rename: renameConversation,
  pin: pinConversation,
  remove: deleteConversation,
  answerQuestion: answerAgentQuestion,
  saveArtefact,
  exportToJira: exportArtefactToJira,
  exportToGithub: exportArtefactToGithub,
  exportToConfluence: exportArtefactToConfluence,
  restoreDeck: restoreDeckVersion,
  saveDeck
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
  const forking = !sharing && query.fork === "1";
  const [home, view, claudeMd, mine, shares, forks, files, size, defaults, model] = await Promise.all([
    openAssistant(viewer),
    assistantConversation(viewer, conversationId),
    claudeMdSettings(viewer),
    assistantTemplates(viewer),
    sharing ? chatShares(viewer, conversationId) : undefined,
    forking ? chatForks(viewer, conversationId) : undefined,
    assistantFiles(viewer),
    assistantSize(viewer),
    assistantExportDefaults(viewer),
    assistantModel(viewer)
  ]);
  if (view === undefined) {
    notFound();
  }
  const jira = {
    connected: home.credentials.available && home.credentials.statuses.some((status) => status.kind === "atlassian" && status.stored),
    login: home.assistant.logins.find((login) => login.kind === "atlassian") ?? null
  };
  const plugins = assistantPluginsData(home.assistant, home.plugins);
  const pluginSettings = plugins && { ...plugins, save: saveVirtualAgentPod };
  return (
    <AssistantShell
      viewerName={viewer.name}
      groups={home.conversations}
      activeId={view.id}
      theme={theme}
      actions={ACTIONS}
      connections={connectionsData(home.assistant, home.credentials)}
      viewerRoute={home.credentials.modelRoute}
      connect={{ assistantId: home.assistant.id, running: home.assistant.desired === "running", reconnect: reconnectSignIn, paste: pasteLoginCode }}
      now={Date.now()}
      plugins={pluginSettings}
      welsh={home.welsh}
      briefing={home.briefing}
      start={startConversation}
      claudeMd={{ settings: claudeMd, save: saveClaudeMd, reset: resetClaudeMd }}
      templates={{ mine, save: saveTemplate, remove: deleteTemplate }}
      files={files === undefined ? undefined : { view: files, remove: deleteAssistantFile, removeAll: deleteAllAssistantFiles }}
      size={size === undefined ? undefined : { view: size, assistantId: home.assistant.id, save: saveVirtualAgentPod }}
      model={model === undefined ? undefined : { ...model, save: saveAssistantModel }}
      exports={{ defaults, save: saveExportDefaults, access: jira }}
      sharing={SHARING_SETTINGS}
      agent={{ load: readAssistantAgent, restart: restartVirtualAgent }}
      git={{ load: readGitIdentity, save: saveGitIdentity, clear: clearGitIdentity }}
      tokens={{ ...savedCredentialsData(home.credentials, home.assistant.modelRoute), save: saveCredential, remove: removeCredential }}
    >
      {/* `local` so a chat on the person's own computer is not held behind credentials only a pod needs. */}
      <AssistantGate home={home} waiting={jar.get(WAITING_COOKIE)?.value} theme={theme} local={view.local}>
        {/* Keyed on the agent, which a /clear in the session replaces, so the thread starts again from its page. */}
        <ChatView key={view.agentId} view={view} templates={offeredTemplates(mine)} viewerOid={viewer.oid} actions={ACTIONS} jira={jira} defaults={defaults} />
      </AssistantGate>
      <ShareGate conversationId={view.id} open={sharing} people={shares ?? []} share={shareChat} unshare={unshareChat} />
      <ShareGate mode="fork" conversationId={view.id} open={forking} people={forks ?? []} share={offerChatFork} unshare={withdrawChatFork} />
    </AssistantShell>
  );
}
