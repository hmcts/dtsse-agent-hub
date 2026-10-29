import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode, reconnectSignIn } from "@/app/_actions/virtual-agents";
import type { Theme } from "@/assistant/theme";
import { waitingDismissed } from "@/assistant/waiting";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import type { AssistantHome } from "@/web/data";

/**
 * The chat a page of the Assistant shows, and the getting-ready surfaces over it, for both the new-chat page and a
 * conversation's. One place for the rule that the chat is not rendered at all while `chatGate` holds the person at
 * GitHub and Claude, so neither page can show what is behind the screen.
 *
 * `waiting` is the page's reading of `WAITING_COOKIE`, the person's choice to send a getting-ready screen away.
 *
 * `local` is the page's reading of `ConversationView.local`: a chat with no pod behind it, which runs on the person's
 * own computer with their own Claude Code. `chatGate` asks what a pod needs — GitHub to clone with, and the
 * credential its model is reached with — and a laptop session needs none of it, so neither surface may hold someone
 * out of one. `sendAssistantMessage` and `warmConversation` already read `hasPod` before the gate, so without this
 * the actions would take a message that no page offered a composer for.
 *
 * It is per page and not per viewer, which is why it is a prop rather than a field of `home`: the new-chat screen
 * leaves it false because it is about to start a pod, and a pod chat is held exactly as it is today. Someone with
 * nothing connected still gets the connections banner here, and it is the only route to the screen that connects
 * GitHub and Claude — the settings dialog lists those two but can only connect a sign-in made on request.
 */
export function AssistantGate({
  home,
  waiting,
  theme,
  local = false,
  children
}: {
  home: AssistantHome;
  waiting: string | undefined;
  theme: Theme;
  local?: boolean;
  children: React.ReactNode;
}) {
  const { assistant, credentials } = home;
  return (
    <>
      {home.chat === "blocked" && !local ? null : children}
      <OnboardingGate
        assistant={assistant}
        statuses={credentials.available ? credentials.statuses : []}
        unavailable={credentials.available ? null : credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        reconnect={reconnectSignIn}
        now={Date.now()}
        dismissed={waitingDismissed(waiting, assistant.id, assistant.startedAt)}
        local={local}
        theme={theme}
      />
    </>
  );
}
