"use client";

import { useId, useState } from "react";
import { MAX_WELSH_STRINGS } from "@/assistant/welsh";
import { type Ambiguous, byPage, keepView, type ScanView, scanView } from "@/assistant/welsh-views";
import { WelshApply } from "@/components/assistant/WelshApply";
import {
  Confirm,
  choiceReason,
  Downloads,
  doneResult,
  isBusy,
  type JobState,
  JobStatus,
  OutLink,
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
  // The new strings whose tick is not the suggested one: the suggestion is ticked unless the scan said why not.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const scan = useWelshJob(client);
  const request = useWelshJob(client);
  const keep = useWelshJob(client);
  const done = doneResult(scan.state);
  const view = done ? scanView(done.result) : null;
  const choices = Object.entries(picked).map(([ref, row_id]) => ({ ref, row_id }));

  if (repos.length === 0) {
    return (
      <Step n={2} title="Repo">
        <p className="text-[13px] text-asst-warn">
          <span>No repos are set up for this service yet. A developer adds them to </span>
          <span className="font-plex-mono">welsh/config.yaml</span>
          <span> in the service's own repo.</span>
        </p>
      </Step>
    );
  }

  // A spreadsheet, or a pull request keeping English, is of the ticks it was made from: changing them drops both.
  const retick = (next: ReadonlySet<string>) => {
    setToggled(next);
    request.reset();
    keep.reset();
  };
  const check = () => {
    setPicked({});
    retick(new Set());
    void scan.run({ kind: "scan", product, args: { repo } });
  };
  const changeRepo = (next: string) => {
    setRepo(next);
    setPicked({});
    retick(new Set());
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
      {steps.send !== null && view ? (
        <SendStep
          n={steps.send}
          view={view}
          toggled={toggled}
          onRetick={retick}
          request={request.state}
          onMake={(leaveOut) => void request.run({ kind: "request", product, args: { repo, leave_out: leaveOut } })}
          keep={keep.state}
          onKeep={(strings) => void keep.run({ kind: "keep_english", product, args: { strings } })}
        />
      ) : null}
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
      {view.filled.length > 0 ? <CatalogueList strings={view.filled} total={view.fromCatalogue} /> : null}
      <ToolMessage result={result} />
    </>
  );
}

/**
 * The strings the catalogue already has Welsh for, page by page, so a BA can see what would go into the code before it
 * does. A scan lists only so many; the preview in the last step shows every change.
 */
function CatalogueList({ strings, total }: Readonly<{ strings: ScanView["filled"]; total: number }>) {
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer font-medium">{`The ${plural(total, "string")} already in the catalogue`}</summary>
      {strings.length < total ? (
        <p className="mt-1 text-xs text-asst-muted">{`Showing the first ${strings.length.toLocaleString("en-GB")}. The preview in the last step shows every change.`}</p>
      ) : null}
      <div className="mt-2 max-h-[28rem] space-y-3 overflow-auto">
        {byPage(strings).map(({ page, items }) => (
          <div key={page} className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              {page ? <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-wide text-asst-muted">{page}</caption> : null}
              <thead>
                <tr className="border-b border-asst-line text-xs text-asst-muted">
                  <th scope="col" className="w-[40%] py-1.5 pr-3 font-medium">
                    English
                  </th>
                  <th scope="col" className="w-[30%] py-1.5 pr-3 font-medium">
                    Welsh
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Where it's used
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.ref} className="border-b border-asst-line align-top last:border-b-0">
                    <td className="py-1.5 pr-3">{s.english}</td>
                    <td className="py-1.5 pr-3 font-medium" lang="cy">
                      {s.welsh}
                    </td>
                    <td className="break-all py-1.5 font-plex-mono text-xs text-asst-muted">{s.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </details>
  );
}

type NewString = ScanView["toWlu"][number];

/** Whether a new string goes in the spreadsheet: as suggested (ticked unless the scan said why not), or as toggled. */
const isTicked = (s: NewString, toggled: ReadonlySet<string>) => (s.hint === null) !== toggled.has(s.ref);

/**
 * The new strings, to tick what goes to the Welsh Language Unit, then the spreadsheet of just those. What is left out
 * and is English already on the Welsh side can be kept that way for good, by a draft pull request to the service's
 * `identical_allowlist`, so the next check does not ask again.
 */
function SendStep({
  n,
  view,
  toggled,
  onRetick,
  request,
  onMake,
  keep,
  onKeep
}: Readonly<{
  n: number;
  view: ScanView;
  toggled: ReadonlySet<string>;
  onRetick: (toggled: ReadonlySet<string>) => void;
  request: JobState;
  onMake: (leaveOut: string[]) => void;
  keep: JobState;
  onKeep: (strings: string[]) => void;
}>) {
  const leftOut = view.toWlu.filter((s) => !isTicked(s, toggled));
  const sending = view.toWluCount - leftOut.length + view.ambiguousCount;
  // Only English that is one line can be kept, and only so many at once: the rest stays a one-off.
  const keepable = leftOut
    .filter((s) => s.keepable && !/[\r\n]/.test(s.english))
    .map((s) => s.english)
    .slice(0, MAX_WELSH_STRINGS);
  const made = doneResult(request);
  const kept = doneResult(keep);
  const suggested = view.toWlu.filter((s) => s.hint !== null).length;
  const flip = (ref: string) => {
    const next = new Set(toggled);
    if (!next.delete(ref)) {
      next.add(ref);
    }
    onRetick(next);
  };
  const busy = isBusy(request, keep);

  return (
    <Step n={n} title="Choose what goes to the Welsh Language Unit" done={made !== null} summary={`${plural(sending, "string")} to send`}>
      <p className="text-[13px]">
        {suggested > 0
          ? `Everything is ticked except ${suggested === 1 ? "1 string that probably needs no Welsh, which says" : `${plural(suggested, "string")} that probably need no Welsh, which say`} why. Untick anything else that should stay in English, such as an address or a name.`
          : "Untick anything that should stay in English, such as an address or a name."}
        {view.ambiguous.length > 0 ? " The ones in the next step go in too, for the Welsh unit to confirm." : ""}
      </p>
      {view.toWlu.length < view.toWluCount ? (
        <p className="text-xs text-asst-muted">{`Only the first ${view.toWlu.length.toLocaleString("en-GB")} are listed. The other ${(view.toWluCount - view.toWlu.length).toLocaleString("en-GB")} always go in.`}</p>
      ) : null}
      <div className="flex gap-4">
        <button
          type="button"
          className={RECHECK}
          disabled={busy}
          onClick={() => onRetick(new Set(view.toWlu.filter((s) => s.hint !== null).map((s) => s.ref)))}
        >
          Tick all
        </button>
        {toggled.size > 0 ? (
          <button type="button" className={RECHECK} disabled={busy} onClick={() => onRetick(new Set())}>
            Back to the suggestions
          </button>
        ) : null}
      </div>
      <div className="max-h-[32rem] space-y-3 overflow-auto">
        {byPage(view.toWlu).map(({ page, items }) => (
          <ChecklistTable key={page} page={page} items={items} toggled={toggled} disabled={busy} onFlip={flip} />
        ))}
      </div>
      {made ? null : (
        <div>
          <button type="button" className={PRIMARY} disabled={busy || sending === 0} onClick={() => onMake(leftOut.map((s) => s.ref))}>
            {`Make the spreadsheet of ${plural(sending, "string")}`}
          </button>
        </div>
      )}
      <JobStatus state={request} working="Making the spreadsheet…" />
      {made ? (
        <>
          <p className="text-[13px]">
            {"Download this spreadsheet and send it to the Welsh Language Unit."}
            {" When it comes back, choose “The Welsh unit sent translations back” on the first page."}
          </p>
          <Downloads files={made.files} label="Spreadsheet for the Welsh Language Unit" />
        </>
      ) : null}
      {made && keepable.length > 0 && !kept ? (
        <Confirm
          ask={`Don't ask about the ${plural(keepable.length, "string")} I left out again…`}
          explain={
            <>
              <span>This opens a </span>
              <strong>draft</strong>
              {` pull request in the service's repo, as you, adding ${plural(keepable.length, "string")} to the list of English that stays the same in Welsh (identical_allowlist in welsh/config.yaml). Later checks will not ask about them. A developer reviews it before anything is merged.`}
            </>
          }
          confirm="Open the draft pull request"
          busy={busy}
          onConfirm={() => onKeep(keepable)}
        />
      ) : null}
      <JobStatus state={keep} working="Opening the pull request…" />
      {kept ? <KeptLink pr={keepView(kept.result).pr} /> : null}
    </Step>
  );
}

/** One page's new strings, each with its tick, and why the scan thinks it needs no Welsh when it does. */
function ChecklistTable({
  page,
  items,
  toggled,
  disabled,
  onFlip
}: Readonly<{ page: string; items: readonly NewString[]; toggled: ReadonlySet<string>; disabled: boolean; onFlip: (ref: string) => void }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        {page ? <caption className="pb-1 text-left text-xs font-semibold uppercase tracking-wide text-asst-muted">{page}</caption> : null}
        <thead>
          <tr className="border-b border-asst-line text-xs text-asst-muted">
            <th scope="col" className="w-8 py-1.5 pr-2 font-medium">
              <span className="sr-only">Send</span>
            </th>
            <th scope="col" className="w-[45%] py-1.5 pr-3 font-medium">
              English
            </th>
            <th scope="col" className="py-1.5 font-medium">
              Where it's used
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.ref} className="border-b border-asst-line align-top last:border-b-0">
              <td className="py-1.5 pr-2">
                <input type="checkbox" aria-label={`Send “${s.english}”`} checked={isTicked(s, toggled)} disabled={disabled} onChange={() => onFlip(s.ref)} />
              </td>
              <td className="py-1.5 pr-3">
                <span className="block">{s.english}</span>
                {s.hint ? <span className="block text-xs text-asst-muted">{s.hint}</span> : null}
              </td>
              <td className="break-all py-1.5 font-plex-mono text-xs text-asst-muted">{s.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeptLink({ pr }: Readonly<{ pr: string | null }>) {
  if (!pr) {
    return <p className="text-[13px]">They were already on the list, so nothing changed.</p>;
  }
  return (
    <p className="text-[13px]">
      <span>Draft pull request: </span>
      <OutLink url={pr}>{pr}</OutLink>
    </p>
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
