"use client";

import { useEffect, useState } from "react";

/**
 * The hub's suggest-as-you-type behaviour, shared by the share dialog's name box and the post composer's tag box:
 * the debounced fetch of `/api/ui/<field>?q=`, the aborting of the request a keystroke replaced, and the combobox
 * keys — up, down, Enter and Escape — as `SkillMenu` handles them.
 *
 * Only the behaviour: each surface keeps its own markup, since the two are styled for the Assistant and for the hub
 * and show a different line per option. `useSkillMenu` does not fit either of them, as it matches a "/" token inside
 * a message being typed, locally, against a list the page already has.
 *
 * `path` and `field` are strings rather than callbacks so that the effect can depend on them: a caller passing an
 * inline function would make a new one each render and fetch on every one.
 */

const DEBOUNCE_MS = 200;

export interface Suggestions<T> {
  query: string;
  setQuery: (value: string) => void;
  /** The matches, less anything the caller already holds. Empty while the list is dismissed. */
  shown: T[];
  open: boolean;
  /** The highlighted option, or `-1` when there is no list. */
  current: number;
  onKeyDown: (event: React.KeyboardEvent) => void;
  choose: (item: T) => void;
  /** Forgets the query and its matches, for once a choice has been taken. */
  clear: () => void;
}

export function useSuggestions<T>({
  path,
  field,
  minQuery,
  exclude,
  onChoose
}: {
  /** The route to ask, which takes `?q=` and answers `{[field]: T[]}`. */
  path: string;
  field: string;
  /** The shortest query the route will answer, so a shorter one is not asked for at all. */
  minQuery: number;
  /** Matches the caller already holds, left out of the list rather than offered again. */
  exclude?: (item: T) => boolean;
  onChoose: (item: T) => void;
}): Suggestions<T> {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<T[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const asked = query.trim();
    if (asked.length < minQuery) {
      setMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${path}?q=${encodeURIComponent(asked)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : {}))
        .then((body: Record<string, T[] | undefined>) => {
          setMatches(body[field] ?? []);
          setActive(0);
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, path, field, minQuery]);

  const shown = exclude === undefined ? matches : matches.filter((item) => !exclude(item));
  const open = !dismissed && shown.length > 0;
  const current = open ? Math.min(active, shown.length - 1) : -1;

  function choose(item: T): void {
    onChoose(item);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (!open) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const chosen = shown[current];
      if (chosen !== undefined) {
        choose(chosen);
      }
      return;
    }
    if (event.key === "Escape") {
      // The list first, and whatever else Escape does on the surface only once there is no list to shut.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  }

  return {
    query,
    setQuery: (value: string) => {
      setDismissed(false);
      setQuery(value);
    },
    shown,
    open,
    current,
    onKeyDown,
    choose,
    clear: () => {
      setQuery("");
      setMatches([]);
    }
  };
}
