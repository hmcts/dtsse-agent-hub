"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useHubEvent } from "@/components/live/HubStream";

/**
 * Data a settings section reads only once it is open, rather than every page reading it on every render for a dialog
 * that is closed by default. `load` is a server action that re-reads the viewer. A `virtual_agent` event reads it
 * again when `live` is set, since what the section shows of the agent changes under it; `reload` reads it again after
 * one of the section's own saves.
 *
 * Reads are numbered so that one answering late cannot replace a newer one's answer.
 */
export function useSettingsData<T>(load: () => Promise<T>, live = false): { data: T | undefined; failed: boolean; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const read = ++latest.current;
    load().then(
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
  }, [load]);

  useEffect(() => {
    reload();
  }, [reload]);

  useHubEvent("virtual_agent", () => {
    if (live) {
      reload();
    }
  });

  return { data, failed, reload };
}
