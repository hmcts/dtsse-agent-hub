"use client";

import { useEffect, useRef, useState } from "react";
import { boundaryRetryBudget, browserConnectivity, type ConnectivityDependencies, type RetryBudget, recoveryMessage } from "@/components/error-recovery";
import { PANE_ACTION, PaneBody, PaneHeader } from "@/components/Pane";

/** The hash Next gives a server-side error, which matches the line it logs; a client-side error has none. */
export function errorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  return typeof error.digest === "string" && error.digest !== "" ? error.digest : undefined;
}

/**
 * Retries for the person while the budget allows: once the delay passes, or as soon as the network comes back,
 * whichever happens first. Returns whether an attempt is still coming, which is all the message needs to know.
 *
 * `retry` refetches rather than re-rendering what already threw, and the component is remounted before any second
 * attempt, so one call per mount is all there is to make here.
 */
function useAutomaticRetry(retry: () => void, connectivity: ConnectivityDependencies, budget: RetryBudget): boolean {
  const [delay] = useState(() => budget.delay());
  const latest = useRef(retry);
  latest.current = retry;
  useEffect(() => {
    if (delay === null) {
      return;
    }
    const attempt = (): void => {
      budget.spend();
      latest.current();
    };
    const timer = setTimeout(attempt, delay);
    const unwatch = connectivity.watch(() => {
      clearTimeout(timer);
      attempt();
    });
    return () => {
      clearTimeout(timer);
      unwatch();
    };
  }, [budget, connectivity, delay]);
  return delay !== null;
}

/**
 * What `error.tsx` and `global-error.tsx` show. It never renders the error's message, which can carry SQL or a
 * hostname: the digest is enough to find the server log line. Home is a plain link so that leaving reloads the
 * whole document, layout included, rather than reusing whatever state threw. The button stays whatever else is
 * happening, so an exhausted budget is never a dead end.
 */
export function ErrorPanel({
  error,
  retry,
  connectivity,
  budget
}: {
  error: unknown;
  retry: () => void;
  connectivity?: ConnectivityDependencies;
  budget?: RetryBudget;
}) {
  const digest = errorDigest(error);
  const [dependencies] = useState(() => connectivity ?? browserConnectivity());
  const [attempts] = useState(() => budget ?? boundaryRetryBudget);
  const retrying = useAutomaticRetry(retry, dependencies, attempts);
  return (
    <>
      <PaneHeader title="Something went wrong" />
      <PaneBody>
        <div role="alert" className="rounded-lg border border-dashed border-hub-line px-5 py-6 text-center">
          <p className="text-[15px] text-hub-text">{recoveryMessage(!dependencies.online(), retrying)}</p>
          {digest ? (
            <p className="mt-1 text-[13px] text-hub-muted">
              If it keeps happening, quote reference <code className="font-mono text-hub-text">{digest}</code>
            </p>
          ) : null}
          <div className="mt-4 flex justify-center gap-2 text-[13px]">
            <button type="button" onClick={retry} className={PANE_ACTION}>
              Try again
            </button>
            <a href="/" className={PANE_ACTION}>
              Back to home
            </a>
          </div>
        </div>
      </PaneBody>
    </>
  );
}
