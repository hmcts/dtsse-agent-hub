"use client";

import { PANE_ACTION, PaneBody, PaneHeader } from "@/components/Pane";

/** The hash Next gives a server-side error, which matches the line it logs; a client-side error has none. */
export function errorDigest(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  return typeof error.digest === "string" && error.digest !== "" ? error.digest : undefined;
}

/**
 * What `error.tsx` and `global-error.tsx` show. It never renders the error's message, which can carry SQL or a
 * hostname: the digest is enough to find the server log line. Home is a plain link so that leaving reloads the
 * whole document, layout included, rather than reusing whatever state threw.
 */
export function ErrorPanel({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = errorDigest(error);
  return (
    <>
      <PaneHeader title="Something went wrong" />
      <PaneBody>
        <div role="alert" className="rounded-lg border border-dashed border-hub-line px-5 py-6 text-center">
          <p className="text-[15px] text-hub-text">This page could not be loaded. It is often a passing problem, so try again.</p>
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
