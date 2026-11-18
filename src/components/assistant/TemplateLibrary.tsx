"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { MAX_DOCX_BYTES } from "@/assistant/docmosis";
import { INDEX_REFRESH_PENDING_MS, type LibraryStatus } from "@/assistant/docmosis-library";
import { DEFAULT_SEARCH_LIMIT, folders, type PreparedTemplate, prepare, searchTemplates } from "@/assistant/docmosis-library-search";
import { WAKING_RETRY_MS } from "@/components/assistant/AtlassianSearch";
import { type LibraryRead, libraryEntries, openLibrary, readLibrary } from "@/components/assistant/docmosisLoadClient";
import { fileSizeLabel } from "@/components/assistant/uploadClient";
import { useHubEvent } from "@/components/live/HubStream";
import { instant } from "@/web/format";

/**
 * Choosing a template from the person's Docmosis template library, searched in the browser over the whole index the
 * hub holds, so no keystroke goes to the pod. See "Docmosis template library" in docs/agent-api.md.
 *
 * The combobox is `AtlassianSearch`'s: focus stays in the box, the arrows move `aria-activedescendant` through the
 * options and Enter picks the one it is on. The live region says why there is no list yet, or why it may be out of
 * date, in words the person can act on.
 */

const MAX_QUERY = 200;
/** How many times opening the library is asked again while the assistant starts: about three minutes. */
const WAKING_RETRIES = 36;

type Read = { phase: "opening" } | { phase: "unreachable"; message: string } | { phase: "ready"; status: LibraryStatus };

const UNREACHABLE = "The template list could not be reached. Check your connection and try again.";

function failureLine(status: LibraryStatus): string | null {
  const failure = status.failure;
  if (failure === null) {
    return null;
  }
  const repo = `${status.owner}/${status.repo}`;
  switch (failure.reason) {
    case "signed_out":
      return "Sign in to GitHub in your assistant to see the template list.";
    case "sso":
      return `Your GitHub sign-in needs single sign-on authorising for the ${status.owner} organisation before it can read ${repo}.`;
    case "not_found":
      return `Your GitHub account has no access to ${repo}, so the template list cannot be read.`;
    case "rate_limited":
      return failure.reset_at === undefined
        ? "GitHub's rate limit has been reached, so the list cannot be checked for now."
        : `GitHub's rate limit has been reached, so the list cannot be checked until ${instant(failure.reset_at)}.`;
    case "failed":
      return failure.detail ?? "The template list could not be checked. Try Refresh.";
  }
}

function statusLines(read: Read, prepared: PreparedTemplate[] | null, matches: number, shown: number): string[] {
  if (read.phase === "opening") {
    return ["Fetching the template list…"];
  }
  if (read.phase === "unreachable") {
    return [read.message];
  }
  const status = read.status;
  if (status.pod === "unsupported") {
    return ["Your assistant needs an update to read the template library. It gets one the next time it restarts."];
  }
  const lines: string[] = [];
  if (status.pod === "waking") {
    lines.push("Your assistant is starting, so it can read the template list from GitHub as you. This takes a minute or two.");
  }
  const failure = failureLine(status);
  if (failure !== null) {
    lines.push(failure);
  }
  if (status.commit === null) {
    if (lines.length === 0) {
      lines.push("Fetching the template list for the first time. This can take a minute.");
    }
    return lines;
  }
  if (status.refreshing) {
    lines.push("Showing the list from the last check while it is checked again.");
  }
  if (prepared === null) {
    lines.push("Loading the template list…");
  } else if (matches === 0) {
    lines.push("No templates match that.");
  } else if (matches > shown) {
    lines.push(`${matches} templates match; showing the first ${shown}. Type more to narrow the list.`);
  } else {
    lines.push(`${matches} ${matches === 1 ? "template matches" : "templates match"}. Use the arrow keys to choose.`);
  }
  return lines;
}

const tooLarge = (template: PreparedTemplate): boolean => template.size > MAX_DOCX_BYTES;

export function TemplateLibrary({
  onPick,
  onCancel,
  busy = false,
  reread = 0
}: {
  onPick: (template: PreparedTemplate) => void;
  onCancel: () => void;
  /** A load is under way, so no other template may be picked until it ends. */
  busy?: boolean;
  /** Bumped to read the library again, as when a pick is refused because the list has moved on. */
  reread?: number;
}) {
  const listId = useId();
  const box = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<Read>({ phase: "opening" });
  const [notice, setNotice] = useState<string | null>(null);
  const [index, setIndex] = useState<{ url: string; prepared: PreparedTemplate[] } | null>(null);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [active, setActive] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const retries = useRef(0);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const take = useCallback((answer: LibraryRead): LibraryStatus | null => {
    if (!mounted.current) {
      return null;
    }
    if (!answer.ok) {
      setRead((before) => (before.phase === "ready" ? before : { phase: "unreachable", message: answer.error }));
      return null;
    }
    setRead({ phase: "ready", status: answer.status });
    return answer.status;
  }, []);

  const readAgain = useCallback(async (): Promise<void> => {
    try {
      take(await readLibrary());
    } catch {
      if (mounted.current) {
        setRead((before) => (before.phase === "ready" ? before : { phase: "unreachable", message: UNREACHABLE }));
      }
    }
  }, [take]);

  // Opening asks the pod for a check when one is due, and starts a stopped pod that has no index yet. While it starts,
  // opening is asked again, as the lookups do, since nothing is sent to the tab when the pod comes up.
  const open = useCallback(async (): Promise<void> => {
    try {
      const status = take(await openLibrary(false));
      if (status?.pod === "waking" && retries.current < WAKING_RETRIES) {
        retries.current += 1;
        wakeTimer.current = setTimeout(() => void open(), WAKING_RETRY_MS);
      }
    } catch {
      if (mounted.current) {
        setRead({ phase: "unreachable", message: UNREACHABLE });
      }
    }
  }, [take]);

  useEffect(() => {
    mounted.current = true;
    box.current?.focus();
    void open();
    return () => {
      mounted.current = false;
      if (wakeTimer.current !== null) {
        clearTimeout(wakeTimer.current);
      }
    };
  }, [open]);

  useHubEvent("assistant_docmosis_library", () => void readAgain());

  useEffect(() => {
    if (reread > 0) {
      void readAgain();
    }
  }, [reread, readAgain]);

  const status = read.phase === "ready" ? read.status : null;
  // A check that is lost sends nothing to the tab, so a list said to be refreshing is read again once the hub would
  // have given up on it.
  const pending = status?.refreshing === true;
  useEffect(() => {
    if (!pending) {
      return;
    }
    const timer = setTimeout(() => void readAgain(), INDEX_REFRESH_PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, readAgain]);

  const entriesUrl = status?.entries_url ?? null;
  useEffect(() => {
    if (entriesUrl === null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const body = await libraryEntries(entriesUrl, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setIndex({ url: entriesUrl, prepared: prepare(body.entries) });
        }
      } catch {
        if (!controller.signal.aborted) {
          setNotice("The template list could not be downloaded. Try Refresh.");
        }
      }
    })();
    return () => controller.abort();
  }, [entriesUrl]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setNotice(null);
    try {
      const answer = await openLibrary(true);
      if (!answer.ok && answer.status === 429) {
        setNotice("The list was checked a moment ago. Try again in half a minute.");
      } else {
        take(answer);
      }
    } catch {
      setNotice(UNREACHABLE);
    } finally {
      if (mounted.current) {
        setRefreshing(false);
      }
    }
  }

  // The index of the commit the status names, or the one before it while the new one downloads.
  const prepared = index?.prepared ?? null;
  const chips = useMemo(() => (prepared === null ? [] : folders(prepared)), [prepared]);
  const matches = useMemo(
    () => (prepared === null ? [] : searchTemplates(prepared, query, { folder, limit: Number.MAX_SAFE_INTEGER })),
    [prepared, query, folder]
  );
  const results = matches.slice(0, DEFAULT_SEARCH_LIMIT);
  const current = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const optionId = (at: number) => `${listId}-${at}`;
  const lines = statusLines(read, prepared, matches.length, results.length);

  function pick(template: PreparedTemplate): void {
    if (!busy && !tooLarge(template)) {
      onPick(template);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      // Escape leaves the lookup and nothing behind it: the panel closes on Escape as well.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
      return;
    }
    if (event.key === "Enter") {
      const chosen = results[current];
      if (chosen !== undefined) {
        event.preventDefault();
        pick(chosen);
      }
    }
  }

  const chip = (pressed: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-xs ${pressed ? "border-asst-accent bg-asst-active text-asst-text" : "border-asst-strong text-asst-muted hover:bg-asst-field hover:text-asst-text"}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <input
          ref={box}
          type="search"
          value={query}
          maxLength={MAX_QUERY}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-label="Search templates"
          placeholder="Search by name or folder"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={current === -1 ? undefined : optionId(current)}
          className="min-w-0 flex-1 rounded-[9px] border border-asst-strong bg-asst-field px-3 py-[7px] text-[13px] text-asst-text outline-hidden placeholder:text-asst-faint focus:border-asst-accent-line"
        />
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing || status === null || status.pod === "unsupported"}
          className="flex h-[30px] shrink-0 items-center rounded-lg border border-asst-strong px-2.5 text-[13px] hover:bg-asst-field disabled:opacity-40"
        >
          Refresh
        </button>
      </div>
      {chips.length === 0 ? null : (
        <div role="group" aria-label="Folders" className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={folder === undefined} onClick={() => setFolder(undefined)} className={chip(folder === undefined)}>
            All folders
          </button>
          {chips.map(({ folder: name, count }) => (
            <button
              key={name}
              type="button"
              aria-pressed={folder === name}
              aria-label={`${name}, ${count} ${count === 1 ? "template" : "templates"}`}
              onClick={() => {
                setFolder(folder === name ? undefined : name);
                setActive(0);
              }}
              className={chip(folder === name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {/* Mounted whether or not there is anything to say, because a live region that appears with its text is not reliably read. */}
      <p role="status" className="text-xs text-asst-faint empty:hidden">
        {[...lines, ...(notice === null ? [] : [notice])].join(" ")}
      </p>
      {status?.failure?.reason === "sso" && status.failure.sso_url !== undefined ? (
        <a href={status.failure.sso_url} target="_blank" rel="noreferrer" className="self-start text-xs text-asst-accent underline">
          Authorise single sign-on on GitHub
        </a>
      ) : null}
      {status !== null && status.dropped > 0 ? (
        <p className="text-xs text-asst-warn">
          The list is incomplete: {status.dropped} {status.dropped === 1 ? "template was" : "templates were"} left out, so search may not find the one you want.
        </p>
      ) : null}
      <div
        id={listId}
        role="listbox"
        aria-label="Templates found"
        hidden={results.length === 0}
        className={`${results.length === 0 ? "hidden" : "flex"} min-h-0 min-w-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden rounded-[9px] border border-asst-line bg-asst-field p-1`}
      >
        {results.map((template, at) => {
          const disabled = busy || tooLarge(template);
          return (
            <div
              key={template.path}
              id={optionId(at)}
              role="option"
              tabIndex={-1}
              aria-selected={at === current}
              aria-disabled={disabled || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(template)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  pick(template);
                }
              }}
              className={`min-w-0 rounded-md px-2.5 py-1.5 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${at === current ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"}`}
            >
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-medium">{template.name}</span>
                <span className="flex min-w-0 gap-2 text-xs text-asst-faint">
                  <span className="truncate">{template.folder === "" ? "Top folder" : template.folder}</span>
                  <span className="shrink-0">{fileSizeLabel(template.size)}</span>
                  {tooLarge(template) ? <span className="shrink-0 text-asst-warn">Too large to load</span> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
