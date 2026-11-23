/**
 * Whether the person collapsed the Assistant's sidebar on a wide screen. It is kept in a cookie, as the theme is, so
 * the server renders the page with the sidebar already as they left it and it never shows open and then collapses.
 */

import type { SidebarKind } from "./views.ts";

/** Whether a sidebar row or search result is a chat, the only kind that carries a session `mark`, as against a feedback project or a Bulk Scan form. */
export function isChat<T extends { kind: SidebarKind }>(item: T): item is Extract<T, { kind: "local" | "cloud" }> {
  return item.kind === "local" || item.kind === "cloud";
}

export const SIDEBAR_COOKIE = "asst_sidebar";

/** A year: the choice is a preference, not a session. */
const SIDEBAR_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Collapsed only when the cookie says so: anything else, a missing cookie included, is the open default. */
export function sidebarCollapsedOf(value: string | undefined): boolean {
  return value === "collapsed";
}

/** The cookie that stores the choice; not `HttpOnly`, since the shell writes it from the browser. */
export function sidebarCookie(collapsed: boolean): string {
  return collapsed
    ? `${SIDEBAR_COOKIE}=collapsed; Path=/; Max-Age=${SIDEBAR_MAX_AGE_SECONDS}; SameSite=Lax`
    : `${SIDEBAR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
