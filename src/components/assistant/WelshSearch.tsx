"use client";

import { useEffect, useState } from "react";
import { MAX_WELSH_QUERY } from "@/assistant/welsh";
import { searchView } from "@/assistant/welsh-views";
import { doneResult, FIELD, JobStatus, plural, Step, useWelshJob, WelshSourceNote } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/** Long enough that a typed word is one search rather than one per letter. */
export const SEARCH_AFTER_MS = 350;

const STATUS_LABEL: Record<string, string> = { approved: "Approved", "needs-review": "Needs review", superseded: "Superseded" };

/** Step 2 of "Look up a translation": search the service's catalogue (then the shared one) as the person types. */
export function WelshSearch({ product, client }: { product: string; client: WelshClient }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"contains" | "exact" | "fuzzy">("contains");
  const { state, run, reset } = useWelshJob(client);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      reset();
      return;
    }
    const timer = setTimeout(() => void run({ kind: "search", product, args: { query: trimmed, mode } }), SEARCH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [query, mode, product, run, reset]);

  const done = doneResult(state);
  const view = done ? searchView(done.result) : null;

  return (
    <Step n={2} title="Search">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[13px] text-asst-muted">
          English or Welsh
          <input
            type="search"
            value={query}
            maxLength={MAX_WELSH_QUERY}
            onChange={(event) => setQuery(event.target.value)}
            className={FIELD}
            placeholder="For example, Back to top"
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px] text-asst-muted">
          Match
          <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className={FIELD}>
            <option value="contains">Contains the words</option>
            <option value="exact">Exactly</option>
            <option value="fuzzy">Similar wording</option>
          </select>
        </label>
      </div>
      <JobStatus state={state} working="Searching…" />
      {view ? (
        view.hits.length === 0 ? (
          <p className="text-[13px] text-asst-muted">Nothing in the catalogue matches that.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <caption className="sr-only">Catalogue entries matching {query.trim()}</caption>
              <thead>
                <tr className="border-b border-asst-line text-xs text-asst-muted">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    English
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    Welsh
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.hits.map((hit) => (
                  <tr key={`${hit.catalogue}-${hit.id}`} className="border-b border-asst-line align-top last:border-b-0">
                    <td className="py-1.5 pr-3">
                      {hit.english}
                      {hit.context ? <span className="block text-xs text-asst-faint">{hit.context}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3" lang="cy">
                      {hit.welsh}
                    </td>
                    <td className={`py-1.5 text-xs ${hit.status === "approved" ? "text-asst-ok" : "text-asst-warn"}`}>
                      {STATUS_LABEL[hit.status] ?? hit.status}
                      {hit.catalogue === "shared" ? <span className="block text-asst-faint">Shared catalogue</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.total > view.hits.length ? (
              <p className="pt-1 text-xs text-asst-muted">
                Showing {view.hits.length} of {plural(view.total, "match", "matches")}. Type more to narrow it down.
              </p>
            ) : null}
          </div>
        )
      ) : null}
      <WelshSourceNote />
    </Step>
  );
}
