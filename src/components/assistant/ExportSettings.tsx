"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DEFAULT_CONFLUENCE_PARENT } from "@/assistant/confluence";
import type { DefaultConfluencePage, DefaultJiraProject, ExportDefaults } from "@/assistant/export-defaults";
import { DEFAULT_JIRA_PROJECT } from "@/assistant/jira";
import { breadcrumb, type ConfluencePageResult, type JiraProjectResult } from "@/assistant/lookups";
import { AtlassianSearch, shortCrumb } from "@/components/assistant/AtlassianSearch";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";
import type { ActionResult } from "@/web/action";

export type SaveExportDefaultsAction = (input: { jira: unknown; confluence: unknown }) => Promise<ActionResult<{ defaults: ExportDefaults }>>;

/** The export defaults as the settings edit them: what is stored, the action that replaces it, and the sign-in searches need. */
export interface AssistantExportDefaults {
  defaults: ExportDefaults;
  save: SaveExportDefaultsAction;
  access: JiraAccess;
  lookUp?: LookUp;
}

/** "(built-in)" after a default the person has not chosen, so they can tell it from one of their own. */
function BuiltIn() {
  return <span className="shrink-0 text-xs text-asst-faint">(built-in)</span>;
}

/**
 * One default: what it is now, and the search that changes it or the button that clears it. With none of their own,
 * the built-in one shows in its place, as what their documents go to, so there is always something to change; there
 * is nothing to clear until they pick their own.
 */
function Choice({
  id,
  label,
  hint,
  current,
  builtIn,
  onSearch,
  onClear,
  searching,
  children
}: {
  id: string;
  label: string;
  hint: string;
  current: React.ReactNode | null;
  builtIn: React.ReactNode;
  onSearch: () => void;
  onClear: () => void;
  searching: boolean;
  children: React.ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <p id={id} className="text-[13px] font-medium">
        {label}
      </p>
      <p className="text-pretty text-xs text-asst-muted">{hint}</p>
      {searching ? (
        children
      ) : (
        <div className="flex items-center gap-3 rounded-[10px] border border-asst-line px-3.5 py-2.5">
          <div className="min-w-0 flex-1">{current ?? builtIn}</div>
          <button type="button" onClick={onSearch} className="shrink-0 text-xs text-asst-accent underline">
            Change
          </button>
          {current === null ? null : (
            <button type="button" onClick={onClear} className="shrink-0 text-xs text-asst-muted underline hover:text-asst-text">
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Where the person's documents go by default: a Jira backlog and a Confluence page to put new pages under. The
 * document panel starts from these and can be changed there for one document; a Confluence search in the panel starts
 * in this page's space. Both are found by searching the person's own Jira and Confluence, as them.
 */
export function ExportSettings({ exports }: { exports: AssistantExportDefaults }) {
  const router = useRouter();
  const [jira, setJira] = useState<DefaultJiraProject | null>(exports.defaults.jira);
  const [confluence, setConfluence] = useState<DefaultConfluencePage | null>(exports.defaults.confluence);
  const [searching, setSearching] = useState<"jira" | "confluence" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = jira?.key !== exports.defaults.jira?.key || confluence?.id !== exports.defaults.confluence?.id;

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const result = await exports.save({ jira, confluence });
      setMessage(result.ok ? { ok: true, text: "Your defaults are saved" } : { ok: false, text: result.error });
      if (result.ok) {
        router.refresh();
      }
    } catch {
      setMessage({ ok: false, text: "that could not be done; try again" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="assistant-settings-exports" className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h3 id="assistant-settings-exports" className="text-sm font-semibold">
          Jira and Confluence
        </h3>
        <p className="text-pretty text-[13px] text-asst-muted">
          Where your documents go when you send them on. You can still pick somewhere else for one document in its panel.
        </p>
      </div>
      <Choice
        id="assistant-settings-jira-default"
        label="Jira backlog"
        hint="Any Jira project you can create tickets in."
        builtIn={
          <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
            <span className="font-plex-mono font-medium">{DEFAULT_JIRA_PROJECT}</span>
            <BuiltIn />
          </span>
        }
        current={
          jira === null ? null : (
            <span className="flex min-w-0 items-baseline gap-2 text-[13px]">
              <span className="font-plex-mono font-medium">{jira.key}</span>
              <span className="truncate text-asst-body">{jira.name}</span>
            </span>
          )
        }
        searching={searching === "jira"}
        onSearch={() => setSearching("jira")}
        onClear={() => setJira(null)}
      >
        <AtlassianSearch
          kind="jira_project"
          label="Search your Jira projects for your default backlog"
          placeholder="Type a project's name or key"
          access={exports.access}
          lookUp={exports.lookUp}
          onCancel={() => setSearching(null)}
          onPick={(result) => {
            const project = result as JiraProjectResult;
            setJira({ key: project.key, name: project.name });
            setSearching(null);
          }}
        />
      </Choice>
      <Choice
        id="assistant-settings-confluence-default"
        label="Confluence page"
        hint="New pages go under this one, and searches start in its space."
        builtIn={
          <span className="flex min-w-0 flex-col leading-tight" title={breadcrumb(DEFAULT_CONFLUENCE_PARENT).join(" › ")}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[13px] font-medium">{DEFAULT_CONFLUENCE_PARENT.title}</span>
              <BuiltIn />
            </span>
            <span className="truncate text-xs text-asst-faint">{shortCrumb(breadcrumb(DEFAULT_CONFLUENCE_PARENT).slice(0, -1))}</span>
          </span>
        }
        current={
          confluence === null ? null : (
            <span className="flex min-w-0 flex-col leading-tight" title={breadcrumb(confluence).join(" › ")}>
              <span className="truncate text-[13px] font-medium">{confluence.title}</span>
              <span className="truncate text-xs text-asst-faint">{shortCrumb(breadcrumb(confluence).slice(0, -1))}</span>
            </span>
          )
        }
        searching={searching === "confluence"}
        onSearch={() => setSearching("confluence")}
        onClear={() => setConfluence(null)}
      >
        <AtlassianSearch
          kind="confluence_page"
          label="Search Confluence for your default page"
          placeholder="Type a few words of the page's title, or paste its link"
          scope={confluence === null ? null : { key: confluence.space_key, name: confluence.space_name }}
          access={exports.access}
          lookUp={exports.lookUp}
          onCancel={() => setSearching(null)}
          onPick={(result) => {
            const page = result as ConfluencePageResult;
            setConfluence({
              id: page.id,
              title: page.title,
              space_id: page.space_id,
              space_key: page.space_key,
              space_name: page.space_name,
              ancestors: page.ancestors
            });
            setSearching(null);
          }}
        />
      </Choice>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!changed || saving}
          className="rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save defaults"}
        </button>
        <p role="status" className={`text-xs ${message?.ok === false ? "text-asst-error" : "text-asst-ok"} empty:hidden`}>
          {message?.text ?? ""}
        </p>
      </div>
    </section>
  );
}
