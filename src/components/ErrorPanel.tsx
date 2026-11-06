"use client";

import { useEffect, useRef, useState } from "react";
import { browserConnectivity, type ConnectivityDependencies, whenOnline } from "@/components/live/connectivity";
import { PANE_ACTION, PaneBody, PaneHeader } from "@/components/Pane";

/** The hash Next gives a server-side error, which matches the line it logs; a client-side error has none. */
export function errorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  return typeof error.digest === "string" && error.digest !== "" ? error.digest : undefined;
}

/** What Chrome, Firefox and Safari put in the `TypeError` a fetch, or the read of its body, rejects with when the network drops. */
const BROWSER_NETWORK_FAILURES = new Set(["network error", "Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]);

/**
 * How React Flight's error begins when an RSC body ends before every row it promised arrived: the development
 * build's message, and the production build's minified error #412.
 */
const FLIGHT_CONNECTION_CLOSED = ["Connection closed.", "Minified React error #412;"];

/**
 * Whether the boundary caught the browser losing the network mid-request rather than a bug, so that trying again is
 * likely to work. A server error never is: it reached the browser intact, with a digest. Flight hands the page a
 * body read's `TypeError` unwrapped, but the `cause` chain is walked in case something on the way wraps it.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (errorDigest(error) !== undefined) {
    return false;
  }
  const seen = new Set<unknown>();
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const message = current.message;
    if (current instanceof TypeError && BROWSER_NETWORK_FAILURES.has(message)) {
      return true;
    }
    if (FLIGHT_CONNECTION_CLOSED.some((start) => message.startsWith(start))) {
      return true;
    }
  }
  return false;
}

/** How long to wait before each automatic retry of a network failure, one entry per attempt. */
export const RECONNECT_DELAYS_MS = [1_000, 3_000];

/** How long after the last automatic retry a failure on the same page still counts against its attempts. */
export const RECONNECT_WINDOW_MS = 30_000;

/** The automatic retries already spent on a page, and when the last of them ran. */
export interface ReconnectLedger {
  page: string;
  attempts: number;
  at: number;
}

export interface ReconnectDependencies {
  /** Calls `run` after `ms` milliseconds; the returned function cancels it. */
  after: (ms: number, run: () => void) => () => void;
  /** The time now, in milliseconds. */
  now: () => number;
  /** Which page failed, so that failing on another one starts a count of its own. */
  page: () => string;
  /** Calls `handler` whenever the network comes back or the tab is shown again; the returned function stops listening. */
  wake: (handler: () => void) => () => void;
  /**
   * Where the attempts are counted. `retry` resets the boundary, which unmounts the panel, and a retry that fails
   * mounts a new one, so the count lives outside it: kept in the panel, a page broken for good would retry forever.
   */
  ledger: { current: ReconnectLedger | null };
}

const browserLedger: ReconnectDependencies["ledger"] = { current: null };

export function browserReconnect(): ReconnectDependencies {
  return {
    after: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => Date.now(),
    page: () => window.location.pathname + window.location.search,
    wake: (handler) => {
      const shown = (): void => {
        if (document.visibilityState === "visible") {
          handler();
        }
      };
      window.addEventListener("online", handler);
      document.addEventListener("visibilitychange", shown);
      return () => {
        window.removeEventListener("online", handler);
        document.removeEventListener("visibilitychange", shown);
      };
    },
    ledger: browserLedger
  };
}

/**
 * Retries a network failure the browser did not notice. A changed network (`ERR_NETWORK_CHANGED`) cuts the request
 * while `navigator.onLine` stays `true` and no `online` event follows, so `useRetryWhenOnline` has nothing to wait
 * for. Instead `retry` is called after each of `RECONNECT_DELAYS_MS` in turn, and at once if the network comes back
 * or the tab is shown again first. Returns whether an automatic retry is waiting; once the attempts are spent none
 * is, and the panel stays as it is for any other error until the person acts.
 */
function useRetryAfterNetworkFailure(retry: () => void, enabled: boolean, reconnect: ReconnectDependencies | undefined): boolean {
  const [dependencies] = useState(() => reconnect ?? browserReconnect());
  const [delay] = useState(() => {
    if (!enabled) {
      return undefined;
    }
    const spent = dependencies.ledger.current;
    const recent = spent !== null && spent.page === dependencies.page() && dependencies.now() - spent.at < RECONNECT_WINDOW_MS;
    return RECONNECT_DELAYS_MS[recent ? spent.attempts : 0];
  });
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const cancel =
      delay === undefined
        ? null
        : dependencies.after(delay, () => {
            const spent = dependencies.ledger.current;
            const page = dependencies.page();
            const recent = spent !== null && spent.page === page && dependencies.now() - spent.at < RECONNECT_WINDOW_MS;
            dependencies.ledger.current = { page, attempts: recent ? spent.attempts + 1 : 1, at: dependencies.now() };
            latest.current();
          });
    const unwake = dependencies.wake(() => {
      cancel?.();
      latest.current();
    });
    return () => {
      cancel?.();
      unwake();
    };
  }, [dependencies, enabled, delay]);
  return enabled && delay !== undefined;
}

/**
 * Whether the browser had no network when the boundary rendered, which is the usual reason a page fails during a
 * network flap. While it had none, the person is told so and `retry` is called for them as soon as the network
 * returns; from then on the panel offers the button again, so a retry that fails anyway is not a dead end.
 */
function useRetryWhenOnline(retry: () => void, connectivity: ConnectivityDependencies | undefined): boolean {
  const [dependencies] = useState(() => connectivity ?? browserConnectivity());
  const [offline, setOffline] = useState(() => !dependencies.online());
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (!offline) {
      return;
    }
    return (
      whenOnline(() => {
        setOffline(false);
        latest.current();
      }, dependencies) ?? undefined
    );
  }, [dependencies, offline]);
  return offline;
}

/**
 * What `error.tsx` and `global-error.tsx` show. It never renders the error's message, which can carry SQL or a
 * hostname: the digest is enough to find the server log line. Home is a plain link so that leaving reloads the
 * whole document, layout included, rather than reusing whatever state threw.
 *
 * A panel that opened offline leaves the retry to `useRetryWhenOnline` alone, so the network's return does not
 * retry twice.
 */
export function ErrorPanel({
  error,
  retry,
  connectivity,
  reconnect
}: {
  error: unknown;
  retry: () => void;
  connectivity?: ConnectivityDependencies;
  reconnect?: ReconnectDependencies;
}) {
  const digest = errorDigest(error);
  const offline = useRetryWhenOnline(retry, connectivity);
  const [openedOffline] = useState(offline);
  const reconnecting = useRetryAfterNetworkFailure(retry, !openedOffline && isNetworkFailure(error), reconnect);
  return (
    <>
      <PaneHeader title={offline ? "No internet connection" : "Something went wrong"} />
      <PaneBody>
        <div role="alert" className="rounded-lg border border-dashed border-hub-line px-5 py-6 text-center">
          {offline ? (
            <p className="text-[15px] text-hub-text">
              This page could not be loaded because you are not connected to the internet. It will load again on its own as soon as you are.
            </p>
          ) : (
            <p className="text-[15px] text-hub-text">This page could not be loaded. It is often a passing problem, so try again.</p>
          )}
          {reconnecting ? <p className="mt-1 text-[13px] text-hub-muted">Reconnecting…</p> : null}
          {digest && !offline ? (
            <p className="mt-1 text-[13px] text-hub-muted">
              If it keeps happening, quote reference <code className="font-mono text-hub-text">{digest}</code>
            </p>
          ) : null}
          <div className="mt-4 flex justify-center gap-2 text-[13px]">
            {offline ? null : (
              <button type="button" onClick={retry} className={PANE_ACTION}>
                Try again
              </button>
            )}
            <a href="/" className={PANE_ACTION}>
              Back to home
            </a>
          </div>
        </div>
      </PaneBody>
    </>
  );
}
