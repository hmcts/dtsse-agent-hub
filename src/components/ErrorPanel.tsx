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
 */
export function ErrorPanel({ error, retry, connectivity }: { error: unknown; retry: () => void; connectivity?: ConnectivityDependencies }) {
  const digest = errorDigest(error);
  const offline = useRetryWhenOnline(retry, connectivity);
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
