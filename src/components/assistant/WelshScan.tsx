"use client";

import { useId, useState } from "react";
import { scanView } from "@/assistant/welsh-views";
import { WelshApply } from "@/components/assistant/WelshApply";
import { choiceReason, Downloads, doneResult, FIELD, JobStatus, PRIMARY, plural, Step, ToolMessage, useWelshJob } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/**
 * "Find Welsh that's missing", from step 2: pick a repo and check it; then send the new strings to the Welsh Language
 * Unit, choose between catalogue answers where there is more than one, and put what the catalogue has into the code.
 */
export function WelshScan({
  product,
  repos,
  skipsStaffPages = false,
  client
}: {
  product: string;
  repos: readonly string[];
  skipsStaffPages?: boolean;
  client: WelshClient;
}) {
  const id = useId();
  const [repo, setRepo] = useState<string>(repos[0] ?? "");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const scan = useWelshJob(client);
  const done = doneResult(scan.state);
  const view = done ? scanView(done.result) : null;
  const choices = Object.entries(picked).map(([ref, row_id]) => ({ ref, row_id }));
  const running = scan.state.phase === "pending" || scan.state.phase === "waking";

  if (repos.length === 0) {
    return (
      <Step n={2} title="Repo">
        <p className="text-[13px] text-asst-warn">
          No repos are set up for this service yet. A developer adds them to <span className="font-plex-mono">apps/{product}/welsh/config.yaml</span> in
          cft-workspace.
        </p>
      </Step>
    );
  }

  let n = 2;
  const ready = view ? view.fromCatalogue + choices.length : 0;
  return (
    <>
      <Step n={n++} title="Check the code" done={view !== null} summary={view ? repo.split("/").pop() : undefined}>
        <div className="flex flex-wrap items-end gap-3">
          {repos.length > 1 ? (
            <label className="flex flex-col gap-1 text-[13px] text-asst-muted">
              Repo
              <select
                value={repo}
                onChange={(event) => {
                  setRepo(event.target.value);
                  setPicked({});
                  scan.reset();
                }}
                className={FIELD}
              >
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r.split("/").pop()}
                  </option>
                ))}
              </select>
            </label>
          ) : view ? null : (
            <span className="pb-2 text-[13px] text-asst-muted">{repo.split("/").pop()}</span>
          )}
          <button
            type="button"
            className={view ? "text-[13px] text-asst-accent underline hover:text-asst-accent-hover" : PRIMARY}
            disabled={running}
            onClick={() => {
              setPicked({});
              void scan.run({ kind: "scan", product, args: { repo } });
            }}
          >
            {view ? "Check again" : "Find missing Welsh"}
          </button>
        </div>
        <JobStatus state={scan.state} working="Looking through the code. This can take a few minutes…" />
        {view && done ? (
          <>
            <ul className="grid gap-2 text-[13px] sm:grid-cols-3">
              <li className="rounded-lg bg-asst-field px-3 py-2">
                <span className="block text-lg font-semibold">{view.fromCatalogue}</span>
                already in the catalogue
              </li>
              <li className="rounded-lg bg-asst-field px-3 py-2">
                <span className="block text-lg font-semibold">{view.ambiguousCount}</span>
                need you to choose
              </li>
              <li className="rounded-lg bg-asst-field px-3 py-2">
                <span className="block text-lg font-semibold">{view.toWluCount}</span>
                new, for the Welsh unit
              </li>
            </ul>
            <p className="text-xs text-asst-muted">
              Each English string is counted once; together they appear in {plural(view.places, "place")} in the code.
              {skipsStaffPages ? " Admin pages only staff see are left out: they don't need Welsh." : ""}
            </p>
            <ToolMessage result={done.result} />
          </>
        ) : null}
      </Step>

      {view && done && view.toWluCount > 0 ? (
        <Step n={n++} title="Send the new ones to the Welsh Language Unit">
          <p className="text-[13px]">
            Download this spreadsheet and send it to them.{view.ambiguous.length > 0 ? " It also has the ones in the next step, for them to confirm." : ""} When
            it comes back, choose “The Welsh unit sent translations back” on the first page.
          </p>
          <Downloads files={done.files} label="Spreadsheet for the Welsh Language Unit" />
        </Step>
      ) : null}

      {view && view.ambiguous.length > 0 ? (
        <Step n={n++} title="Check these before they go in" summary={choices.length ? `${choices.length} chosen` : "optional"}>
          <p className="text-[13px] text-asst-muted">
            These cannot go in automatically. Choose a translation only if it is right for where it is used. Anything you leave is already in the Welsh unit's
            spreadsheet, for them to confirm.
          </p>
          {view.ambiguous.map((a) => (
            <fieldset key={a.ref} className="flex flex-col gap-1">
              <legend className="text-[13px] font-medium">{a.english}</legend>
              <p className="text-xs text-asst-muted">{choiceReason(a.english, a.options.length)}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {a.options.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-[13px]">
                    <input type="radio" name={`${id}-${a.ref}`} checked={picked[a.ref] === o.id} onChange={() => setPicked((p) => ({ ...p, [a.ref]: o.id }))} />
                    <span lang="cy">{o.welsh}</span>
                    {o.context ? <span className="text-xs text-asst-muted">{o.context}</span> : null}
                  </label>
                ))}
                <label className="flex items-center gap-2 text-xs text-asst-muted">
                  <input
                    type="radio"
                    name={`${id}-${a.ref}`}
                    checked={picked[a.ref] === undefined}
                    onChange={() =>
                      setPicked((p) => {
                        const { [a.ref]: _, ...rest } = p;
                        return rest;
                      })
                    }
                  />
                  Send it to the Welsh unit
                </label>
              </div>
              <details className="text-xs text-asst-faint">
                <summary className="cursor-pointer">Where it's used</summary>
                <p className="font-plex-mono">{a.where}</p>
              </details>
            </fieldset>
          ))}
        </Step>
      ) : null}

      {view && ready > 0 ? (
        <WelshApply
          key={choices.map((c) => c.row_id).join()}
          n={n++}
          product={product}
          repo={repo || null}
          choices={choices}
          start={`Put the ${ready} into the code`}
          client={client}
        />
      ) : null}
    </>
  );
}
