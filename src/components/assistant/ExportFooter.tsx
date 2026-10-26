"use client";

import { useId, useState } from "react";
import type { ConfluenceExportView } from "@/assistant/confluence";
import type { JiraExportView } from "@/assistant/jira";
import { type ConfluenceExportProps, ConfluenceFooter } from "@/components/assistant/ConfluenceExport";
import { type JiraExportProps, JiraFooter } from "@/components/assistant/JiraExport";

type Destination = "jira" | "confluence";

/**
 * Which destination the footer opens on: one still in progress, else the first not yet done, else Jira. A person
 * coming back to a document mid-export sees that export, and one that has gone to Jira is offered Confluence next.
 */
export function openingDestination(jira: JiraExportView | undefined, confluence: ConfluenceExportView | undefined): Destination {
  if (jira === undefined) {
    return "confluence";
  }
  if (confluence === undefined || jira.status === "pending") {
    return "jira";
  }
  if (confluence.status === "pending") {
    return "confluence";
  }
  return jira.status === "done" && confluence.status !== "done" ? "confluence" : "jira";
}

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
 * gone to is ticked, and the banners above the document link to both.
 */
export function ExportFooter({
  conversationId,
  jira,
  confluence,
  saved,
  written
}: {
  conversationId: string;
  jira?: JiraExportProps;
  confluence?: ConfluenceExportProps;
  saved: boolean;
  written: boolean;
}) {
  const name = useId();
  const [destination, setDestination] = useState<Destination>(() => openingDestination(jira?.exported, confluence?.exported));
  const both = jira !== undefined && confluence !== undefined;
  const showing = jira === undefined ? "confluence" : confluence === undefined ? "jira" : destination;

  return (
    <div className="flex shrink-0 flex-col gap-2.5 border-t border-asst-line bg-asst-panel px-4 py-3">
      {both ? (
        <fieldset className="flex items-center gap-2.5">
          <legend className="sr-only">Send this document to</legend>
          <span aria-hidden="true" className="text-xs font-medium text-asst-muted">
            Send to
          </span>
          <div className="flex rounded-[9px] border border-asst-strong p-0.5">
            {(["jira", "confluence"] as const).map((option) => (
              <label
                key={option}
                className={`cursor-pointer rounded-[7px] px-2.5 py-1 text-xs font-medium focus-within:outline focus-within:outline-1 focus-within:outline-asst-accent-line ${
                  showing === option ? "bg-asst-active text-asst-text" : "text-asst-muted hover:text-asst-text"
                }`}
              >
                <input type="radio" name={name} value={option} checked={showing === option} onChange={() => setDestination(option)} className="sr-only" />
                {option === "jira" ? "Jira backlog" : "Confluence page"}
                <Tick done={(option === "jira" ? jira.exported : confluence.exported).status === "done"} />
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {/*
       * Both rows stay mounted, so a project or page chosen in one is still chosen after a look at the other, and both
       * sit in the one grid cell, so the footer is as tall as the taller of the two whichever is showing: switching
       * destination moves nothing. The other row is hidden with `visibility` rather than `display`, which keeps its
       * size and still takes it out of the tab order and the accessibility tree.
       */}
      <div className="grid min-w-0">
        {jira === undefined ? null : (
          <div className={STACKED} style={showing === "jira" ? undefined : HIDDEN} data-destination="jira">
            <JiraFooter conversationId={conversationId} {...jira} saved={saved} written={written} />
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
