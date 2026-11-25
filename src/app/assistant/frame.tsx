import { cookies } from "next/headers";
import { deleteConversation, pinConversation, renameConversation, saveAssistantModel, startConversation } from "@/app/_actions/assistant";
import { deleteAllAssistantFiles, deleteAssistantFile } from "@/app/_actions/assistant-files";
import { readAssistantAgent, readGitIdentity, readSchedule, saveSchedule } from "@/app/_actions/assistant-settings";
import { pinBulkScanSpec, removeBulkScanSpec, renameBulkScanSpec } from "@/app/_actions/bulk-scan";
import { clearGitIdentity, removeCredential, resetClaudeMd, saveClaudeMd, saveCredential, saveGitIdentity } from "@/app/_actions/credentials";
import { saveExportDefaults } from "@/app/_actions/export-defaults";
import { archiveFeedbackProject, pinFeedbackProject } from "@/app/_actions/feedback";
import { createFolder, moveConversationToFolder } from "@/app/_actions/folders";
import { deleteTemplate, saveTemplate } from "@/app/_actions/templates";
import { pasteLoginCode, reconnectSignIn, restartVirtualAgent, saveVirtualAgentPod } from "@/app/_actions/virtual-agents";
import { SHARING_SETTINGS } from "@/app/assistant/sharing";
import { connectionsData } from "@/assistant/connections";
import { savedCredentialsData } from "@/assistant/saved-credentials";
import { assistantPluginsData } from "@/assistant/settings";
import { SIDEBAR_COOKIE, sidebarCollapsedOf } from "@/assistant/sidebar";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE } from "@/assistant/waiting";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { feedbackEnabled } from "@/feedback/settings";
import type { Viewer } from "@/viewer/identity";
import { assistantExportDefaults, assistantFiles, assistantModel, assistantSize, assistantTemplates, claudeMdSettings, openAssistant } from "@/web/data";

const ROW_ACTIONS: ConversationActions = {
  rename: renameConversation,
  pin: pinConversation,
  remove: deleteConversation,
  pinFeedback: pinFeedbackProject,
  archiveFeedback: archiveFeedbackProject,
  renameForm: renameBulkScanSpec,
  pinForm: pinBulkScanSpec,
  removeForm: removeBulkScanSpec
};

/** What every Assistant page's shell is drawn from, read once per request: the sidebar, the settings and the viewer's cookies. */
export async function loadFrame(viewer: Viewer) {
  const jar = await cookies();
  const [home, claudeMd, mine, files, size, defaults, model] = await Promise.all([
    openAssistant(viewer),
    claudeMdSettings(viewer),
    assistantTemplates(viewer),
    assistantFiles(viewer),
    assistantSize(viewer),
    assistantExportDefaults(viewer),
    assistantModel(viewer)
  ]);
  // The sign-in the settings' searches and a chat's document panel export with.
  const atlassian = {
    connected: home.credentials.available && home.credentials.statuses.some((status) => status.kind === "atlassian" && status.stored),
    login: home.assistant.logins.find((login) => login.kind === "atlassian") ?? null
  };
  return {
    viewerName: viewer.name,
    theme: themeOf(jar.get(THEME_COOKIE)?.value),
    collapsed: sidebarCollapsedOf(jar.get(SIDEBAR_COOKIE)?.value),
    waiting: jar.get(WAITING_COOKIE)?.value,
    home,
    claudeMd,
    mine,
    files,
    size,
    defaults,
    model,
    atlassian
  };
}

/** The Assistant's sidebar and settings around `children`, from what `loadFrame` read. `activeId` is the sidebar row shown as the current one. */
export function AssistantShellFrame({
  frame,
  activeId = null,
  children
}: Readonly<{ frame: Awaited<ReturnType<typeof loadFrame>>; activeId?: string | null; children: React.ReactNode }>) {
  const { home, claudeMd, mine, files, size, defaults, model, atlassian } = frame;
  const plugins = assistantPluginsData(home.assistant, home.plugins);
  const pluginSettings = plugins && { ...plugins, save: saveVirtualAgentPod };
  return (
    <AssistantShell
      viewerName={frame.viewerName}
      groups={home.conversations}
      activeId={activeId}
      theme={frame.theme}
      collapsed={frame.collapsed}
      actions={ROW_ACTIONS}
      folders={{ list: home.folders, create: createFolder, move: moveConversationToFolder }}
      connections={connectionsData(home.assistant, home.credentials)}
      viewerRoute={home.credentials.modelRoute}
      connect={{ assistantId: home.assistant.id, running: home.assistant.desired === "running", reconnect: reconnectSignIn, paste: pasteLoginCode }}
      now={Date.now()}
      plugins={pluginSettings}
      welsh={home.welsh}
      briefing={home.briefing}
      feedback={feedbackEnabled()}
      mentions={home.mentions}
      start={startConversation}
      claudeMd={{ settings: claudeMd, save: saveClaudeMd, reset: resetClaudeMd }}
      templates={{ mine, save: saveTemplate, remove: deleteTemplate }}
      files={files === undefined ? undefined : { view: files, remove: deleteAssistantFile, removeAll: deleteAllAssistantFiles }}
      size={size === undefined ? undefined : { view: size, assistantId: home.assistant.id, save: saveVirtualAgentPod }}
      model={model === undefined ? undefined : { ...model, save: saveAssistantModel }}
      exports={{ defaults, save: saveExportDefaults, access: atlassian }}
      sharing={SHARING_SETTINGS}
      agent={{ load: readAssistantAgent, restart: restartVirtualAgent }}
      git={{ load: readGitIdentity, save: saveGitIdentity, clear: clearGitIdentity }}
      schedule={{ load: readSchedule, save: saveSchedule }}
      tokens={{ ...savedCredentialsData(home.credentials, home.assistant.modelRoute), save: saveCredential, remove: removeCredential }}
    >
      {children}
    </AssistantShell>
  );
}

/**
 * The frame of the Assistant's pages that are not a chat: the sidebar and settings around the page, in a scrolling pane.
 * It holds no getting-ready gate, since nothing here runs on the person's assistant. `activeId` is the id of the sidebar
 * row the page is about, shown as the current one. A page reads `loadFrame` beside its own data.
 */
export function AssistantFrame({
  frame,
  activeId = null,
  children
}: Readonly<{ frame: Awaited<ReturnType<typeof loadFrame>>; activeId?: string | null; children: React.ReactNode }>) {
  return (
    <AssistantShellFrame frame={frame} activeId={activeId}>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </AssistantShellFrame>
  );
}
