"use client";

import { useState } from "react";
import { applyView } from "@/assistant/welsh-views";
import { doneResult, JobStatus, OutLink, PRIMARY, plural, SECONDARY, Step, ToolMessage, useWelshJob } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

export interface WelshApplyProps {
  n: number;
  product: string;
  repo: string | null;
  /** A Welsh Language Unit return to take the Welsh from; without one it comes from the catalogue. */
  fileId?: string;
  choices: { ref: string; row_id: string }[];
  /** What the button says before anything has been previewed, e.g. "Put the 49 into the code". */
  start: string;
  /** Shown above the button, e.g. which repo to put them in when the service has more than one. */
  before?: React.ReactNode;
  client: WelshClient;
}

/**
 * The step that puts the Welsh into the code: a preview first, which changes nothing, then a draft pull request opened
 * as the person, after they have seen what it will contain and said so.
 */
export function WelshApply({ n, product, repo, fileId, choices, start, before, client }: WelshApplyProps) {
  const preview = useWelshJob(client);
  const create = useWelshJob(client);
  const [confirming, setConfirming] = useState(false);
  const args = { ...(repo ? { repo } : {}), ...(fileId ? { file_id: fileId } : {}), ...(choices.length ? { choices } : {}) };
  const previewed = doneResult(preview.state);
  const shown = previewed ? applyView(previewed.result) : null;
  const created = doneResult(create.state);
  const pr = created ? applyView(created.result) : null;
  const busy = [preview, create].some((job) => job.state.phase === "pending" || job.state.phase === "waking");

  return (
    <Step n={n} title="Put the Welsh into the code" done={pr !== null}>
      {before}
      {!shown && preview.state.phase === "idle" ? (
        <div>
          <button type="button" className={SECONDARY} disabled={busy} onClick={() => void preview.run({ kind: "apply_preview", product, args })}>
            {start}
          </button>
          <p className="mt-1 text-xs text-asst-muted">You see exactly what would change first. Nothing changes until you say so.</p>
        </div>
      ) : null}
      <JobStatus state={preview.state} working="Working out the changes. On a large repo this takes a few minutes…" />
      {shown ? (
        <div className="flex flex-col gap-2 text-[13px]">
          {shown.applied === 0 ? (
            <p>There is nothing to put in: none of the missing Welsh in this repo has an answer yet.</p>
          ) : (
            <p>
              {plural(shown.applied, "Welsh value")} would go into {plural(shown.files.length, "file")}. Each has been checked against the catalogue or the
              Welsh unit's spreadsheet.
            </p>
          )}
          {shown.pages.length > 0 ? (
            <div className="flex flex-col gap-3">
              {shown.pages.map(({ page, changes }) => (
                <div key={page} className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-[13px]">
                    <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-wide text-asst-muted first-letter:uppercase">{page}</caption>
                    <thead>
                      <tr className="border-b border-asst-line text-xs text-asst-muted">
                        <th scope="col" className="w-[34%] py-1.5 pr-3 font-medium">
                          English
                        </th>
                        <th scope="col" className="w-[18%] py-1.5 pr-3 font-medium">
                          Welsh page now
                        </th>
                        <th scope="col" className="py-1.5 pr-3 font-medium">
                          Becomes
                        </th>
                        <th scope="col" className="w-[14%] py-1.5 font-medium">
                          From
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c) => (
                        <tr key={`${c.english}-${c.welsh}`} className="border-b border-asst-line align-top last:border-b-0">
                          <td className="py-1.5 pr-3">{c.english}</td>
                          <td className="py-1.5 pr-3 text-xs text-asst-muted">{c.now}</td>
                          <td className="py-1.5 pr-3 font-medium" lang="cy">
                            {c.welsh}
                          </td>
                          <td className="py-1.5 text-xs text-asst-muted">{c.from}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : null}
          {shown.diff ? (
            <details>
              <summary className="cursor-pointer text-xs text-asst-muted">The code changes, for developers</summary>
              <pre className="mt-1 max-h-80 overflow-auto whitespace-pre rounded-lg bg-asst-field px-2.5 py-2 font-plex-mono text-xs leading-5 text-asst-text">
                {shown.diff}
              </pre>
            </details>
          ) : null}
          {shown.skipped.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-asst-warn">{plural(shown.skipped.length, "place")} need a developer, and are left out</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-asst-muted">
                {shown.skipped.map((s) => (
                  <li key={s.where}>
                    <span className="font-plex-mono">{s.where}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <ToolMessage result={previewed?.result ?? {}} />
          {shown.applied > 0 && !pr ? (
            confirming ? (
              <div className="flex flex-col gap-2 rounded-lg bg-asst-field px-3 py-2">
                <p>
                  This opens a <strong>draft</strong> pull request in {repo?.split("/").pop() ?? "the service's repo"}, as you, with these{" "}
                  {plural(shown.applied, "value")}. A developer reviews it before anything is merged.
                </p>
                <div className="flex gap-2">
                  <button type="button" className={PRIMARY} disabled={busy} onClick={() => void create.run({ kind: "apply", product, args })}>
                    Open the draft pull request
                  </button>
                  <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <button type="button" className={PRIMARY} disabled={busy} onClick={() => setConfirming(true)}>
                  Create a pull request…
                </button>
              </div>
            )
          ) : null}
        </div>
      ) : null}
      <JobStatus state={create.state} working="Opening the pull request…" />
      {pr ? (
        <p className="text-[13px]">
          {pr.pr ? (
            <>
              Draft pull request: <OutLink url={pr.pr}>{pr.pr}</OutLink>
            </>
          ) : (
            <>The changes are committed on {pr.branch ?? "a branch"}, but no pull request was opened.</>
          )}
        </p>
      ) : null}
    </Step>
  );
}
