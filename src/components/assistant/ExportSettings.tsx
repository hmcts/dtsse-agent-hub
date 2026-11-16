"use client";

import { useState } from "react";
import { DEFAULT_CONFLUENCE_PARENT } from "@/assistant/confluence";
import type { ExportDefaults } from "@/assistant/export-defaults";
import { type GithubProjectChoice, repoOwner, sameOwner, TICKET_TOOLS, type TicketTool } from "@/assistant/github";
import { DEFAULT_JIRA_PROJECT } from "@/assistant/jira";
import { breadcrumb, type ConfluencePageResult, type GithubProjectResult, type GithubRepoResult, type JiraProjectResult } from "@/assistant/lookups";
import { AtlassianSearch } from "@/components/assistant/AtlassianSearch";
import type { JiraAccess } from "@/components/assistant/JiraExport";
import type { LookUp } from "@/components/assistant/lookupClient";
import { useSettingsDraft } from "@/components/assistant/useSettingsDraft";
import type { ActionResult } from "@/web/action";

type SaveExportDefaultsAction = (input: {
  ticketTool: unknown;
  jira: unknown;
  github: unknown;
  githubProject: unknown;
  confluence: unknown;
}) => Promise<ActionResult<{ defaults: ExportDefaults }>>;

/** The export defaults as the settings edit them: what is stored, the action the dialog's Save replaces it with, and the sign-in searches need. */
export interface AssistantExportDefaults {
  defaults: ExportDefaults;
  save: SaveExportDefaultsAction;
  access: JiraAccess;
  lookUp?: LookUp;
}

/** "(default)" after what documents go to when the person has not chosen, so they can tell it from one of their own. */
function BuiltIn() {
  return <span className="shrink-0 font-plex-mono text-[11px] text-asst-faint">(default)</span>;
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

const TOOL_LABELS: Record<TicketTool, string> = { jira: "Jira", github: "GitHub" };

/**
 * Which tool the person's tickets go to. Choosing one changes what the document panel offers beside Confluence: a
 * Jira backlog to export to, or a GitHub repository to open an issue in.
 */
function TicketToolChoice({ tool, onChange }: { tool: TicketTool; onChange: (tool: TicketTool) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-[13px] font-medium">Ticket tool</legend>
      <p className="text-pretty text-xs text-asst-muted">Where tickets for your documents are created.</p>
      <div className="flex w-fit rounded-[9px] border border-asst-strong p-0.5">
        {TICKET_TOOLS.map((option) => (
          <label
            key={option}
            className={`cursor-pointer rounded-[7px] px-3 py-1 text-xs font-medium focus-within:outline focus-within:outline-1 focus-within:outline-asst-accent-line ${
              tool === option ? "bg-asst-active text-asst-text" : "text-asst-muted hover:text-asst-text"
            }`}
          >
            <input
              type="radio"
              name="assistant-settings-ticket-tool"
              value={option}
              checked={tool === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {TOOL_LABELS[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** What a GitHub choice reads while the person has none: there is no built-in repository or Project. */
function NoneChosen({ text }: { text: string }) {
  return <span className="text-[13px] text-asst-faint">{text}</span>;
}

const SIGNED_IN: JiraAccess = { connected: true, login: null };

/**
 * The GitHub defaults: the repository issues go in, and a Project of its owner's to put them on. A repository is where
 * an issue lives and a Project is a board showing issues from any number of repositories, so the Project is a second,
 * optional choice, offered once there is a repository and searched for in that repository's owner.
 */
function GithubChoices({
  repo,
  project,
  onRepo,
  onProject,
  searching,
  onSearch,
  lookUp
}: {
  repo: string | null;
  project: GithubProjectChoice | null;
  onRepo: (repo: string | null) => void;
  onProject: (project: GithubProjectChoice | null) => void;
  searching: "github" | "github_project" | null;
  onSearch: (what: "github" | "github_project" | null) => void;
  lookUp?: LookUp;
}) {
  return (
    <>
      <Choice
        id="assistant-settings-github-default"
        label="GitHub repository"
        hint="Issues are created here, as you. Search your own repositories and organisations', or type owner/name."
        builtIn={<NoneChosen text="None chosen yet" />}
        current={repo === null ? null : <span className="block truncate font-plex-mono text-[13px] font-medium">{repo}</span>}
        searching={searching === "github"}
        onSearch={() => onSearch("github")}
        onClear={() => onRepo(null)}
      >
        <AtlassianSearch
          kind="github_repo"
          label="Search your GitHub repositories for your default"
          placeholder="Type a repository's name, or owner/name"
          access={SIGNED_IN}
          lookUp={lookUp}
          onCancel={() => onSearch(null)}
          onPick={(result) => {
            onRepo((result as GithubRepoResult).full_name);
            onSearch(null);
          }}
        />
      </Choice>
      {repo === null ? null : (
        <Choice
          id="assistant-settings-github-project-default"
          label="GitHub Project"
          hint={`Optional. A board of ${repoOwner(repo)}'s that your issues are added to as well.`}
          builtIn={<NoneChosen text="None" />}
          current={project === null ? null : <span className="block truncate text-[13px] font-medium">{project.title}</span>}
          searching={searching === "github_project"}
          onSearch={() => onSearch("github_project")}
          onClear={() => onProject(null)}
        >
          <AtlassianSearch
            kind="github_project"
            label={`Search ${repoOwner(repo)}'s GitHub Projects for your default`}
            placeholder="Type a few words of its title, or paste its link"
            owner={repoOwner(repo)}
            access={SIGNED_IN}
            lookUp={lookUp}
            onCancel={() => onSearch(null)}
            onPick={(result) => {
              const picked = result as GithubProjectResult;
              onProject({ owner: picked.owner, number: picked.number, title: picked.title });
              onSearch(null);
            }}
          />
        </Choice>
      )}
    </>
  );
}

function projectKey(project: GithubProjectChoice | null): string | null {
  return project === null ? null : `${project.owner}/${project.number}`;
}

/** Whether two sets of defaults choose the same things, by the keys the store saves them under. */
function sameDefaults(a: ExportDefaults, b: ExportDefaults): boolean {
  return (
    a.ticketTool === b.ticketTool &&
    a.jira?.key === b.jira?.key &&
    a.github === b.github &&
    projectKey(a.githubProject) === projectKey(b.githubProject) &&
    a.confluence?.id === b.confluence?.id
  );
}

/**
 * Where the person's documents go by default: the tool their tickets go to, and in it a Jira backlog or a GitHub
 * repository; and a Confluence page to put new pages under. The document panel starts from these and can be changed
 * there for one document; a Confluence search in the panel starts in this page's space. Each is found by searching the
 * person's own Jira, Confluence or GitHub, as them, and the dialog's Save stores them.
 */
export function ExportSettings({ exports }: { exports: AssistantExportDefaults }) {
  const draft = useSettingsDraft("exports", exports.defaults, sameDefaults);
  const { ticketTool: tool, jira, github, githubProject, confluence } = draft.value;
  const change = (next: Partial<ExportDefaults>) => draft.set({ ...draft.value, ...next });
  const [searching, setSearching] = useState<"jira" | "confluence" | "github" | "github_project" | null>(null);

  return (
    <section aria-labelledby="assistant-settings-exports" className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h3 id="assistant-settings-exports" className="text-sm font-semibold">
          Tickets and Confluence
        </h3>
        <p className="text-pretty text-[13px] text-asst-muted">
          Where your documents go when you send them on. You can still pick somewhere else for one document in its panel.
        </p>
      </div>
      <TicketToolChoice tool={tool} onChange={(ticketTool) => change({ ticketTool })} />
      {tool === "github" ? (
        <GithubChoices
          repo={github}
          project={githubProject}
          onRepo={(repo) =>
            change({
              github: repo,
              // A Project of another owner's does not go with this repository.
              githubProject: repo !== null && githubProject !== null && sameOwner(githubProject.owner, repoOwner(repo)) ? githubProject : null
            })
          }
          onProject={(project) => change({ githubProject: project })}
          searching={searching === "github" || searching === "github_project" ? searching : null}
          onSearch={setSearching}
          lookUp={exports.lookUp}
        />
      ) : (
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
          onClear={() => change({ jira: null })}
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
              change({ jira: { key: project.key, name: project.name } });
              setSearching(null);
            }}
          />
        </Choice>
      )}
      <Choice
        id="assistant-settings-confluence-default"
        label="Confluence page"
        hint="New pages go under this one, and searches start in its space."
        // Just the page's title, the default's and a chosen one's alike; where it sits is in the tooltip.
        builtIn={
          <span className="flex min-w-0 items-baseline gap-2 text-[13px]" title={breadcrumb(DEFAULT_CONFLUENCE_PARENT).join(" › ")}>
            <span className="truncate font-medium">{DEFAULT_CONFLUENCE_PARENT.title}</span>
            <BuiltIn />
          </span>
        }
        current={
          confluence === null ? null : (
            <span className="block truncate text-[13px] font-medium" title={breadcrumb(confluence).join(" › ")}>
              {confluence.title}
            </span>
          )
        }
        searching={searching === "confluence"}
        onSearch={() => setSearching("confluence")}
        onClear={() => change({ confluence: null })}
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
            change({
              confluence: {
                id: page.id,
                title: page.title,
                space_id: page.space_id,
                space_key: page.space_key,
                space_name: page.space_name,
                ancestors: page.ancestors
              }
            });
            setSearching(null);
          }}
        />
      </Choice>
      {draft.error === null ? null : (
        <p role="alert" className="text-xs text-asst-error">
          {draft.error}
        </p>
      )}
    </section>
  );
}
