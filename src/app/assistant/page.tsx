import { openConversation, sendAssistantMessage, setConversationProduct, startConversation } from "@/app/_actions/assistant";
import { AssistantShellFrame, loadFrame } from "@/app/assistant/frame";
import { STARTERS } from "@/assistant/starters";
import { offeredTemplates } from "@/assistant/templates";
import { AssistantGate } from "@/components/assistant/AssistantGate";
import { EmptyChat, type EmptyChatActions } from "@/components/assistant/EmptyChat";
import { requireViewer } from "@/viewer/current";
import { unsentNewChat } from "@/web/data";

export const dynamic = "force-dynamic";

/** What the new-chat screen needs: it may open a conversation before the first message, to attach a file to. */
const CHAT_ACTIONS: EmptyChatActions = {
  start: startConversation,
  open: openConversation,
  send: sendAssistantMessage,
  setProduct: setConversationProduct
};

/** A new chat. Opening it creates the viewer's assistant on their first visit, and starts it whenever it is stopped. */
export default async function AssistantPage() {
  const viewer = await requireViewer();
  const [frame, unsent] = await Promise.all([loadFrame(viewer), unsentNewChat(viewer)]);
  const { home, mine, theme } = frame;
  return (
    <AssistantShellFrame frame={frame}>
      {/* No `local` here: this screen is about to start a chat on a pod, so it needs what a pod needs. */}
      <AssistantGate home={home} waiting={frame.waiting} theme={theme}>
        <EmptyChat starters={STARTERS} templates={offeredTemplates(mine)} skills={home.skills} viewerOid={viewer.oid} unsent={unsent} actions={CHAT_ACTIONS} />
      </AssistantGate>
    </AssistantShellFrame>
  );
}
