"use client";

import { useId, useState } from "react";
import type { WelshFileView } from "@/assistant/welsh";
import { type Ambiguous, type ScanView, scanView } from "@/assistant/welsh-views";
import { WelshApply } from "@/components/assistant/WelshApply";
import {
  choiceReason,
  Downloads,
  doneResult,
  isBusy,
  type JobState,
  JobStatus,
  PRIMARY,
  plural,
  RepoSelect,
  repoName,
  Step,
  ToolMessage,
  useWelshJob
} from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

const RECHECK = "text-[13px] text-asst-accent underline hover:text-asst-accent-hover";

/**
 * "Find Welsh that's missing", from step 2: pick a repo and check it; then send the new strings to the Welsh Language
 * Unit, choose between catalogue answers where there is more than one, and put what the catalogue has into the code.
 */
export function WelshScan({
  product,
  repos,
  skipsStaffPages = false,
  client
}: Readonly<{
  product: string;
  repos: readonly string[];
  skipsStaffPages?: boolean;
  client: WelshClient;
}>) {
  const [repo, setRepo] = useState<string>(repos[0] ?? "");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const scan = useWelshJob(client);
  const done = doneResult(scan.state);
  const view = done ? scanView(done.result) : null;
  const choices = Object.entries(picked).map(([ref, row_id]) => ({ ref, row_id }));

  if (repos.length === 0) {
    return (
      <Step n={2} title="Repo">
        <p className="text-[13px] text-asst-warn">
          <span>No repos are set up for this service yet. A developer adds them to </span>
          <span className="font-plex-mono">{`apps/${product}/welsh/config.yaml`}</span>
          <span> in cft-workspace.</span>
        </p>
      </Step>
    );
  }

  const check = () => {
    setPicked({});
    void scan.run({ kind: "scan", product, args: { repo } });
  };
  const changeRepo = (next: string) => {
    setRepo(next);
    setPicked({});
    scan.reset();
  };
  const steps = numberSteps(view);
  const ready = view ? view.fromCatalogue + choices.length : 0;

  return (
    <>
      <CheckStep
        repo={repo}
        repos={repos}
        state={scan.state}
        view={view}
        result={done?.result ?? {}}
        skipsStaffPages={skipsStaffPages}
        onRepo={changeRepo}
        onCheck={check}
      />
      {steps.send !== null && view && done ? <SendStep n={steps.send} files={done.files} alsoToConfirm={view.ambiguous.length > 0} /> : null}
      {steps.choose !== null && view ? <ChooseStep n={steps.choose} ambiguous={view.ambiguous} picked={picked} onPick={setPicked} /> : null}
      {view && ready > 0 ? (
        <WelshApply
          key={choices.map((c) => c.row_id).join()}
          n={steps.apply}
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

/**
 * The numbers of the steps after the check. They come and go with what it found, so each takes the next number rather
 * than a fixed one: a step that has nothing to do is not shown at all.
 */
function numberSteps(view: ScanView | null): { send: number | null; choose: number | null; apply: number } {
  let n = 3;
  const send = view && view.toWluCount > 0 ? n++ : null;
  const choose = view && view.ambiguous.length > 0 ? n++ : null;
  return { send, choose, apply: n };
}

function CheckStep({
  repo,
  repos,
  state,
  view,
  result,
  skipsStaffPages,
  onRepo,
  onCheck
}: Readonly<{
  repo: string;
  repos: readonly string[];
  state: JobState;
  view: ScanView | null;
  result: Record<string, unknown>;
  skipsStaffPages: boolean;
  onRepo: (repo: string) => void;
  onCheck: () => void;
}>) {
  const onlyRepo = repos.length === 1 && !view ? <span className="pb-2 text-[13px] text-asst-muted">{repoName(repo)}</span> : null;
  return (
    <Step n={2} title="Check the code" done={view !== null} summary={view ? repoName(repo) : undefined}>
      <div className="flex flex-wrap items-end gap-3">
        {repos.length > 1 ? <RepoSelect repos={repos} value={repo} onChange={onRepo} /> : onlyRepo}
        <button type="button" className={view ? RECHECK : PRIMARY} disabled={isBusy(state)} onClick={onCheck}>
          {view ? "Check again" : "Find missing Welsh"}
        </button>
      </div>
      <JobStatus state={state} working="Looking through the code. This can take a few minutes…" />
      {view ? <Found view={view} result={result} skipsStaffPages={skipsStaffPages} /> : null}
    </Step>
  );
}

function Found({ view, result, skipsStaffPages }: Readonly<{ view: ScanView; result: Record<string, unknown>; skipsStaffPages: boolean }>) {
  const counts: [number, string][] = [
    [view.fromCatalogue, "already in the catalogue"],
    [view.ambiguousCount, "need you to choose"],
    [view.toWluCount, "new, for the Welsh unit"]
  ];
  return (
    <>
      <ul className="grid gap-2 text-[13px] sm:grid-cols-3">
        {counts.map(([count, label]) => (
          <li key={label} className="rounded-lg bg-asst-field px-3 py-2">
            <span className="block text-lg font-semibold">{count}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-asst-muted">
        {`Each English string is counted once; together they appear in ${plural(view.places, "place")} in the code.`}
        {skipsStaffPages ? " Admin pages only staff see are left out: they don't need Welsh." : ""}
      </p>
      <ToolMessage result={result} />
    </>
  );
}

function SendStep({ n, files, alsoToConfirm }: Readonly<{ n: number; files: readonly WelshFileView[]; alsoToConfirm: boolean }>) {
  return (
    <Step n={n} title="Send the new ones to the Welsh Language Unit">
      <p className="text-[13px]">
        {"Download this spreadsheet and send it to them."}
        {alsoToConfirm ? " It also has the ones in the next step, for them to confirm." : ""}
        {" When it comes back, choose “The Welsh unit sent translations back” on the first page."}
      </p>
      <Downloads files={files} label="Spreadsheet for the Welsh Language Unit" />
    </Step>
  );
}

function ChooseStep({
  n,
  ambiguous,
  picked,
  onPick
}: Readonly<{
  n: number;
  ambiguous: readonly Ambiguous[];
  picked: Record<string, string>;
  onPick: (update: (picked: Record<string, string>) => Record<string, string>) => void;
}>) {
  const chosen = Object.keys(picked).length;
  return (
    <Step n={n} title="Check these before they go in" summary={chosen ? `${chosen} chosen` : "optional"}>
      <p className="text-[13px] text-asst-muted">
        These cannot go in automatically. Choose a translation only if it is right for where it is used. Anything you leave is already in the Welsh unit's
        spreadsheet, for them to confirm.
      </p>
      {ambiguous.map((a) => (
        <Choice key={a.ref} item={a} picked={picked[a.ref]} onPick={onPick} />
      ))}
    </Step>
  );
}

function Choice({
  item,
  picked,
  onPick
}: Readonly<{ item: Ambiguous; picked: string | undefined; onPick: (update: (picked: Record<string, string>) => Record<string, string>) => void }>) {
  const name = `${useId()}-${item.ref}`;
  const leave = () =>
    onPick((p) => {
      const { [item.ref]: _, ...rest } = p;
      return rest;
    });
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-[13px] font-medium">{item.english}</legend>
      <p className="text-xs text-asst-muted">{choiceReason(item.english, item.options.length)}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {item.options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[13px]">
            <input type="radio" name={name} checked={picked === o.id} onChange={() => onPick((p) => ({ ...p, [item.ref]: o.id }))} />
            <span lang="cy">{o.welsh}</span>
            {o.context ? <span className="text-xs text-asst-muted">{o.context}</span> : null}
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs text-asst-muted">
          <input type="radio" name={name} checked={picked === undefined} onChange={leave} />
          <span>Send it to the Welsh unit</span>
        </label>
      </div>
      <details className="text-xs text-asst-faint">
        <summary className="cursor-pointer">Where it's used</summary>
        <p className="font-plex-mono">{item.where}</p>
      </details>
    </fieldset>
  );
}
