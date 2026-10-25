/**
 * Whether the browser has a network, and running something once it has one again.
 *
 * An `ERR_NETWORK_CHANGED` flap — a VPN re-establishing, or a laptop waking — fails whatever request is in flight.
 * A `router.refresh()` issued in that gap cannot be caught, because `refresh()` returns `void`, so the work waits
 * for the network instead of being fired into a dead one.
 *
 * Only one of the two ways that request can fail reaches the error boundary, which matters when reproducing it:
 *
 * - The fetch fails before a response (`TypeError: Failed to fetch`). Next catches this, logs "Falling back to
 *   browser navigation" and does a full page navigation. Survivable, and never the error boundary. This is what
 *   throttling devtools to "Offline" produces, so that reproduction shows nothing and proves nothing.
 * - The response starts and its body is cut mid-stream (`TypeError: network error`). Next has already returned by
 *   then, so React's Flight client rejects every pending row and the page throws during render, into
 *   `app/error.tsx`. This is the one people hit, and the reason `ErrorPanel` recovers itself as well.
 *
 * The browser's answer is advisory. It says only that the machine has a network, not that this origin is reachable,
 * and it can still be `true` through a flap, so waiting narrows the gap rather than closing it.
 */

export interface ConnectivityDependencies {
  /** Whether the browser has a network now. */
  online: () => boolean;
  /** Calls `handler` the next time the network comes back; the returned function stops listening. */
  watch: (handler: () => void) => () => void;
}

export function browserConnectivity(): ConnectivityDependencies {
  return {
    // Only a definite `false` is evidence of no network. `navigator.onLine` is absent when this renders on the
    // server, and an absent answer reads as online, the same way `sessionEnded` reads a failed check as "not ended".
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    watch: (handler) => {
      window.addEventListener("online", handler);
      return () => window.removeEventListener("online", handler);
    }
  };
}

/**
 * Runs `run` now when the browser has a network, and otherwise once the network returns, whereupon it runs exactly
 * once. Returns the function that cancels a waiting run, or `null` when it already ran.
 */
export function whenOnline(run: () => void, dependencies: ConnectivityDependencies = browserConnectivity()): (() => void) | null {
  if (dependencies.online()) {
    run();
    return null;
  }
  let unwatch: (() => void) | null = null;
  const stop = (): void => {
    unwatch?.();
    unwatch = null;
  };
  unwatch = dependencies.watch(() => {
    stop();
    run();
  });
  return stop;
}
