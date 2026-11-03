"use client";

import { useId, useState } from "react";
import type { ConfluenceExportView } from "@/assistant/confluence";
import type { GithubExportView, TicketTool } from "@/assistant/github";
import type { JiraExportView } from "@/assistant/jira";
import { type ConfluenceExportProps, ConfluenceFooter } from "@/components/assistant/ConfluenceExport";
import { type GithubExportProps, GithubFooter } from "@/components/assistant/GithubExport";
import { type JiraExportProps, JiraFooter } from "@/components/assistant/JiraExport";

type Destination = TicketTool | "confluence";

type Shown = { status: string };

/**
 * Which of the destinations offered, in their order, the footer opens on: one still in progress, else the first not yet
 * done, else the first. A person coming back to a document mid-export sees that export, and one that has become a
 * ticket is offered Confluence next.
 */
function opening(offered: readonly (readonly [Destination, Shown])[]): Destination {
  const pick = offered.find(([, shown]) => shown.status === "pending") ?? offered.find(([, shown]) => shown.status !== "done") ?? offered[0];
  return pick?.[0] ?? "confluence";
}

/** `opening` for one ticket and Confluence, `tool` being the ticket's. */
export function openingDestination(
  ticket: JiraExportView | GithubExportView | undefined,
  confluence: ConfluenceExportView | undefined,
  tool: TicketTool = "jira"
): Destination {
  const offered: [Destination, Shown][] = [];
  if (ticket !== undefined) {
    offered.push([tool, ticket]);
  }
  if (confluence !== undefined) {
    offered.push(["confluence", confluence]);
  }
  return opening(offered);
}

/** Whether an export is a ticket, made or on its way, rather than none or one that failed. */
function isTicket(exported: { status: string }): boolean {
  return exported.status === "pending" || exported.status === "done";
}

/**
 * Which ticket exports the panel offers: one document has one ticket, whichever tool made it. A ticket the document
 * already has is always shown, so switching tool in the settings never hides it; the person's own tool is offered for
 * a new one only while the document has none in the other.
 */
export function ticketsOffered(tool: TicketTool, jira: { status: string }, github: { status: string }): { jira: boolean; github: boolean } {
  return {
    jira: isTicket(jira) || (tool === "jira" && !isTicket(github)),
    github: isTicket(github) || (tool === "github" && !isTicket(jira))
  };
}

const LABELS: Record<Destination, string> = { jira: "Jira backlog", github: "GitHub issue", confluence: "Confluence page" };

/** One grid cell for both rows; `min-w-0` so a long breadcrumb shrinks within the panel rather than widening it. */
const STACKED = "col-start-1 row-start-1 min-w-0";
const HIDDEN = { visibility: "hidden" } as const;

function Tick({ done }: { done: boolean }) {
  return done ? (
    <>
      <span aria-hidden="true" className="text-asst-ok">
        {" "}
        ✓
      </span>
      <span className="sr-only"> (done)</span>
    </>
  ) : null;
}

/**
 * Below the document: where it goes, then that destination's controls. One destination at a time, chosen by a pair
 * of radio buttons, rather than a row for each: a search for a Confluence page lists results under its box, and two
 * such rows would take most of a narrow panel from the document they are about. A destination the document has already
 * gone to is ticked, and the banners above the document link to both. The caller passes the person's ticket tool's
 * export, and also the other tool's when the document already has a ticket there, so that ticket is never hidden.
 */
export function ExportFooter({
  conversationId,
  jira,
  github,
  confluence,
  saved,
  written
}: {
  conversationId: string;
  jira?: JiraExportProps;
  /** For a person whose ticket tool is GitHub, or a document that already has an issue. */
  github?: GithubExportProps;
  confluence?: ConfluenceExportProps;
  saved: boolean;
  written: boolean;
}) {
  const name = useId();
  const offered: [Destination, Shown][] = [];
  if (jira !== undefined) {
    offered.push(["jira", jira.exported]);
  }
  if (github !== undefined) {
    offered.push(["github", github.exported]);
  }
  if (confluence !== undefined) {
    offered.push(["confluence", confluence.exported]);
  }
  const [destination, setDestination] = useState<Destination>(() => opening(offered));
  const showing = offered.some(([option]) => option === destination) ? destination : opening(offered);

  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-t border-asst-line bg-asst-panel px-4 py-3">
      {offered.length > 1 ? (
        <fieldset className="flex items-center gap-2.5">
          <legend className="sr-only">Send this document to</legend>
          <span aria-hidden="true" className="text-xs font-medium text-asst-muted">
            Send to
          </span>
          <div className="flex rounded-[9px] border border-asst-strong p-0.5">
            {offered.map(([option, shown]) => (
              <label
                key={option}
                className={`cursor-pointer rounded-[7px] px-2.5 py-1 text-xs font-medium focus-within:outline focus-within:outline-1 focus-within:outline-asst-accent-line ${
                  showing === option ? "bg-asst-active text-asst-text" : "text-asst-muted hover:text-asst-text"
                }`}
              >
                <input type="radio" name={name} value={option} checked={showing === option} onChange={() => setDestination(option)} className="sr-only" />
                {LABELS[option]}
                <Tick done={shown.status === "done"} />
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {/*
       * Every row stays mounted, so a project or page chosen in one is still chosen after a look at another, and all
       * sit in the one grid cell, so the footer is as tall as the tallest whichever is showing: switching
       * destination moves nothing. The others are hidden with `visibility` rather than `display`, which keeps their
       * size and still takes them out of the tab order and the accessibility tree.
       */}
      <div className="grid min-w-0">
        {jira === undefined ? null : (
          <div className={STACKED} style={showing === "jira" ? undefined : HIDDEN} data-destination="jira">
            <JiraFooter conversationId={conversationId} {...jira} saved={saved} written={written} />
          </div>
        )}
        {github === undefined ? null : (
          <div className={STACKED} style={showing === "github" ? undefined : HIDDEN} data-destination="github">
            <GithubFooter conversationId={conversationId} {...github} saved={saved} written={written} />
          </div>
        )}
        {confluence === undefined ? null : (
          <div className={STACKED} style={showing === "confluence" ? undefined : HIDDEN} data-destination="confluence">
            <ConfluenceFooter conversationId={conversationId} {...confluence} saved={saved} written={written} />
          </div>
        )}
      </div>
    </div>
  );
}
