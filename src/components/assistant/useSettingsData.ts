"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHubEvent } from "@/components/live/HubStream";
import { useSettled } from "@/components/live/useSettled";

/**
 * Data a settings section reads only once it is open, rather than every page reading it on every render for a dialog
 * that is closed by default. `load` is a server action that re-reads the viewer. A burst of `virtual_agent` events
 * reads it again once, settled by `useSettled`, when `live` is set, since what the section shows of the agent
 * changes under it; `reload` reads it again after one of the section's own saves.
 *
 * Reads are numbered so that one answering late cannot replace a newer one's answer.
 *
 * The first read is keyed on `section` alone, never on `load`: a server action's reference is handed down afresh by
 * every server render, and each `router.refresh()` after a save is one, so keying on it would read again on top of
 * the read the save itself asked for.
 */
export function useSettingsData<T>(section: string, load: () => Promise<T>, live = false): { data: T | undefined; failed: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(() => {
    const read = ++latest.current;
    loader.current().then(
      (value) => {
        if (read === latest.current) {
          setData(value);
          setFailed(false);
        }
      },
      () => {
        if (read === latest.current) {
          setFailed(true);
        }
      }
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only when the section changes, as the comment above says
  useEffect(() => {
    reload();
  }, [section, reload]);

  // A pod booting is a burst of `virtual_agent` events, which the same settle as the page's own refresh makes one read.
  const settled = useSettled(reload);
  useHubEvent("virtual_agent", () => {
    if (live) {
      settled();
    }
  });

  return { data, failed, reload };
}
