"use client";

import { useEffect, useState } from "react";
import { MAX_WELSH_QUERY } from "@/assistant/welsh";
import { type CatalogueHit, searchView } from "@/assistant/welsh-views";
import { doneResult, FIELD, JobStatus, Labelled, plural, Step, useWelshJob, WelshSourceNote } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/** Long enough that a typed word is one search rather than one per letter. */
export const SEARCH_AFTER_MS = 350;

const STATUS_LABEL: Record<string, string> = { approved: "Approved", "needs-review": "Needs review", superseded: "Superseded" };

/** Step 2 of "Look up a translation": search the service's catalogue (then the shared one) as the person types. */
export function WelshSearch({ product, client }: Readonly<{ product: string; client: WelshClient }>) {
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
        <Labelled label="English or Welsh" className="min-w-[240px] flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              value={query}
              maxLength={MAX_WELSH_QUERY}
              onChange={(event) => setQuery(event.target.value)}
              className={FIELD}
              placeholder="For example, Back to top"
            />
          )}
        </Labelled>
        <Labelled label="Match">
          {(id) => (
            <select id={id} value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className={FIELD}>
              <option value="contains">Contains the words</option>
              <option value="exact">Exactly</option>
              <option value="fuzzy">Similar wording</option>
            </select>
          )}
        </Labelled>
      </div>
      <JobStatus state={state} working="Searching…" />
      {view ? <Hits query={query.trim()} total={view.total} hits={view.hits} /> : null}
      <WelshSourceNote />
    </Step>
  );
}

function Hits({ query, total, hits }: Readonly<{ query: string; total: number; hits: readonly CatalogueHit[] }>) {
  if (hits.length === 0) {
    return <p className="text-[13px] text-asst-muted">Nothing in the catalogue matches that.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <caption className="sr-only">{`Catalogue entries matching ${query}`}</caption>
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
          {hits.map((hit) => (
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
      {total > hits.length ? (
        <p className="pt-1 text-xs text-asst-muted">{`Showing ${hits.length} of ${plural(total, "match", "matches")}. Type more to narrow it down.`}</p>
      ) : null}
    </div>
  );
}
