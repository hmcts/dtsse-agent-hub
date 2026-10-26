"use client";

import { useState } from "react";
import { DEFAULT_JIRA_PROJECT, JIRA_BOARDS, type JiraExportView, type JiraProjectChoice } from "@/assistant/jira";
import type { JiraProjectResult } from "@/assistant/lookups";
import { AtlassianSearch } from "@/components/assistant/AtlassianSearch";
import { SignInPrompt } from "@/components/assistant/AtlassianSignIn";
import type { LookUp } from "@/components/assistant/lookupClient";
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
  /** The person's own default project, which the panel starts from; none falls back to `DEFAULT_JIRA_PROJECT`. */
  defaultProject?: JiraProjectChoice | null;
  /** The search the project picker runs; a test passes its own. */
  lookUp?: LookUp;
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

/** The project offered before the person picks one: their default, else the hub's. */
function startingProject(exported: JiraExportView, chosen: JiraProjectChoice | null | undefined): JiraProjectChoice {
  if (exported.status !== "none" && exported.project !== null) {
    return { key: exported.project, name: chosen?.key === exported.project ? chosen.name : exported.project };
  }
  if (chosen) {
    return chosen;
  }
  const board = JIRA_BOARDS.find((entry) => entry.project === DEFAULT_JIRA_PROJECT);
  // The label leads with the key, which the picker already shows.
  return { key: DEFAULT_JIRA_PROJECT, name: board?.label.replace(`${DEFAULT_JIRA_PROJECT} · `, "") ?? DEFAULT_JIRA_PROJECT };
}

/**
 * The backlog the ticket goes to: the one chosen, with a way to search the person's own Jira for another. Any project
 * they can reach can be picked, and the change is for this document only; their default is in the settings.
 */
export function ProjectPicker({
  project,
  onChange,
  disabled,
  access,
  lookUp
}: {
  project: JiraProjectChoice;
  onChange: (project: JiraProjectChoice) => void;
  disabled: boolean;
  access: JiraAccess;
  lookUp?: LookUp;
}) {
  const [searching, setSearching] = useState(false);
  if (searching) {
    return (
      <AtlassianSearch
        kind="jira_project"
        label="Search your Jira projects"
        placeholder="Type a project's name or key"
        access={access}
        lookUp={lookUp}
        onCancel={() => setSearching(false)}
        onPick={(result) => {
          const picked = result as JiraProjectResult;
          onChange({ key: picked.key, name: picked.name });
          setSearching(false);
        }}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-[1_1_220px] items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field">
      <span className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">Backlog</span>
      <span className="min-w-0 flex-1 truncate px-2.5 py-[7px] text-[13px] font-medium text-asst-text">
        <span className="font-plex-mono">{project.key}</span>
        {project.name === project.key ? null : <span className="font-normal text-asst-body"> · {project.name}</span>}
      </span>
      {disabled ? null : (
        <button
          type="button"
          onClick={() => setSearching(true)}
          aria-label={`Change the Jira project, now ${project.key}`}
          className="shrink-0 px-2.5 text-xs text-asst-accent underline"
        >
          Change
        </button>
      )}
    </div>
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
 * The Jira half of the export footer: the backlog to send it to and the button that does, then the ticket it became.
 * A document goes to Jira once; after that this shows the ticket instead. `saved` is false while the panel has
 * changes Jira would not get, so the button waits for them.
 */
export function JiraFooter({
  conversationId,
  exported,
  access,
  exportTo,
  defaultProject,
  lookUp,
  saved,
  written
}: JiraExportProps & { conversationId: string; saved: boolean; written: boolean }) {
  const [chosen, setChosen] = useState(() => startingProject(exported, defaultProject));
  const project = chosen.key;
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
  const blocked = blockedBy(written, saved);
  const failure = exported.status === "failed" && !pending ? exported.error : null;
  const shown = error ?? failure;
  const hint = footerHint(!pending && exported.status !== "done", blocked, access.connected);
  const hintId = `jira-hint-${conversationId}`;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
      <ProjectPicker project={chosen} onChange={setChosen} disabled={pending || exported.status === "done"} access={access} lookUp={lookUp} />
      <JiraAction
        exported={exported}
        pending={pending}
        signingIn={login !== null}
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
      {pending && login !== null ? <SignInPrompt login={login} /> : null}
      {shown === null ? null : (
        <p role="alert" className="basis-full text-xs text-asst-error">
          {shown}
        </p>
      )}
    </div>
  );
}
