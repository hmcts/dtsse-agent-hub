"use client";

import { useState } from "react";
import { type ConfluenceExportView, type ConfluencePageChoice, DEFAULT_CONFLUENCE_PARENT } from "@/assistant/confluence";
import { breadcrumb, type ConfluencePageResult } from "@/assistant/lookups";
import { AtlassianSearch, shortCrumb } from "@/components/assistant/AtlassianSearch";
import { SignInPrompt } from "@/components/assistant/AtlassianSignIn";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";
import type { ActionResult } from "@/web/action";

export type ExportToConfluenceAction = (input: { conversationId: unknown; parent: unknown }) => Promise<ActionResult>;

export interface ConfluenceExportProps {
  exported: ConfluenceExportView;
  /** The same Atlassian sign-in the Jira export uses: twg signs in once for both. */
  access: JiraAccess;
  exportTo: ExportToConfluenceAction;
  /**
   * The person's own default parent page, which the panel starts from and whose space a search starts in; none falls
   * back to `DEFAULT_CONFLUENCE_PARENT`.
   */
  defaultPage?: ConfluencePageChoice | null;
  lookUp?: LookUp;
}

/**
 * What the banner says the document became, as the Jira one names the ticket and its backlog: the page, then where it
 * went. A page reported without its title, or a parent with none, falls back to what is known.
 */
export function confluenceBannerText(done: Pick<Extract<ConfluenceExportView, { status: "done" }>, "pageTitle" | "parentTitle" | "spaceName">): string {
  const page = done.pageTitle ?? "New page";
  return done.parentTitle === "" ? `${page} · in ${done.spaceName}` : `${page} · under ${done.parentTitle}`;
}

/** Above the document once it is in Confluence, so the link back is there whichever way the panel is scrolled. */
export function ConfluenceBanner({ exported }: { exported: ConfluenceExportView }) {
  if (exported.status !== "done") {
    return null;
  }
  return (
    <div role="status" className="flex shrink-0 items-center gap-2.5 border-b border-asst-field bg-asst-accent/10 px-4 py-2 text-[13px]">
      <span className="shrink-0 rounded-md bg-asst-accent px-[7px] py-[3px] font-plex-mono text-[11px] font-medium uppercase leading-none tracking-wider text-asst-ink">
        In Confluence
      </span>
      <span className="min-w-0 flex-1 truncate text-asst-body">{confluenceBannerText(exported)}</span>
      <a href={exported.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
        Open page
      </a>
    </div>
  );
}

type Chosen = ConfluencePageChoice;

function fromResult(page: ConfluencePageResult): Chosen {
  return { id: page.id, title: page.title, space_id: page.space_id, space_key: page.space_key, space_name: page.space_name, ancestors: page.ancestors };
}

/**
 * The page the document goes under: the one chosen, shown with where it is, and a way to search for another. A search
 * starts in the chosen page's space, which is the person's default space until they pick elsewhere, and can be widened
 * to all of Confluence.
 */
function ParentPicker({
  parent,
  onChange,
  disabled,
  access,
  lookUp
}: {
  parent: Chosen | null;
  onChange: (parent: Chosen) => void;
  disabled: boolean;
  access: JiraAccess;
  lookUp?: LookUp;
}) {
  // Closed to begin with even when nothing is chosen: opening it would take focus the moment the panel opened.
  const [searching, setSearching] = useState(false);
  if (searching && !disabled) {
    return (
      <AtlassianSearch
        kind="confluence_page"
        label="Search Confluence for the page to put it under"
        placeholder="Type a few words of the page's title, or paste its link"
        scope={parent === null ? null : { key: parent.space_key, name: parent.space_name }}
        access={access}
        lookUp={lookUp}
        onCancel={() => setSearching(false)}
        onPick={(result) => {
          onChange(fromResult(result as ConfluencePageResult));
          setSearching(false);
        }}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-[1_1_220px] items-center overflow-hidden rounded-[9px] border border-asst-strong bg-asst-field">
      <span className="shrink-0 whitespace-nowrap border-r border-asst-strong py-[7px] pl-3 pr-2.5 text-xs font-medium text-asst-muted">Under</span>
      {parent === null ? (
        <span className="min-w-0 flex-1 px-2.5 py-[7px] text-[13px] text-asst-faint">No page chosen</span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col px-2.5 py-1 leading-tight" title={breadcrumb(parent).join(" › ")}>
          <span className="truncate text-[13px] font-medium text-asst-text">{parent.title}</span>
          <span className="truncate text-[11px] text-asst-faint">{shortCrumb(breadcrumb(parent).slice(0, -1))}</span>
        </span>
      )}
      {disabled ? null : (
        <button
          type="button"
          onClick={() => setSearching(true)}
          aria-label={parent === null ? "Choose the Confluence page to put it under" : `Change the Confluence page, now ${parent.title}`}
          className="shrink-0 px-2.5 text-xs text-asst-accent underline"
        >
          {parent === null ? "Choose" : "Change"}
        </button>
      )}
    </div>
  );
}

function blockedBy(written: boolean, saved: boolean, parent: Chosen | null): string | null {
  if (!written) {
    return "Write the document to publish it.";
  }
  if (!saved) {
    return "Waiting for the document to save.";
  }
  return parent === null ? "Choose the page it goes under." : null;
}

/**
 * The Confluence half of the export footer: the page to put the document under and the button that publishes it,
 * then the page it became. Once only, as the Jira export is; the states and their wording follow that one.
 */
export function ConfluenceFooter({
  conversationId,
  exported,
  exportTo,
  defaultPage,
  lookUp,
  access,
  saved,
  written
}: ConfluenceExportProps & { conversationId: string; saved: boolean; written: boolean }) {
  const [parent, setParent] = useState<Chosen | null>(defaultPage ?? DEFAULT_CONFLUENCE_PARENT);
  const shownExport = exported.status === "failed" ? `failed:${exported.error}` : exported.status;
  const [clickedAt, setClickedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    if (parent === null) {
      return;
    }
    setClickedAt(shownExport);
    setError(null);
    const { ancestors: _, ...chosen } = parent;
    const result = await exportTo({ conversationId, parent: chosen });
    if (!result.ok) {
      setClickedAt(null);
      setError(result.error);
    }
  }

  const pending = clickedAt === shownExport || exported.status === "pending";
  const done = exported.status === "done" ? exported : null;
  const login = access.login?.kind === "atlassian" && access.login.state === "pending" ? access.login : null;
  const blocked = blockedBy(written, saved, parent);
  const failure = exported.status === "failed" && !pending ? exported.error : null;
  const shown = error ?? failure;
  const idle = !pending && done === null;
  const hint = idle ? (blocked ?? (access.connected ? null : "You'll be asked to sign in to Atlassian, so the page is created as you.")) : null;
  const hintId = `confluence-hint-${conversationId}`;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
      {done === null ? (
        <ParentPicker parent={parent} onChange={setParent} disabled={pending} access={access} lookUp={lookUp} />
      ) : (
        <div role="status" className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2.5 text-[13px]">
          <span className="min-w-0 truncate font-medium text-asst-ok">✓ Created {done.pageTitle ?? "the page"}</span>
          <a href={done.url} target="_blank" rel="noreferrer noopener" className="shrink-0 text-asst-accent underline">
            View in Confluence
          </a>
        </div>
      )}
      {done !== null ? null : pending ? (
        <span role="status" className="flex h-[34px] shrink-0 items-center text-[13px] text-asst-accent-soft">
          {login !== null ? "Signing in to Atlassian…" : "Creating page…"}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={blocked !== null}
          aria-describedby={hint === null ? undefined : hintId}
          className="flex h-[34px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] bg-asst-accent px-3.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40"
        >
          <span aria-hidden="true">↗</span>
          <span>{access.connected ? "Publish to Confluence" : "Connect Confluence and publish"}</span>
        </button>
      )}
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
