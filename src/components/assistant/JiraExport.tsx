"use client";

import { useState } from "react";
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

  const pending = clickedAt === shownExport || exported.status === "pending";
  const login = access.login?.kind === "atlassian" && access.login.state === "pending" ? access.login : null;
  const blocked = !written ? "Write the document to export it." : !saved ? "Waiting for the document to save." : null;
  const shown = error ?? (exported.status === "failed" && !pending ? exported.error : null);
  const idle = !pending && exported.status !== "done";
  const signInNotice = access.connected ? null : "You'll be asked to sign in to Atlassian, so the ticket is created as you.";
  const hint = idle ? (blocked ?? signInNotice) : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 border-t border-asst-line bg-asst-panel px-4 py-3">
      <label className="flex min-w-0 flex-[1_1_220px] items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field focus-within:border-asst-accent-line">
        <span className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">Target board</span>
        <select
          value={project}
          onChange={(event) => setProject(event.target.value)}
          disabled={pending || exported.status === "done"}
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
      {exported.status === "done" ? (
        <div role="status" className="flex h-[34px] shrink-0 items-center gap-2.5 text-[13px]">
          <span className="font-medium text-asst-ok">
            ✓ Created <span className="font-plex-mono">{exported.key}</span>
          </span>
          <a href={exported.url} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
            View in Jira
          </a>
        </div>
      ) : pending ? (
        <span role="status" className="flex h-[34px] shrink-0 items-center text-[13px] text-asst-accent-soft">
          {login === null ? "Creating ticket…" : "Signing in to Atlassian…"}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={blocked !== null}
          aria-describedby={hint === null ? undefined : `jira-hint-${conversationId}`}
          className="flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] bg-asst-accent px-3.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40"
        >
          <span aria-hidden="true">↗</span>
          <span>{access.connected ? "Export to Jira backlog" : "Connect Jira and export"}</span>
        </button>
      )}
      {hint === null ? null : (
        <p id={`jira-hint-${conversationId}`} className="basis-full text-xs text-asst-faint">
          {hint}
        </p>
      )}
      {pending && login !== null ? <SignInPrompt login={login} /> : null}
      {shown === null ? null : (
        <p role="alert" className="basis-full text-xs text-asst-error">
          {shown}
        </p>
      )}
    </div>
  );
}
