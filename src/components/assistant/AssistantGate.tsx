import { saveCredential } from "@/app/_actions/credentials";
import { pasteLoginCode, reconnectSignIn } from "@/app/_actions/virtual-agents";
import type { Theme } from "@/assistant/theme";
import { waitingDismissed } from "@/assistant/waiting";
import { OnboardingGate } from "@/components/assistant/GettingReady";
import type { AssistantHome } from "@/web/data";

/**
 * The chat a page of the Assistant shows, and the getting-ready surfaces over it, for both the new-chat page and a
 * conversation's. One place for the rule that the chat is not rendered at all while `chatGate` holds the person at
 * GitHub, Azure and Claude, so neither page can show what is behind the screen.
 *
 * `waiting` is the page's reading of `WAITING_COOKIE`, the person's choice to send a getting-ready screen away.
 */
export function AssistantGate({
  home,
  waiting,
  theme,
  children
}: {
  home: AssistantHome;
  waiting: string | undefined;
  theme: Theme;
  children: React.ReactNode;
}) {
  const { assistant, credentials } = home;
  return (
    <>
      {home.chat === "blocked" ? null : children}
      <OnboardingGate
        assistant={assistant}
        statuses={credentials.available ? credentials.statuses : []}
        unavailable={credentials.available ? null : credentials.reason}
        paste={pasteLoginCode}
        save={saveCredential}
        reconnect={reconnectSignIn}
        now={Date.now()}
        dismissed={waitingDismissed(waiting, assistant.id, assistant.startedAt)}
        theme={theme}
      />
    </>
  );
}
