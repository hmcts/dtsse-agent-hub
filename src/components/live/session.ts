/**
 * Whether the tab's sign-in has ended. `/api/ui/` is exempt from the proxy's sign-in redirect, so an ended session
 * answers 401 there rather than a redirect a `fetch` or an `EventSource` would follow to an unreadable page.
 */

export const SESSION_URL = "/api/ui/session";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** True only for a 401. A network failure is not evidence the session ended, so it reads as `false`. */
export async function sessionEnded(fetcher: Fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(SESSION_URL, { cache: "no-store" });
    return response.status === 401;
  } catch {
    return false;
  }
}

/** The sign-in link that brings the person back to `path`, which the login route checks with `safeReturnTo`. */
export function signInAgainHref(path: string): string {
  return `/auth/login?${new URLSearchParams({ redirect: path }).toString()}`;
}
