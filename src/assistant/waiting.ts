/**
 * That the person has sent their assistant's waiting screen away, kept in a cookie.
 *
 * The screen is rendered by each of the Assistant's pages rather than by the layout around them, and the App Router
 * remounts a page's subtree on every navigation, so a choice held only inside the screen is forgotten the moment
 * they act on it: sending the wait away and then typing a first message navigates to the new conversation, and the
 * full-screen wait would come straight back over it. The server reads the cookie as it renders the next page, so the
 * screen is gone from the first frame rather than painted and then withdrawn.
 *
 * It names one start of one assistant: `startedAt` moves only when the assistant is asked to run again, so the
 * choice holds for every step of the wait it was made in, and an assistant stopped and started again later — by the
 * idle sweep overnight, say — is a new wait that asks again, however long the browser has been open.
 */

export const WAITING_COOKIE = "asst_waiting";

/** A uuid and an ISO timestamp, neither of which needs escaping to sit in a cookie value. */
function value(assistantId: string, startedAt: string): string {
  return `${assistantId}|${startedAt}`;
}

export function waitingDismissed(cookie: string | undefined, assistantId: string, startedAt: string): boolean {
  return cookie === value(assistantId, startedAt);
}

/** The cookie that remembers the choice, or clears it; not `HttpOnly`, since the screen writes it from the browser. */
export function waitingCookie(assistant: { id: string; startedAt: string } | null): string {
  return assistant === null
    ? `${WAITING_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${WAITING_COOKIE}=${value(assistant.id, assistant.startedAt)}; Path=/; SameSite=Lax`;
}
