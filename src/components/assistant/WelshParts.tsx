"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WelshFileView, WelshResponse } from "@/assistant/welsh";
import { messageOf, safeLink } from "@/assistant/welsh-views";
import { runWelshJob, type WelshClient, type WelshJobRequest, welshDownloadUrl } from "@/components/assistant/welshClient";

/** The pieces every section of the Welsh page shares: a job's state, what it says about it, and its downloads. */

export const PRIMARY =
  "rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
export const SECONDARY =
  "rounded-[10px] border border-asst-line px-3.5 py-2 text-[13px] font-medium text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD = "rounded-lg border border-asst-line bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text";
export const LINK = "text-asst-accent underline hover:text-asst-accent-hover";

export type JobPhase = "idle" | "waking" | "pending" | "done" | "failed";

export interface JobState {
  phase: JobPhase;
  /** Set once the job is over. */
  response?: WelshResponse;
}

/** One job at a time per section: starting another abandons the one before, whose answer then changes nothing. */
export function useWelshJob(client: WelshClient) {
  const [state, setState] = useState<JobState>({ phase: "idle" });
  const current = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  const run = useCallback(
    async (request: WelshJobRequest): Promise<WelshResponse | undefined> => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      setState({ phase: "pending" });
      const response = await runWelshJob(client, request, {
        signal: controller.signal,
        onProgress: (phase) => {
          if (!controller.signal.aborted) {
            setState({ phase });
          }
        }
      }).catch((): WelshResponse => ({ status: "failed", detail: "That did not work. Check your connection and try again." }));
      if (controller.signal.aborted) {
        return undefined;
      }
      setState({ phase: response.status === "done" ? "done" : "failed", response });
      return response;
    },
    [client]
  );

  const reset = useCallback(() => {
    current.current?.abort();
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset };
}

/** What the person is told about a job that is not done, in words they can act on. */
export function problemText(response: WelshResponse | undefined): string {
  switch (response?.status) {
    case "signed_out":
    case "failed":
      return response.detail;
    case "unsupported":
      return "Your assistant needs an update to do this. It gets one the next time it restarts.";
    case "timeout":
      return "Your assistant did not answer in time. It may have restarted; try again.";
    case "waking":
      return "Your assistant is still starting. Try again in a minute.";
    default:
      return "";
  }
}

const WAKING = "Your assistant is starting. This takes a minute or two, then this carries on by itself.";

/**
 * Where a job has got to: an always-mounted `<output>` live region for progress, so a screen reader hears each change,
 * and an alert when it failed.
 */
export function JobStatus({ state, working }: Readonly<{ state: JobState; working: string }>) {
  const progress: Record<JobPhase, string> = { idle: "", pending: working, waking: WAKING, done: "", failed: "" };
  return (
    <>
      <output className="block text-[13px] text-asst-muted">{progress[state.phase]}</output>
      {state.phase === "failed" ? (
        <p role="alert" className="text-[13px] text-asst-error">
          {problemText(state.response)}
        </p>
      ) : null}
    </>
  );
}

/** The spreadsheets a job made, to download. */
export function Downloads({ files, label }: Readonly<{ files: readonly WelshFileView[]; label: string }>) {
  if (files.length === 0) {
    return null;
  }
  return (
    <ul aria-label={label} className="flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.file_id} className="text-[13px]">
          <a href={welshDownloadUrl(file.file_id)} download={file.name} className={LINK}>
            Download {file.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A pull request or Jira link: a link only to GitHub or HMCTS Atlassian, otherwise the address as text. */
export function OutLink({ url, children }: Readonly<{ url: string | null; children: React.ReactNode }>) {
  const safe = safeLink(url);
  if (safe === null) {
    return url ? <span className="break-all text-[13px] text-asst-muted">{url}</span> : null;
  }
  return (
    <a href={safe} target="_blank" rel="noreferrer" className={`${LINK} text-[13px]`}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** What the Welsh tools said, folded away: useful when a figure needs explaining, noise otherwise. */
export function ToolMessage({ result }: Readonly<{ result: Record<string, unknown> }>) {
  const message = messageOf(result);
  if (message === "") {
    return null;
  }
  return (
    <details className="text-xs text-asst-muted">
      <summary className="cursor-pointer">What the Welsh tools said</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-asst-field px-2.5 py-2 font-plex-mono text-xs leading-5 text-asst-text">
        {message}
      </pre>
    </details>
  );
}

/** Done, with its result; anything else reads as nothing to show. */
export function doneResult(state: JobState): { result: Record<string, unknown>; files: WelshFileView[] } | null {
  return state.response?.status === "done" ? { result: state.response.result, files: state.response.files } : null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/**
 * Why a string needs the person to choose, in words that do not assume they know Welsh grammar. Welsh answers a yes/no
 * question by repeating its verb, so a catalogue's "Yes" is only right for the question it was translated for.
 */
export function choiceReason(english: string, options: number): string {
  if (options > 1) {
    return `The catalogue has ${options} different approved translations of this. Pick the one meant for this screen.`;
  }
  const word = english.trim();
  if (/^yes$/i.test(word) || /^no$/i.test(word)) {
    const examples = /^yes$/i.test(word) ? "“Ydw” is “yes, I am”, “Oes” is “yes, there is”" : "“Nac ydw” is “no, I'm not”, “Nac oes” is “no, there isn't”";
    return `In Welsh, “${word}” changes with the question (${examples}). The catalogue's translation was approved for a different question, so check it fits this one.`;
  }
  return "The right Welsh for this depends on where it is used, and the catalogue's translation was approved for somewhere else. Check it fits here.";
}

/** A note that sits under every Welsh being shown: where it came from, and that nothing here makes it up. */
export function WelshSourceNote() {
  return (
    <p className="text-pretty text-xs text-asst-faint">
      All Welsh here comes from the Welsh Language Unit, through this service's approved catalogue or a spreadsheet they returned. Nothing on this page
      translates.
    </p>
  );
}

/** A numbered list of steps: what to do next is always the lowest step not yet done. */
export function Steps({ children, label }: Readonly<{ children: React.ReactNode; label: string }>) {
  return (
    <ol aria-label={label} className="flex flex-col">
      {children}
    </ol>
  );
}

/**
 * One step: its number (a tick once done), its title, and what to do. The line down the left joins it to the next,
 * so the order reads at a glance without a box around each part.
 */
export function Step({
  n,
  title,
  done = false,
  summary,
  children
}: Readonly<{
  n: number;
  title: string;
  done?: boolean;
  summary?: React.ReactNode;
  children?: React.ReactNode;
}>) {
  return (
    <li className="group relative flex gap-3 pb-6 last:pb-0">
      <span aria-hidden="true" className="absolute left-[13px] top-7 bottom-0 w-px bg-asst-line group-last:hidden" />
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-asst-accent text-asst-ink" : "border border-asst-strong text-asst-muted"}`}
      >
        {done ? "✓" : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <h3 className="text-sm font-semibold">
          <span className="sr-only">{done ? `Step ${n}, done: ` : `Step ${n}: `}</span>
          {title}
          {summary ? <span className="ml-2 font-normal text-asst-muted">{summary}</span> : null}
        </h3>
        {children}
      </div>
    </li>
  );
}

/**
 * A label over its control, joined by `htmlFor`: `children` is given the id to put on the control. The label is its own
 * element, so no whitespace between it and the control is left to chance.
 */
export function Labelled({ label, children, className = "" }: Readonly<{ label: string; children: (id: string) => React.ReactNode; className?: string }>) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 text-[13px] text-asst-muted ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

/** Which of a service's repos to work on, by its name alone. */
export function RepoSelect({
  repos,
  value,
  onChange,
  label = "Repo"
}: Readonly<{ repos: readonly string[]; value: string; onChange: (repo: string) => void; label?: string }>) {
  return (
    <Labelled label={label}>
      {(id) => (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={`${FIELD} max-w-xs`}>
          {repos.map((r) => (
            <option key={r} value={r}>
              {repoName(r)}
            </option>
          ))}
        </select>
      )}
    </Labelled>
  );
}

export function repoName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Whether any of these jobs is still going, which disables what would start another. */
export function isBusy(...states: readonly JobState[]): boolean {
  return states.some((state) => state.phase === "pending" || state.phase === "waking");
}

/**
 * A write that happens as the person — a pull request, a Jira edit — behind two clicks: the first says what will
 * happen, the second does it. Nothing is written from the first.
 */
export function Confirm({
  ask,
  explain,
  confirm,
  busy,
  onConfirm
}: Readonly<{ ask: string; explain: React.ReactNode; confirm: string; busy: boolean; onConfirm: () => void }>) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <div>
        <button type="button" className={PRIMARY} disabled={busy} onClick={() => setConfirming(true)}>
          {ask}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-asst-field px-3 py-2 text-[13px]">
      <p>{explain}</p>
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} disabled={busy} onClick={onConfirm}>
          {confirm}
        </button>
        <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
