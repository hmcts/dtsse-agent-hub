/**
 * What an action answers for a fault of its own rather than a refusal, in a module of its own so a client component
 * can tell the two apart: trying again can help with a fault, never with a refusal.
 */
export const ACTION_FAULT = "something went wrong on our side; try again";

/** What a client component says when a call to an action threw, so it never reached the hub or never came back. */
export const ACTION_UNREACHABLE = "That could not be done. Check your connection and try again.";

/** What a client component says when the page is older than the hub it is talking to, after a deploy. */
export const ACTION_STALE_PAGE = "CFT Workspace has been updated since this page opened. Reload the page, then try again.";

/**
 * What to tell the person when a call to an action threw. After a deploy a page left open still names the actions of
 * the build it came from, which Next no longer has, and no amount of trying again helps until the page is reloaded;
 * anything else is the connection.
 */
export function actionThrew(error: unknown): string {
  return isStalePage(error) ? ACTION_STALE_PAGE : ACTION_UNREACHABLE;
}

/** Whether a thrown action is the page being from before a deploy, for a caller with its own words for the rest. */
export function isStalePage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to find Server Action|older or newer deployment/i.test(message);
}
