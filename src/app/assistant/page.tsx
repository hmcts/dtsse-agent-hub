import { cookies } from "next/headers";
import {
  deleteConversation,
  openConversation,
  renameConversation,
  sendAssistantMessage,
  setConversationModel,
  setConversationProduct,
  startConversation
} from "@/app/_actions/assistant";
import { deleteAllAssistantFiles, deleteAssistantFile } from "@/app/_actions/assistant-files";
import { resetClaudeMd, saveClaudeMd, saveCredential } from "@/app/_actions/credentials";
import { saveExportDefaults } from "@/app/_actions/export-defaults";
import { deleteTemplate, saveTemplate } from "@/app/_actions/templates";
import { pasteLoginCode, reconnectSignIn, resizeVirtualAgent, setVirtualAgentPlugins } from "@/app/_actions/virtual-agents";
import { connectionsData } from "@/assistant/connections";
import { assistantPluginsData } from "@/assistant/settings";
import { STARTERS } from "@/assistant/starters";
import { offeredTemplates } from "@/assistant/templates";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE, waitingDismissed } from "@/assistant/waiting";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { requireViewer } from "@/viewer/current";
import { assistantExportDefaults, assistantFiles, assistantSize, assistantTemplates, claudeMdSettings, openAssistant, unsentNewChat } from "@/web/data";

export const dynamic = "force-dynamic";

/** What the new-chat screen needs: it may open a conversation before the first message, to attach a file to. */
const CHAT_ACTIONS: EmptyChatActions = {
  start: startConversation,
  open: openConversation,
  send: sendAssistantMessage,
  setModel: setConversationModel,
  setProduct: setConversationProduct
};

/** What a conversation's row in the sidebar offers. */
const ROW_ACTIONS: ConversationActions = { rename: renameConversation, remove: deleteConversation };

/** A new chat. Opening it creates the viewer's assistant on their first visit, and starts it whenever it is stopped. */
export default async function AssistantPage() {
  const viewer = await requireViewer();
  const jar = await cookies();
  const theme = themeOf(jar.get(THEME_COOKIE)?.value);
  const [home, unsent, claudeMd, mine, files, size, defaults] = await Promise.all([
    openAssistant(viewer),
    unsentNewChat(viewer),
    claudeMdSettings(viewer),
    assistantTemplates(viewer),
    assistantFiles(viewer),
    assistantSize(viewer),
    assistantExportDefaults(viewer)
  ]);
  // The same sign-in the conversation page gives the document panel, for the settings' searches.
  const atlassian = {
    connected: home.credentials.available && home.credentials.statuses.some((status) => status.kind === "atlassian" && status.stored),
    login: home.assistant.logins.find((login) => login.kind === "atlassian") ?? null
  };
  const plugins = assistantPluginsData(home.assistant, home.plugins);
  const pluginSettings = plugins && { ...plugins, save: setVirtualAgentPlugins };
  return (
    <AssistantShell
      viewerName={viewer.name}
      groups={home.conversations}
      activeId={null}
      theme={theme}
      actions={ROW_ACTIONS}
      connections={connectionsData(home.assistant, home.credentials)}
      connect={{ assistantId: home.assistant.id, running: home.assistant.desired === "running", reconnect: reconnectSignIn }}
      now={Date.now()}
      plugins={pluginSettings}
      claudeMd={{ settings: claudeMd, save: saveClaudeMd, reset: resetClaudeMd }}
      templates={{ mine, save: saveTemplate, remove: deleteTemplate }}
      files={files === undefined ? undefined : { view: files, remove: deleteAssistantFile, removeAll: deleteAllAssistantFiles }}
      size={size === undefined ? undefined : { view: size, assistantId: home.assistant.id, save: resizeVirtualAgent }}
      exports={{ defaults, save: saveExportDefaults, access: atlassian }}
    >
      <EmptyChat
        starters={STARTERS}
        templates={offeredTemplates(mine)}
        viewerOid={viewer.oid}
        unsent={unsent}
        actions={CHAT_ACTIONS}
        models={home.assistant.models}
        defaultModel={home.assistant.defaultModel}
      />
      <OnboardingGate
        assistant={home.assistant}
        statuses={home.credentials.available ? home.credentials.statuses : []}
        unavailable={home.credentials.available ? null : home.credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        reconnect={reconnectSignIn}
        now={Date.now()}
        dismissed={waitingDismissed(jar.get(WAITING_COOKIE)?.value, home.assistant.id, home.assistant.startedAt)}
        theme={theme}
      />
    </AssistantShell>
  );
}
