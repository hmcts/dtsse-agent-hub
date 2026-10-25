/**
 * How the error boundary gets the page back without the person clicking.
 *
 * A network flap — a VPN re-establishing, a laptop waking — cuts whatever RSC response is in flight. Once the
 * response has begun, Next has already returned, so React's Flight client rejects every pending row and the page
 * throws during render into `app/error.tsx`. `router.refresh()` returns `void`, so the refresh that tripped it
 * cannot be caught; the boundary is the only place the failure is observable, which is why recovery lives here and
 * not at the half-dozen call sites that refresh.
 *
 * Retrying is deliberately NOT conditional on `navigator.onLine`. During an interface change the machine still has
 * a network, so `onLine` stays true and a connectivity gate would never fire for the very failure this recovers
 * from. Time is the signal; `onLine` only ever adds an attempt, never withholds one.
 *
 * The attempts are counted here, at module scope, rather than in the component. `retry()` clears the boundary's
 * error, so the children re-render and remount the error component when they throw again: component state resets
 * on every cycle and could not bound anything. One budget per tab also bounds the total load when more than one
 * boundary is showing.
 */

/** Spacing of the automatic attempts. Three is enough for a flap that settles, and stops a reload storm. */
const AUTO_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];

/** Attempts older than this are forgotten, so an unrelated failure later gets the full budget again. */
const BUDGET_WINDOW_MS = 60_000;

export interface ConnectivityDependencies {
  /** Whether the browser has a network now. Used to word the message, never to decide whether to retry. */
  online: () => boolean;
  /** Calls `handler` the next time the network comes back; the returned function stops listening. */
  watch: (handler: () => void) => () => void;
}

export function browserConnectivity(): ConnectivityDependencies {
  return {
    // Only a definite `false` is evidence of no network: `navigator.onLine` is absent when this renders on the
    // server, and an absent answer reads as online, the way `sessionEnded` reads a failed check as "not ended".
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    watch: (handler) => {
      window.addEventListener("online", handler);
      return () => window.removeEventListener("online", handler);
    }
  };
}

/**
 * How long to wait before the next automatic attempt, given when the earlier ones were made, or `null` once this
 * run of failures has had its budget.
 */
export function nextRetryDelay(attemptsAt: readonly number[], now: number): number | null {
  const recent = attemptsAt.filter((at) => now - at < BUDGET_WINDOW_MS).length;
  return recent < AUTO_RETRY_DELAYS_MS.length ? AUTO_RETRY_DELAYS_MS[recent]! : null;
}

export interface RetryBudget {
  /** How long to wait before the next automatic attempt, or `null` when there is none left to spend. */
  delay: () => number | null;
  /** Counts an attempt, whether it was the timer's or the network's. */
  spend: () => void;
}

export function createRetryBudget(now: () => number = Date.now): RetryBudget {
  let attemptsAt: number[] = [];
  return {
    delay: () => nextRetryDelay(attemptsAt, now()),
    spend: () => {
      const at = now();
      attemptsAt = [...attemptsAt.filter((earlier) => at - earlier < BUDGET_WINDOW_MS), at];
    }
  };
}

/** The budget every boundary in the tab draws on. */
export const boundaryRetryBudget: RetryBudget = createRetryBudget();

/**
 * What to tell the person. It never includes the error's message, which can carry SQL or a hostname, and it says
 * the page is retrying only while an attempt is actually coming.
 */
export function recoveryMessage(offline: boolean, retrying: boolean): string {
  if (!retrying) {
    return "This page could not be loaded. It is often a passing problem, so try again.";
  }
  return offline
    ? "This page could not be loaded because you are not connected to the internet. Trying again automatically."
    : "This page could not be loaded. Trying again automatically.";
}
