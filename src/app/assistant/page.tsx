import { cookies } from "next/headers";
import { startConversation } from "@/app/_actions/assistant";
import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode, setVirtualAgentPlugins } from "@/app/_actions/virtual-agents";
import { connectionsData } from "@/assistant/connections";
import { assistantPluginsData } from "@/assistant/settings";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE, waitingDismissed } from "@/assistant/waiting";
import { AssistantShell } from "@/components/assistant/AssistantShell";
import { EmptyChat } from "@/components/assistant/EmptyChat";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { requireViewer } from "@/viewer/current";
import { openAssistant } from "@/web/data";

export const dynamic = "force-dynamic";

/** A new chat. Opening it creates the viewer's assistant on their first visit, and starts it whenever it is stopped. */
export default async function AssistantPage() {
  const viewer = await requireViewer();
  const jar = await cookies();
  const theme = themeOf(jar.get(THEME_COOKIE)?.value);
  const home = await openAssistant(viewer);
  return (
    <AssistantShell
      viewerName={viewer.name}
      groups={home.conversations}
      activeId={null}
      hubLink
      theme={theme}
      connections={connectionsData(home.assistant, home.credentials)}
      plugins={{ ...assistantPluginsData(home.assistant, home.plugins), save: setVirtualAgentPlugins }}
    >
      <EmptyChat starters={STARTERS} templates={TEMPLATES} viewerOid={viewer.oid} start={startConversation} />
      <OnboardingGate
        assistant={home.assistant}
        statuses={home.credentials.available ? home.credentials.statuses : []}
        unavailable={home.credentials.available ? null : home.credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        dismissed={waitingDismissed(jar.get(WAITING_COOKIE)?.value, home.assistant.id, home.assistant.startedAt)}
        theme={theme}
      />
    </AssistantShell>
  );
}
