"use client";

import { useState } from "react";
import { type GithubExportView, type GithubProjectChoice, repoOwner, sameOwner } from "@/assistant/github";
import type { GithubProjectResult, GithubRepoResult } from "@/assistant/lookups";
import { AtlassianSearch } from "@/components/assistant/AtlassianSearch";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";
import type { ActionResult } from "@/web/action";

export type ExportToGithubAction = (input: { conversationId: unknown; repo: unknown; project: unknown }) => Promise<ActionResult>;

export interface GithubExportProps {
  exported: GithubExportView;
  exportTo: ExportToGithubAction;
  /** The person's own default repository, as `owner/name`, which the panel starts from; none leaves it to choose. */
  defaultRepo?: string | null;
  /** The person's own default Project, offered only while the repository chosen is one of its owner's. */
  defaultProject?: GithubProjectChoice | null;
  /** The search the pickers run; a test passes its own. */
  lookUp?: LookUp;
}

/** gh is signed in on every pod, so a GitHub search never waits on a sign-in. */
const SIGNED_IN: JiraAccess = { connected: true, login: null };

/** Above the document once it is an issue, so the link back is there whichever way the panel is scrolled. */
export function GithubBanner({ exported }: { exported: GithubExportView }) {
  if (exported.status !== "done") {
    return null;
  }
  return (
    <div role="status" className="flex shrink-0 items-center gap-2.5 border-b border-asst-field bg-asst-accent/10 px-4 py-2 text-[13px]">
      <span className="shrink-0 rounded-md bg-asst-accent px-[7px] py-[3px] font-plex-mono text-[11px] font-medium uppercase leading-none tracking-wider text-asst-ink">
        On GitHub
      </span>
      <span className="min-w-0 flex-1 truncate text-asst-body">
        <span className="font-plex-mono">
          {exported.repo}#{exported.number}
        </span>
        {exported.project === null || exported.projectError !== null ? null : <> · {exported.project.title}</>}
      </span>
      <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
        Open issue
      </a>
    </div>
  );
}

/** Why the button waits, if it does: there is nothing written yet, changes GitHub would not get, or no repository. */
function blockedBy(written: boolean, saved: boolean, repo: string | null): string | null {
  if (!written) {
    return "Write the document to export it.";
  }
  if (!saved) {
    return "Waiting for the document to save.";
  }
  return repo === null ? "Choose the repository the issue goes in." : null;
}

/** The repository and Project offered before the person picks: the export's own, else their defaults. */
function starting(
  exported: GithubExportView,
  repo: string | null | undefined,
  project: GithubProjectChoice | null | undefined
): { repo: string | null; project: GithubProjectChoice | null } {
  if (exported.status !== "none" && exported.repo !== null) {
    return { repo: exported.repo, project: exported.project };
  }
  const chosen = repo ?? null;
  // A default Project of another owner's is not one this repository's issues are offered.
  return { repo: chosen, project: chosen !== null && project && sameOwner(project.owner, repoOwner(chosen)) ? project : null };
}

/** One line of the footer: what is chosen, and a way to search for another, or to take it off. */
function Picked({
  label,
  children,
  change,
  clear,
  disabled
}: {
  label: string;
  children: React.ReactNode;
  /** `text` is "Choose" while nothing is chosen, else "Change"; `label` says which, and what to, for a screen reader. */
  change: { text: string; label: string; onClick: () => void };
  clear?: { label: string; onClick: () => void };
  disabled: boolean;
}) {
  return (
    // A whole row each, so a long repository or Project title has the width to be read, with the button beneath.
    <div className="flex min-w-0 basis-full items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field">
      <span className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate px-2.5 py-[7px] text-[13px]">{children}</span>
      {disabled ? null : (
        <>
          {clear === undefined ? null : (
            <button type="button" onClick={clear.onClick} aria-label={clear.label} className="shrink-0 pl-2.5 text-xs text-asst-muted underline">
              Remove
            </button>
          )}
          <button type="button" onClick={change.onClick} aria-label={change.label} className="shrink-0 px-2.5 text-xs text-asst-accent underline">
            {change.text}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The GitHub half of the export footer, for a person whose ticket tool is GitHub: the repository the issue goes in, a
 * Project to put it on if they want one, and the button, then the issue it became. A repository is where an issue
 * lives; a Project is a board showing issues from any number of repositories, so it is searched for in the chosen
 * repository's owner and may be left out. Both are found by searching the person's own GitHub, as them. A change here
 * is for this document only; the defaults are in the settings.
 */
export function GithubFooter({
  conversationId,
  exported,
  exportTo,
  defaultRepo,
  defaultProject,
  lookUp,
  saved,
  written
}: GithubExportProps & { conversationId: string; saved: boolean; written: boolean }) {
  const [chosen, setChosen] = useState(() => starting(exported, defaultRepo, defaultProject));
  const [searching, setSearching] = useState<"repo" | "project" | null>(null);
  // The export as the page showed it when the person clicked: until the page shows it changed, the click is what is
  // pending, so the button does not come back in the moment before the page catches up.
  const shownExport = exported.status === "failed" ? `failed:${exported.error}` : exported.status;
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hintId = `github-hint-${conversationId}`;

  async function start(): Promise<void> {
    setClickedAt(shownExport);
    setError(null);
    const result = await exportTo({ conversationId, repo: chosen.repo, project: chosen.project });
    if (!result.ok) {
      setClickedAt(null);
      setError(result.error);
    }
  }

  if (exported.status === "done") {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div role="status" className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2.5 text-[13px]">
          <span className="min-w-0 truncate font-medium text-asst-ok">
            ✓ Created{" "}
            <span className="font-plex-mono">
              {exported.repo}#{exported.number}
            </span>
            {exported.project === null || exported.projectError !== null ? null : <span className="font-normal"> on {exported.project.title}</span>}
          </span>
          <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
            View on GitHub
          </a>
        </div>
        {exported.project === null || exported.projectError === null ? null : (
          <p role="alert" className="text-xs text-asst-error">
            It is not on {exported.project.title}: {exported.projectError}.
          </p>
        )}
      </div>
    );
  }

  const pending = clickedAt === shownExport || exported.status === "pending";
  const blocked = pending ? null : blockedBy(written, saved, chosen.repo);
  const failure = exported.status === "failed" && !pending ? exported.error : null;
  const shown = error ?? failure;
  const owner = chosen.repo === null ? null : repoOwner(chosen.repo);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
      {searching === "repo" ? (
        <AtlassianSearch
          kind="github_repo"
          label="Search your GitHub repositories"
          placeholder="Type a repository's name, or owner/name"
          access={SIGNED_IN}
          lookUp={lookUp}
          onCancel={() => setSearching(null)}
          onPick={(result) => {
            const repo = (result as GithubRepoResult).full_name;
            // A Project of another owner's does not go with this repository.
            setChosen((now) => ({ repo, project: now.project && sameOwner(now.project.owner, repoOwner(repo)) ? now.project : null }));
            setSearching(null);
          }}
        />
      ) : (
        <Picked
          label="Repository"
          disabled={pending}
          change={{
            text: chosen.repo === null ? "Choose" : "Change",
            label: chosen.repo === null ? "Choose the GitHub repository" : `Change the GitHub repository, now ${chosen.repo}`,
            onClick: () => setSearching("repo")
          }}
        >
          {chosen.repo === null ? null : <span className="font-plex-mono font-medium text-asst-text">{chosen.repo}</span>}
        </Picked>
      )}
      {owner === null ? null : searching === "project" ? (
        <AtlassianSearch
          kind="github_project"
          label={`Search ${owner}'s GitHub Projects`}
          placeholder="Type a few words of its title, or paste its link"
          owner={owner}
          access={SIGNED_IN}
          lookUp={lookUp}
          onCancel={() => setSearching(null)}
          onPick={(result) => {
            const project = result as GithubProjectResult;
            setChosen((now) => ({ ...now, project: { owner: project.owner, number: project.number, title: project.title } }));
            setSearching(null);
          }}
        />
      ) : (
        <Picked
          label="Project"
          disabled={pending}
          change={{
            text: chosen.project === null ? "Choose" : "Change",
            label: chosen.project === null ? "Choose a GitHub Project to add the issue to" : `Change the GitHub Project, now ${chosen.project.title}`,
            onClick: () => setSearching("project")
          }}
          clear={chosen.project === null ? undefined : { label: "Add it to no Project", onClick: () => setChosen((now) => ({ ...now, project: null })) }}
        >
          {chosen.project === null ? <span className="text-asst-faint">None</span> : <span className="font-medium text-asst-text">{chosen.project.title}</span>}
        </Picked>
      )}
      {pending ? (
        <span role="status" className="flex h-[34px] shrink-0 items-center text-[13px] text-asst-accent-soft">
          Creating issue…
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={blocked !== null}
          aria-describedby={blocked === null ? undefined : hintId}
          className="flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] bg-asst-accent px-3.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40"
        >
          <span aria-hidden="true">↗</span>
          <span>Create GitHub issue</span>
        </button>
      )}
      {blocked === null ? null : (
        <p id={hintId} className="basis-full text-xs text-asst-faint">
          {blocked}
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
