"use client";

import { createContext, useContext, useMemo, useRef } from "react";

/**
 * What this visit to the Assistant has already seen. It lives in the layout, which the App Router keeps mounted
 * while the person moves between the Assistant's pages, so it outlives the page subtrees — including the waiting
 * screen — that every navigation remounts. A reload is a new visit and starts again, which is the point: a cookie or
 * `sessionStorage` would hold these facts far too long.
 *
 * A ref, not state: nothing here changes what is on the screen while the page stays put, so flipping one must not
 * re-render the Assistant. The screen that cares reads it as it mounts.
 */
interface Visit {
  /** The assistant has been running at some point during this visit, so a later stop is not worth a screen over. */
  ran: boolean;
  sawRunning: () => void;
}

const VisitContext = createContext<Visit>({ ran: false, sawRunning: () => undefined });

export function AssistantVisit({ children }: { children: React.ReactNode }) {
  const ran = useRef(false);
  const visit = useMemo<Visit>(
    () => ({
      get ran() {
        return ran.current;
      },
      sawRunning: () => {
        ran.current = true;
      }
    }),
    []
  );
  return <VisitContext.Provider value={visit}>{children}</VisitContext.Provider>;
}

/** Outside a provider nothing is remembered, which is what a page rendered on its own should get. */
export function useVisit(): Visit {
  return useContext(VisitContext);
}
