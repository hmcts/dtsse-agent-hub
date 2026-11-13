import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { deleteConversation, pinConversation, renameConversation, saveAssistantModel, startConversation } from "@/app/_actions/assistant";
import { deleteAllAssistantFiles, deleteAssistantFile } from "@/app/_actions/assistant-files";
import { readAssistantAgent, readGitIdentity } from "@/app/_actions/assistant-settings";
import { clearGitIdentity, removeCredential, resetClaudeMd, saveClaudeMd, saveCredential, saveGitIdentity } from "@/app/_actions/credentials";
import { saveExportDefaults } from "@/app/_actions/export-defaults";
import { archiveFeedbackProject, pinFeedbackProject } from "@/app/_actions/feedback";
import { deleteTemplate, saveTemplate } from "@/app/_actions/templates";
import { pasteLoginCode, reconnectSignIn, restartVirtualAgent, saveVirtualAgentPod } from "@/app/_actions/virtual-agents";
import { SHARING_SETTINGS } from "@/app/assistant/sharing";
import { connectionsData } from "@/assistant/connections";
import { savedCredentialsData } from "@/assistant/saved-credentials";
import { assistantPluginsData } from "@/assistant/settings";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { feedbackEnabled } from "@/feedback/settings";
import type { Viewer } from "@/viewer/identity";
import { assistantExportDefaults, assistantFiles, assistantModel, assistantSize, assistantTemplates, claudeMdSettings, openAssistant } from "@/web/data";

const ROW_ACTIONS: ConversationActions = {
  rename: renameConversation,
  pin: pinConversation,
  remove: deleteConversation,
  pinFeedback: pinFeedbackProject,
  archiveFeedback: archiveFeedbackProject
};

/** Not found while prototype feedback is off, so its pages say nothing about a feature that is not there. */
export function requireFeedback(): void {
  if (!feedbackEnabled()) {
    notFound();
  }
}

/**
 * The feedback pages' frame: the Assistant's sidebar and settings, as every Assistant page has them, around the page.
 * It holds no getting-ready gate, since nothing here runs on the person's assistant. `projectId` is the project the
 * page is about, whose row the sidebar shows as the current one.
 */
export async function FeedbackFrame({
  viewer,
  projectId = null,
  children
}: Readonly<{ viewer: Viewer; projectId?: string | null; children: React.ReactNode }>) {
  const jar = await cookies();
  const theme = themeOf(jar.get(THEME_COOKIE)?.value);
  const [home, claudeMd, mine, files, size, defaults, model] = await Promise.all([
    openAssistant(viewer),
    claudeMdSettings(viewer),
    assistantTemplates(viewer),
    assistantFiles(viewer),
    assistantSize(viewer),
    assistantExportDefaults(viewer),
    assistantModel(viewer)
  ]);
  const atlassian = {
    connected: home.credentials.available && home.credentials.statuses.some((status) => status.kind === "atlassian" && status.stored),
    login: home.assistant.logins.find((login) => login.kind === "atlassian") ?? null
  };
  const plugins = assistantPluginsData(home.assistant, home.plugins);
  const pluginSettings = plugins && { ...plugins, save: saveVirtualAgentPod };
  return (
    <AssistantShell
      viewerName={viewer.name}
      groups={home.conversations}
      activeId={projectId}
      theme={theme}
      actions={ROW_ACTIONS}
      connections={connectionsData(home.assistant, home.credentials)}
      viewerRoute={home.credentials.modelRoute}
      connect={{ assistantId: home.assistant.id, running: home.assistant.desired === "running", reconnect: reconnectSignIn, paste: pasteLoginCode }}
      now={Date.now()}
      plugins={pluginSettings}
      welsh={home.welsh}
      briefing={home.briefing}
      feedback={feedbackEnabled()}
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
      tokens={{ ...savedCredentialsData(home.credentials, home.assistant.modelRoute), save: saveCredential, remove: removeCredential }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </AssistantShell>
  );
}
