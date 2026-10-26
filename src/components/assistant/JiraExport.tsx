"use client";

import { useEffect, useState } from "react";
import { DEFAULT_JIRA_PROJECT, JIRA_BOARDS, type JiraExportView } from "@/assistant/jira";
import { LoginCountdown } from "@/components/virtual-agents/LoginCountdown";
import type { LoginView } from "@/virtual-agents/logins";
import type { ActionResult } from "@/web/action";

export type ExportToJiraAction = (input: { conversationId: unknown; project: unknown }) => Promise<ActionResult>;

/** Whether the person's assistant can reach Jira as them, and the Atlassian sign-in it is waiting on, if any. */
export interface JiraAccess {
  connected: boolean;
  login: LoginView | null;
}

export interface JiraExportProps {
  exported: JiraExportView;
  access: JiraAccess;
  exportTo: ExportToJiraAction;
}

/** Above the document once it is in Jira, so the link back is there whichever way the panel is scrolled. */
export function JiraBanner({ exported }: { exported: JiraExportView }) {
  if (exported.status !== "done") {
    return null;
  }
  return (
    <div role="status" className="flex shrink-0 items-center gap-2.5 border-b border-asst-field bg-asst-accent/10 px-4 py-2 text-[13px]">
      <span className="shrink-0 rounded-md bg-asst-accent px-[7px] py-[3px] font-plex-mono text-[11px] font-medium uppercase leading-none tracking-wider text-asst-ink">
        In Jira
      </span>
      <span className="min-w-0 flex-1 text-pretty text-asst-body">
        <span className="font-plex-mono">{exported.key}</span> · {exported.project} backlog
      </span>
      <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
        Open ticket
      </a>
    </div>
  );
}

/** Where the Atlassian sign-in an export is waiting on has got to, which decides what the footer may claim. */
export type SignInStage = "live" | "renewing" | "given-up" | "none";

/**
 * A code is `live` only while it can still be used: a dead code under "Signing in to Atlassian…" is worse than
 * saying nothing, because it sends somebody off to use it.
 *
 * The clock decides as much as the state does, because neither the pod's report that it has run out of codes nor the
 * hub's sweep lands the instant a code's time is up. A `pending` login past its expiry is therefore `renewing`: the
 * pod relays a second code, so one more is usually on its way, and the half-minute when it is the last code rather
 * than the next reads as the `given-up` it is about to become.
 */
export function signInStage(login: LoginView | null | undefined, now: number): SignInStage {
  if (login === null || login === undefined || login.kind !== "atlassian") {
    return "none";
  }
  if (login.state === "expired" || login.state === "failed") {
    return "given-up";
  }
  if (login.state !== "pending") {
    return "none";
  }
  return new Date(login.expiresAt).getTime() > now ? "live" : "renewing";
}

/** What the footer says about the sign-in, beside the controls, or `null` when the code itself is the thing to show. */
export function signInNote(stage: SignInStage): string | null {
  if (stage === "renewing") {
    return "That code's time ran out. Your assistant is relaying a fresh one, which will replace it here.";
  }
  if (stage === "given-up") {
    return "The Atlassian sign-in expired before it was used, so no ticket was created. Export again for a fresh code.";
  }
  return null;
}

/** The Atlassian sign-in the assistant needs before it can create the ticket, as a code to enter on a page. */
function SignInPrompt({ login }: { login: LoginView }) {
  if (login.prompt !== "device_code" || login.userCode === null) {
    return <p className="basis-full text-xs text-asst-muted">Your assistant is waiting for you to sign in to Atlassian.</p>;
  }
  return (
    <p className="basis-full text-[13px] text-asst-body">
      To finish, open{" "}
      <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
        the Atlassian sign-in page
      </a>{" "}
      and enter{" "}
      <code className="rounded-md border border-asst-strong bg-asst-field px-2 py-0.5 font-plex-mono tracking-widest text-asst-text">{login.userCode}</code>{" "}
      <LoginCountdown expiresAt={login.expiresAt} />
    </p>
  );
}

/** Why the button waits, if it does: there is nothing written yet, or changes Jira would not get. */
function blockedBy(written: boolean, saved: boolean): string | null {
  if (!written) {
    return "Write the document to export it.";
  }
  return saved ? null : "Waiting for the document to save.";
}

/** The line under the footer's controls, if any: why the button waits, or that a sign-in comes first. */
function footerHint(idle: boolean, blocked: string | null, connected: boolean): string | null {
  if (!idle) {
    return null;
  }
  return blocked ?? (connected ? null : "You'll be asked to sign in to Atlassian, so the ticket is created as you.");
}

function BoardPicker({ project, onChange, disabled }: { project: string; onChange: (project: string) => void; disabled: boolean }) {
  return (
    <label className="flex min-w-0 flex-[1_1_220px] items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field focus-within:border-asst-accent-line">
      <span className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">Target board</span>
      <select
        value={project}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label="Jira board"
        className="min-w-0 flex-1 cursor-pointer bg-transparent px-2.5 py-[7px] text-[13px] font-medium text-asst-text outline-none disabled:cursor-default"
      >
        {JIRA_BOARDS.map((board) => (
          <option key={board.project} value={board.project} className="bg-asst-field">
            {board.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The ticket once there is one, what is happening while the export runs, or the button that starts it. */
function JiraAction({
  exported,
  pending,
  signingIn,
  connected,
  blocked,
  describedBy,
  onExport
}: {
  exported: JiraExportView;
  pending: boolean;
  signingIn: boolean;
  connected: boolean;
  blocked: boolean;
  describedBy: string | undefined;
  onExport: () => void;
}) {
  if (exported.status === "done") {
    return (
      <div role="status" className="flex h-[34px] shrink-0 items-center gap-2.5 text-[13px]">
        <span className="font-medium text-asst-ok">
          ✓ Created <span className="font-plex-mono">{exported.key}</span>
        </span>
        <a href={exported.url} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
          View in Jira
        </a>
      </div>
    );
  }
  if (pending) {
    return (
      <span role="status" className="flex h-[34px] shrink-0 items-center text-[13px] text-asst-accent-soft">
        {signingIn ? "Signing in to Atlassian…" : "Creating ticket…"}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onExport}
      disabled={blocked}
      aria-describedby={describedBy}
      className="flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] bg-asst-accent px-3.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40"
    >
      <span aria-hidden="true">↗</span>
      <span>{connected ? "Export to Jira backlog" : "Connect Jira and export"}</span>
    </button>
  );
}

/**
 * Below the document: the board to send it to and the button that does, then the ticket it became. A document goes
 * to Jira once; after that this shows the ticket instead. `saved` is false while the panel has changes Jira would
 * not get, so the button waits for them.
 */
export function JiraFooter({
  conversationId,
  exported,
  access,
  exportTo,
  saved,
  written
}: JiraExportProps & { conversationId: string; saved: boolean; written: boolean }) {
  const [project, setProject] = useState(exported.status === "none" || exported.project === null ? DEFAULT_JIRA_PROJECT : exported.project);
  // The export as the page showed it when the person clicked: until the page shows it changed, the click is what
  // is pending, so the button does not come back in the moment before the page catches up.
  const shownExport = exported.status === "failed" ? `failed:${exported.error}` : exported.status;
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setClickedAt(shownExport);
    setError(null);
    const result = await exportTo({ conversationId, project });
    if (!result.ok) {
      setClickedAt(null);
      setError(result.error);
    }
  }

  // Ticking rather than read once, because the code's time running out is the moment this footer has to stop
  // offering it, and nothing else on the page changes then. Null until the browser has a clock, so the first
  // render matches the server's.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const pending = clickedAt === shownExport || exported.status === "pending";
  const stage = signInStage(access.login, now ?? 0);
  const note = pending ? signInNote(stage) : null;
  const blocked = blockedBy(written, saved);
  const failure = exported.status === "failed" && !pending ? exported.error : null;
  const shown = error ?? failure;
  const hint = footerHint(!pending && exported.status !== "done", blocked, access.connected);
  const hintId = `jira-hint-${conversationId}`;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-asst-line bg-asst-panel px-4 py-3">
      <BoardPicker project={project} onChange={setProject} disabled={pending || exported.status === "done"} />
      <JiraAction
        exported={exported}
        pending={pending}
        signingIn={stage === "live" || stage === "renewing"}
        connected={access.connected}
        blocked={blocked !== null}
        describedBy={hint === null ? undefined : hintId}
        onExport={() => void start()}
      />
      {hint === null ? null : (
        <p id={hintId} className="basis-full text-xs text-asst-faint">
          {hint}
        </p>
      )}
      {pending && stage === "live" && access.login ? <SignInPrompt login={access.login} /> : null}
      {note === null ? null : (
        <p role="alert" className="basis-full text-[13px] text-asst-error">
          {note}
        </p>
      )}
      {shown === null ? null : (
        <p role="alert" className="basis-full text-xs text-asst-error">
          {shown}
        </p>
      )}
    </div>
  );
}
