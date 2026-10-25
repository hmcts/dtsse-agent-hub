import { cookies } from "next/headers";
import {
  deleteConversation,
  openConversation,
  renameConversation,
  sendAssistantMessage,
  setConversationProduct,
  startConversation
} from "@/app/_actions/assistant";
import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode } from "@/app/_actions/virtual-agents";
import { STARTERS, TEMPLATES } from "@/assistant/starters";
import { THEME_COOKIE, themeOf } from "@/assistant/theme";
import { WAITING_COOKIE, waitingDismissed } from "@/assistant/waiting";
import { AssistantShell, type ConversationActions } from "@/components/assistant/AssistantShell";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import { requireViewer } from "@/viewer/current";
import { openAssistant, unsentNewChat } from "@/web/data";

export const dynamic = "force-dynamic";

/** What the new-chat screen needs: it may open a conversation before the first message, to attach a file to. */
const CHAT_ACTIONS: EmptyChatActions = {
  start: startConversation,
  open: openConversation,
  send: sendAssistantMessage,
  setProduct: setConversationProduct
};

/** What a conversation's row in the sidebar offers. */
const ROW_ACTIONS: ConversationActions = { rename: renameConversation, remove: deleteConversation };

/** A new chat. Opening it creates the viewer's assistant on their first visit, and starts it whenever it is stopped. */
export default async function AssistantPage() {
  const viewer = await requireViewer();
  const jar = await cookies();
  const theme = themeOf(jar.get(THEME_COOKIE)?.value);
  const [home, unsent] = await Promise.all([openAssistant(viewer), unsentNewChat(viewer)]);
  return (
    <AssistantShell viewerName={viewer.name} groups={home.conversations} activeId={null} hubLink theme={theme} actions={ROW_ACTIONS}>
      <EmptyChat starters={STARTERS} templates={TEMPLATES} viewerOid={viewer.oid} unsent={unsent} actions={CHAT_ACTIONS} />

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
