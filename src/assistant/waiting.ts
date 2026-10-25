/**
 * That the person has sent their assistant's waiting screen away, kept in a cookie.
 *
 * The screen is rendered by each of the Assistant's pages rather than by the layout around them, and the App Router
 * remounts a page's subtree on every navigation, so a choice held only inside the screen is forgotten the moment
 * they act on it: sending the wait away and then typing a first message navigates to the new conversation, and the
 * full-screen wait would come straight back over it. The server reads the cookie as it renders the next page, so the
 * screen is gone from the first frame rather than painted and then withdrawn.
 *
 * It names the assistant, so a different one asks again, and has no `Max-Age`, so it lasts the browser session: a
 * later visit to a cold assistant is a new wait and shows the screen.
 */

export const WAITING_COOKIE = "asst_waiting";

export function waitingDismissed(value: string | undefined, assistantId: string): boolean {
  return value === assistantId;
}

/** The cookie that remembers the choice, or clears it; not `HttpOnly`, since the screen writes it from the browser. */
export function waitingCookie(assistantId: string | null): string {
  return assistantId === null ? `${WAITING_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax` : `${WAITING_COOKIE}=${assistantId}; Path=/; SameSite=Lax`;
}
