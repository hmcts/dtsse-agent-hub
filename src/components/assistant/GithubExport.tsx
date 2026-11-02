"use client";

import { useId, useState } from "react";
import { type GithubExportView, readGithubRepo } from "@/assistant/github";
import type { ActionResult } from "@/web/action";

export type ExportToGithubAction = (input: { conversationId: unknown; repo: unknown }) => Promise<ActionResult>;

export interface GithubExportProps {
  exported: GithubExportView;
  exportTo: ExportToGithubAction;
  /** The person's own default repository, as `owner/name`, which the panel starts from; none leaves the field empty. */
  defaultRepo?: string | null;
}

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
      <span className="min-w-0 flex-1 truncate font-plex-mono text-asst-body">
        {exported.repo}#{exported.number}
      </span>
      <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
        Open issue
      </a>
    </div>
  );
}

/** Why the button waits, if it does: there is nothing written yet, changes GitHub would not get, or no repository. */
function blockedBy(written: boolean, saved: boolean, repo: string | undefined): string | null {
  if (!written) {
    return "Write the document to export it.";
  }
  if (!saved) {
    return "Waiting for the document to save.";
  }
  return repo === undefined ? "Name the repository as owner/name, such as hmcts/cft-workspace." : null;
}

/** The repository offered before the person types one: the export's own, else their default, else nothing. */
function startingRepo(exported: GithubExportView, chosen: string | null | undefined): string {
  if (exported.status !== "none" && exported.repo !== null) {
    return exported.repo;
  }
  return chosen ?? "";
}

/**
 * The GitHub half of the export footer, for a person whose ticket tool is GitHub: the repository to open the issue
 * in and the button that does, then the issue it became. A document goes to GitHub once; after that the issue takes
 * the repository's place. The repository is typed rather than searched for, since `owner/name` is what anyone who
 * uses GitHub already knows it by; a change here is for this document only, and the default is in the settings.
 */
export function GithubFooter({
  conversationId,
  exported,
  exportTo,
  defaultRepo,
  saved,
  written
}: GithubExportProps & { conversationId: string; saved: boolean; written: boolean }) {
  const [typed, setTyped] = useState(() => startingRepo(exported, defaultRepo));
  // The export as the page showed it when the person clicked: until the page shows it changed, the click is what is
  // pending, so the button does not come back in the moment before the page catches up.
  const shownExport = exported.status === "failed" ? `failed:${exported.error}` : exported.status;
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = `github-hint-${conversationId}`;
  const repo = readGithubRepo(typed);

  async function start(): Promise<void> {
    setClickedAt(shownExport);
    setError(null);
    const result = await exportTo({ conversationId, repo });
    if (!result.ok) {
      setClickedAt(null);
      setError(result.error);
    }
  }

  if (exported.status === "done") {
    return (
      <div role="status" className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2.5 text-[13px]">
        <span className="min-w-0 truncate font-medium text-asst-ok">
          ✓ Created{" "}
          <span className="font-plex-mono">
            {exported.repo}#{exported.number}
          </span>
        </span>
        <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
          View on GitHub
        </a>
      </div>
    );
  }

  const pending = clickedAt === shownExport || exported.status === "pending";
  const blocked = pending ? null : blockedBy(written, saved, repo);
  const failure = exported.status === "failed" && !pending ? exported.error : null;
  const shown = error ?? failure;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
      <div className="flex min-w-0 flex-[1_1_220px] items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field">
        <label htmlFor={fieldId} className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">
          Repository
        </label>
        <input
          id={fieldId}
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          disabled={pending}
          placeholder="owner/name"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={blocked === null ? undefined : hintId}
          className="min-w-0 flex-1 bg-transparent px-2.5 py-[7px] font-plex-mono text-[13px] text-asst-text outline-hidden disabled:opacity-60"
        />
      </div>
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
