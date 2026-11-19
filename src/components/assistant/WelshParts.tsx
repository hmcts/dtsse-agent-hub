"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { WelshFileView, WelshKind, WelshResponse, WelshTask } from "@/assistant/welsh";
import { messageOf, safeLink } from "@/assistant/welsh-views";
import { fileSizeLabel } from "@/components/assistant/uploadClient";
import { runWelshJob, type WelshClient, type WelshJobRequest, welshDownloadUrl } from "@/components/assistant/welshClient";

/** The pieces every section of the Welsh page shares: a job's state, what it says about it, and its downloads. */

export const PRIMARY =
  "rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
export const SECONDARY =
  "rounded-[10px] border border-asst-line px-3.5 py-2 text-[13px] font-medium text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-50";
export const FIELD = "rounded-lg border border-asst-line bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text";
export const LINK = "text-asst-accent underline hover:text-asst-accent-hover";

type JobPhase = "idle" | "waking" | "pending" | "done" | "failed";

export interface JobState {
  phase: JobPhase;
  /** Set once the job is over. */
  response?: WelshResponse;
  /**
   * On a failed job that only reads, sends the same request again; `JobStatus` offers it as Try again. Never set for a
   * write: its step keeps its own button, which sends what the page says now rather than what was sent before.
   */
  retry?: () => void;
  /**
   * A write whose answer was lost — it timed out, or the connection dropped while the page waited — so it may still have
   * been done, and doing it again could open a second pull request or write a story twice.
   */
  unsure?: boolean;
}

/** The kinds that write somewhere outside the page: a pull request, a Jira story, or the service's catalogue. */
const WRITING_KINDS: readonly WelshKind[] = ["apply", "story_write", "import", "keep_english"];

/** One job at a time per section: starting another abandons the one before, whose answer then changes nothing. */
export function useWelshJob(client: WelshClient) {
  const [state, setState] = useState<JobState>({ phase: "idle" });
  const current = useRef<AbortController | null>(null);
  const runRef = useRef<(request: WelshJobRequest) => Promise<WelshResponse | undefined>>(async () => undefined);
  const lost = useRef(false);

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
      }).catch((): WelshResponse => {
        lost.current = true;
        return { status: "failed", detail: "That did not work. Check your connection and try again." };
      });
      const unanswered = lost.current || response.status === "timeout";
      lost.current = false;
      const writes = WRITING_KINDS.includes(request.kind);
      if (controller.signal.aborted) {
        return undefined;
      }
      setState(
        response.status === "done"
          ? { phase: "done", response }
          : {
              phase: "failed",
              response,
              // Not for one that needs an update: the same request would be refused the same way until the pod restarts.
              retry: writes || response.status === "unsupported" ? undefined : () => void runRef.current(request),
              unsure: writes && unanswered
            }
      );
      return response;
    },
    [client]
  );
  runRef.current = run;

  const reset = useCallback(() => {
    current.current?.abort();
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset };
}

/** What the person is told about a job that is not done, in words they can act on. */
function problemText(response: WelshResponse | undefined): string {
  switch (response?.status) {
    case "signed_out":
    case "failed":
      return response.detail;
    case "unsupported":
      return "Your assistant needs an update to do this. It gets one the next time it restarts.";
    case "timeout":
      return "Your assistant did not answer in time. It may have restarted. Try again.";
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
export function JobStatus({ state, working, busy = false }: Readonly<{ state: JobState; working: string; busy?: boolean }>) {
  const progress: Record<JobPhase, string> = { idle: "", pending: working, waking: WAKING, done: "", failed: "" };
  // A write whose answer was lost may still land, so the person is asked to look before sending it again.
  const unsure = state.unsure === true;
  return (
    <>
      <output className="block text-[13px] text-asst-muted">{progress[state.phase]}</output>
      {state.phase === "failed" ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-[13px] text-asst-error">
            {unsure ? "Your assistant did not answer in time, but it may still have done this. Check before you try again." : problemText(state.response)}
          </p>
          {/* Off while another job in the section runs, which is the one-job-at-a-time rule every other button keeps. */}
          {state.retry === undefined ? null : (
            <button type="button" className={SECONDARY} disabled={busy} onClick={state.retry}>
              Try again
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The spreadsheets a job made, to download, each with what kind of file it is and how big, and `next`: what to do with
 * them, since a spreadsheet on its own does not say who it is for.
 */
export function Downloads({ files, label, next }: Readonly<{ files: readonly WelshFileView[]; label: string; next?: string }>) {
  if (files.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={label} className="flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.file_id} className="text-[13px]">
            <a href={welshDownloadUrl(file.file_id)} download={file.name} className={LINK}>
              Download {file.name}
            </a>
            <span className="text-asst-muted"> ({fileFacts(file)})</span>
          </li>
        ))}
      </ul>
      {next === undefined ? null : <p className="text-pretty text-[13px] text-asst-body">{next}</p>}
    </div>
  );
}

/** "Excel spreadsheet, 24 KB": the kind of file from its name, and its size. */
export function fileFacts(file: Pick<WelshFileView, "name" | "bytes">): string {
  const kind = /\.xlsx$/i.test(file.name) ? "Excel spreadsheet" : /\.csv$/i.test(file.name) ? "CSV file" : "File";
  return `${kind}, ${fileSizeLabel(file.bytes)}`;
}

/** How a task's last step moves the person on to the task that follows it, with the service they have chosen. */
export const WelshTaskSwitch = createContext<(task: WelshTask) => void>(() => undefined);

/**
 * The task that usually comes next, at the end of one, so the person is not sent back to the list to find it. The
 * service stays chosen: it is the same service's Welsh either way.
 */
export function NextTask({ task, title, why }: Readonly<{ task: WelshTask; title: string; why: string }>) {
  const go = useContext(WelshTaskSwitch);
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-line px-4 py-3">
      <p className="text-xs text-asst-muted">Next</p>
      <button type="button" onClick={() => go(task)} className={`${LINK} self-start text-left text-sm font-semibold`}>
        {title}
      </button>
      <p className="text-pretty text-[13px] text-asst-body">{why}</p>
    </div>
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

/**
 * How many steps the task has, so each can say "Step 2 of 5". `null` while that is not known yet: a check's later steps
 * come and go with what it finds, so until it has run a step says only its own number.
 */
const StepsTotal = createContext<number | null>(null);

/** How a task tells the page its total once it knows it, so every step, the service's included, says the same total. */
export const ReportStepsTotal = createContext<(total: number | null) => void>(() => undefined);

/**
 * For a task whose steps follow what it finds: reports its total to the page as it changes, and takes it back as the
 * task closes, so the next task does not inherit it.
 */
export function useStepsTotal(total: number | null): void {
  const report = useContext(ReportStepsTotal);
  useEffect(() => {
    report(total);
  }, [report, total]);
  useEffect(() => () => report(null), [report]);
}

/** A numbered list of steps: what to do next is always the lowest step not yet done. */
export function Steps({ children, label, total = null }: Readonly<{ children: React.ReactNode; label: string; total?: number | null }>) {
  return (
    <ol aria-label={label} className="flex flex-col">
      <StepsTotal.Provider value={total}>{children}</StepsTotal.Provider>
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
  const total = useContext(StepsTotal);
  const place = total === null ? `Step ${n}` : `Step ${n} of ${total}`;
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
          {/* Said and shown, so how far there is to go reads without counting the circles. */}
          <span className="block text-xs font-normal text-asst-muted">
            {place}
            <span className="sr-only">{done ? ", done:" : ":"}</span>
          </span>
          {/* Its own node, so the space survives: one at the end of the hidden words is dropped from the heading's name. */} {title}
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
  label = "Which part of the service (code repository)"
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
