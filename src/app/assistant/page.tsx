import { cookies } from "next/headers";
import { deleteConversation, renameConversation, startConversation } from "@/app/_actions/assistant";
import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode } from "@/app/_actions/virtual-agents";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { EmptyChat } from "@/components/assistant/EmptyChat";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { requireViewer } from "@/viewer/current";
import { openAssistant } from "@/web/data";

export const dynamic = "force-dynamic";

const ACTIONS: ConversationActions = { rename: renameConversation, remove: deleteConversation };

/** A new chat. Opening it creates the viewer's assistant on their first visit, and starts it whenever it is stopped. */
export default async function AssistantPage() {
  const viewer = await requireViewer();
  const theme = themeOf((await cookies()).get(THEME_COOKIE)?.value);
  const home = await openAssistant(viewer);
  return (
    <AssistantShell viewerName={viewer.name} groups={home.conversations} activeId={null} hubLink theme={theme} actions={ACTIONS}>
      <EmptyChat starters={STARTERS} templates={TEMPLATES} start={startConversation} />
      <OnboardingGate
        assistant={home.assistant}
        statuses={home.credentials.available ? home.credentials.statuses : []}
        unavailable={home.credentials.available ? null : home.credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        theme={theme}
      />
    </AssistantShell>
  );
}
