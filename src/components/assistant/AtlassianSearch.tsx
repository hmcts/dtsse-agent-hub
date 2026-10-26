"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  breadcrumb,
  type ConfluencePageResult,
  type JiraProjectResult,
  type LookupKind,
  type LookupResult,
  MAX_LOOKUP_QUERY,
  searchable
} from "@/assistant/lookups";
import { SignInPrompt } from "@/components/assistant/AtlassianSignIn";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import { lookUp as fetchLookup, type LookUp } from "@/components/assistant/lookupClient";

/**
 * Finding a Jira project or a Confluence page by typing a few words of it, searched as the person, in their own pod,
 * with their own Atlassian sign-in (see "Atlassian lookups" in docs/agent-api.md). The document panel and the settings
 * both use it, for where a document goes.
 *
 * A combobox over a listbox, as the sidebar's chat search is: focus stays in the box, the arrows move
 * `aria-activedescendant` through the results and Enter picks the one it is on. Unlike that search, the answer can be
 * slow or not come at all, so the live region says why there is nothing yet — the assistant is starting, Atlassian
 * wants a sign-in, or the search failed — in words the person can act on.
 */

/** Long enough that a typed word is one search rather than one per letter, which matters when each is a twg call. */
export const LOOKUP_AFTER_MS = 300;
/** How often a search is tried again while the assistant starts, and for how long. */
export const WAKING_RETRY_MS = 5000;
const WAKING_RETRIES = 36;

type Phase = "idle" | "searching" | "found" | "waking" | "signed_out" | "signing_in" | "unsupported" | "failed" | "timeout";

interface Shown {
  phase: Phase;
  results: LookupResult[];
  detail?: string;
}

const IDLE: Shown = { phase: "idle", results: [] };

/** A breadcrumb short enough for one line: the space, then the last two places, with what is between them left out. */
export function shortCrumb(parts: readonly string[]): string {
  return (parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)] : parts).join(" › ");
}

function nouns(kind: LookupKind): [string, string] {
  return kind === "jira_project" ? ["project", "projects"] : ["page", "pages"];
}

function summary(kind: LookupKind, shown: Shown): string {
  const [one, many] = nouns(kind);
  const where = kind === "jira_project" ? "Jira" : "Confluence";
  switch (shown.phase) {
    case "idle":
      return "";
    case "searching":
      return `Searching ${where}…`;
    case "found":
      return shown.results.length === 0
        ? `No ${many} match that.`
        : `${shown.results.length} ${shown.results.length === 1 ? one : many} found. Use the arrow keys to choose.`;
    case "waking":
      return `Your assistant is starting, so it can search ${where} as you. This takes a minute or two; the search will run when it is ready.`;
    case "signed_out":
      return `Your assistant needs you to sign in to Atlassian before it can search ${where}.`;
    case "signing_in":
      return "Sign in to Atlassian with the code below, then the search will run.";
    case "unsupported":
      return `Your assistant needs an update to search ${where}. It gets one the next time it restarts.`;
    case "timeout":
      return `${where} did not answer in time. Try again in a moment.`;
    case "failed":
      return shown.detail ?? "The search did not work. Try again.";
  }
}

function Option({ result }: { result: LookupResult }) {
  if ("key" in result) {
    const project = result as JiraProjectResult;
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-plex-mono text-xs font-medium">{project.key}</span>
        <span className="truncate text-[13px]">{project.name}</span>
      </span>
    );
  }
  const page = result as ConfluencePageResult;
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-[13px] font-medium">{page.title}</span>
      <span className="truncate text-xs text-asst-faint">{shortCrumb(breadcrumb(page).slice(0, -1))}</span>
    </span>
  );
}

export interface AtlassianSearchProps {
  kind: LookupKind;
  /** The box's accessible name, which says what is being chosen. */
  label: string;
  placeholder: string;
  /** For a Confluence page: the space to search first, which the person can widen to all of Confluence. */
  scope?: { key: string; name: string } | null;
  access: JiraAccess;
  onPick: (result: LookupResult) => void;
  onCancel: () => void;
  lookUp?: LookUp;
}

export function AtlassianSearch({ kind, label, placeholder, scope = null, access, onPick, onCancel, lookUp = fetchLookup }: AtlassianSearchProps) {
  const listId = useId();
  const box = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [scoped, setScoped] = useState(scope !== null);
  const [shown, setShown] = useState<Shown>(IDLE);
  const [active, setActive] = useState(0);
  // Bumped to run the same search again: while the assistant starts, and once a sign-in has finished.
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);
  const space = scoped && scope !== null ? scope.key : null;
  const results = shown.phase === "found" ? shown.results : [];
  const current = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    box.current?.focus();
  }, []);

  // A sign-in the person started here has finished when the page re-renders with its Atlassian login no longer
  // pending; that is when to search again. Only that change counts: a stored sign-in the pod could not use is still
  // `signed_out`, and searching again on every render would never stop.
  const loginState = access.login?.kind === "atlassian" ? access.login.state : null;
  const lastLogin = useRef(loginState);
  useEffect(() => {
    const was = lastLogin.current;
    lastLogin.current = loginState;
    if (shown.phase === "signing_in" && was === "pending" && loginState !== "pending") {
      setAttempt((n) => n + 1);
    }
  }, [loginState, shown.phase]);

  useEffect(() => {
    // `attempt` is read so a retry runs this again with the same query.
    void attempt;
    if (!searchable(query)) {
      setShown(IDLE);
      return;
    }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    setShown((previous) => (previous.phase === "waking" ? previous : { phase: "searching", results: previous.results }));
    setActive(0);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const answer = await lookUp({ kind, query, space }, controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          if (answer.status === "done") {
            retries.current = 0;
            setShown({ phase: "found", results: answer.results });
          } else if (answer.status === "waking") {
            setShown({ phase: "waking", results: [] });
            if (retries.current < WAKING_RETRIES) {
              retries.current += 1;
              retry = setTimeout(() => setAttempt((n) => n + 1), WAKING_RETRY_MS);
            }
          } else if (answer.status === "failed") {
            setShown({ phase: "failed", results: [], detail: answer.detail });
          } else {
            setShown({ phase: answer.status, results: [] });
          }
        } catch {
          // An aborted request is the next keystroke replacing this one, not a failure to report.
          if (!controller.signal.aborted) {
            setShown({ phase: "failed", results: [], detail: "The search could not reach the hub. Check your connection and try again." });
          }
        }
      })();
    }, LOOKUP_AFTER_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(retry);
      controller.abort();
    };
  }, [query, space, kind, attempt, lookUp]);

  async function signIn(): Promise<void> {
    setShown({ phase: "signing_in", results: [] });
    const answer = await lookUp({ kind, query, space, signIn: true }, new AbortController().signal).catch(() => null);
    if (answer === null || answer.status === "failed") {
      setShown({ phase: "failed", results: [], detail: answer?.detail ?? "The sign-in could not be started. Try again." });
    } else if (answer.status !== "signing_in") {
      setShown({ phase: answer.status === "done" ? "found" : answer.status, results: answer.status === "done" ? answer.results : [] });
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      // Escape closes the search and nothing behind it: the panel and the dialog both close on Escape as well.
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
        onPick(chosen);
      }
    }
  }

  const login = access.login?.kind === "atlassian" && access.login.state === "pending" ? access.login : null;
  return (
    <div className="flex basis-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          ref={box}
          type="search"
          value={query}
          maxLength={MAX_LOOKUP_QUERY}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={label}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={current === -1 ? undefined : optionId(current)}
          className="min-w-0 flex-1 rounded-[9px] border border-asst-strong bg-asst-field px-3 py-[7px] text-[13px] text-asst-text outline-none placeholder:text-asst-faint focus:border-asst-accent-line"
        />
        <button type="button" onClick={onCancel} className="shrink-0 text-xs text-asst-muted underline hover:text-asst-text">
          Cancel
        </button>
      </div>
      {scope === null ? null : (
        <label className="flex items-center gap-2 text-xs text-asst-muted">
          <input type="checkbox" checked={scoped} onChange={(event) => setScoped(event.target.checked)} className="h-3.5 w-3.5 accent-asst-accent" />
          Only in {scope.name}
        </label>
      )}
      {/* Mounted whether or not there is anything to say, because a live region that appears with its text is not reliably read. */}
      <p role="status" className="text-xs text-asst-faint empty:hidden">
        {summary(kind, shown)}
      </p>
      {shown.phase === "signed_out" ? (
        <button
          type="button"
          onClick={() => void signIn()}
          className="self-start rounded-[9px] border border-asst-strong px-3 py-1.5 text-xs font-medium text-asst-text hover:bg-asst-active"
        >
          Sign in to Atlassian
        </button>
      ) : null}
      {shown.phase === "signing_in" && login !== null ? <SignInPrompt login={login} /> : null}
      <div
        id={listId}
        role="listbox"
        aria-label={kind === "jira_project" ? "Jira projects found" : "Confluence pages found"}
        hidden={results.length === 0}
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-[9px] border border-asst-line bg-asst-field p-1"
      >
        {results.map((result, index) => (
          <div
            key={"key" in result ? result.key : result.id}
            id={optionId(index)}
            role="option"
            tabIndex={-1}
            aria-selected={index === current}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(result)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onPick(result);
              }
            }}
            className={`cursor-pointer rounded-md px-2.5 py-1.5 ${index === current ? "bg-asst-active text-asst-text" : "text-asst-body hover:bg-asst-raised"}`}
          >
            <Option result={result} />
          </div>
        ))}
      </div>
    </div>
  );
}
