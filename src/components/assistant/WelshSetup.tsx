"use client";

import { useRef, useState } from "react";
import { type SetupView, setupView } from "@/assistant/welsh-views";
import {
  Confirm,
  doneResult,
  isBusy,
  JobStatus,
  Labelled,
  OutLink,
  plural,
  RepoSelect,
  repoName,
  SECONDARY,
  Step,
  ToolMessage,
  useWelshJob
} from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/** An earlier translations file as the page holds it: uploaded, so a job can read it by id. */
interface Source {
  id: string;
  name: string;
}

/** How many steps setting up has, the service's included. */
export const SETUP_STEPS = 5;

/**
 * Setting up a service that has no Welsh catalogue yet, from step 2: choose which of its repos keeps its Welsh, add
 * the translations the Welsh Language Unit has approved for it (at least one WLU spreadsheet or JSON copy), see them
 * checked, then open one draft pull request adding the `welsh/` folder with the catalogue seeded from them. Nothing is
 * translated: the catalogue holds only Welsh the team already had.
 */
export function WelshSetup({
  product,
  candidates,
  openPr,
  client
}: Readonly<{ product: string; candidates: readonly string[] | null; openPr: string | null; client: WelshClient }>) {
  const input = useRef<HTMLInputElement>(null);
  // A service with one repo has only the one place to keep its Welsh. With more, which is right is the team's call, so
  // none is chosen for them.
  const [repo, setRepo] = useState(candidates?.length === 1 ? (candidates[0] ?? "") : "");
  const [sources, setSources] = useState<Source[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const check = useWelshJob(client);
  const setup = useWelshJob(client);

  const checkedResult = doneResult(check.state);
  const checked = checkedResult ? setupView(checkedResult.result) : null;
  const madeResult = doneResult(setup.state);
  const made = madeResult ? setupView(madeResult.result) : null;
  const busy = uploading !== null || isBusy(check.state, setup.state);

  if (openPr !== null) {
    return (
      <Step n={2} title="Setup already started">
        <p className="text-[13px]">
          A pull request setting this service up for Welsh is already open: <OutLink url={openPr}>{openPr}</OutLink>. Once it is merged, the service is ready.
        </p>
      </Step>
    );
  }
  if (candidates === null) {
    return (
      <Step n={2} title="Your assistant needs an update">
        <p className="text-[13px] text-asst-warn">Your assistant needs an update to set a service up for Welsh. It gets one the next time it restarts.</p>
      </Step>
    );
  }
  if (candidates.length === 0) {
    return (
      <Step n={2} title="Choose where the Welsh is kept">
        <p className="text-[13px] text-asst-warn">This service has no repos in the CFT Workspace, so there is nowhere to keep its Welsh.</p>
      </Step>
    );
  }

  /** Anything that changes what would be set up makes the check out of date. */
  function changed(): void {
    check.reset();
    setup.reset();
  }

  async function add(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }
    changed();
    const errors: string[] = [];
    const added: Source[] = [];
    // One at a time, as the hub takes uploads, so each is said as it goes.
    for (const file of Array.from(files)) {
      setUploading(file.name);
      const uploaded = await client.upload(file);
      if ("error" in uploaded) {
        errors.push(`${file.name}: ${uploaded.error}`);
      } else {
        added.push({ id: uploaded.file_id, name: file.name });
      }
    }
    setUploading(null);
    setUploadErrors(errors);
    setSources((before) => [...before, ...added]);
    if (input.current) {
      input.current.value = "";
    }
  }

  function remove(id: string): void {
    changed();
    setSources((before) => before.filter((s) => s.id !== id));
  }

  const args = { repo, file_ids: sources.map((s) => s.id) };
  const sourcesDone = checked !== null;

  return (
    <>
      <Step n={2} title="Choose where the Welsh is kept" done={repo !== ""} summary={repo ? repoName(repo) : undefined}>
        <p className="text-[13px] text-asst-body">
          A service's Welsh is kept in a welsh folder in one of its own repos, so the team reviews every change to it. If you're not sure which repo is best,
          check with the devs.
        </p>
        {candidates.length > 1 ? (
          <RepoSelect
            repos={candidates}
            value={repo}
            onChange={(next) => {
              changed();
              setRepo(next);
            }}
            label="Which repo keeps the service's Welsh"
            placeholder="Choose a repo"
          />
        ) : null}
      </Step>
      {repo === "" ? null : (
        <Step n={3} title="Add your documents" done={sourcesDone} summary={sourcesDone ? plural(sources.length, "file") : undefined}>
          <p className="text-[13px] text-asst-body">
            Add every document of approved Welsh the team has: spreadsheets the Welsh Language Unit sent back and/or JSON files of the service's Welsh. You need
            at least one. Each spreadsheet needs a column headed English and one headed Welsh or Cymraeg.
          </p>
          <p className="text-[13px] text-asst-body">The documents you upload here are also saved to the repo, in welsh/sources, for auditing.</p>
          <Labelled label="Spreadsheets (.xlsx) or JSON files (.json)">
            {(id) => (
              <input
                id={id}
                ref={input}
                type="file"
                multiple
                accept=".xlsx,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json"
                disabled={busy}
                onChange={(event) => void add(event.target.files)}
                className="text-[13px] text-asst-text"
              />
            )}
          </Labelled>
          {sources.length > 0 ? (
            <ul aria-label="Files to set up from" className="flex flex-col gap-1 text-[13px]">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="break-all">{s.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${s.name}`}
                    className="text-xs text-asst-accent underline hover:text-asst-accent-hover"
                    disabled={busy}
                    onClick={() => remove(s.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {uploadErrors.length > 0 ? (
            <ul role="alert" className="flex flex-col gap-1 text-[13px] text-asst-error">
              {uploadErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          <output className="block text-[13px] text-asst-muted">{uploading ? `Uploading ${uploading}…` : ""}</output>
          {check.state.phase === "idle" ? (
            <div>
              <button
                type="button"
                className={SECONDARY}
                disabled={busy || sources.length === 0}
                onClick={() => void check.run({ kind: "setup_check", product, args })}
              >
                Check them
              </button>
            </div>
          ) : null}
        </Step>
      )}
      {check.state.phase !== "idle" ? (
        <Step n={4} title="Check them" done={checked !== null}>
          <JobStatus state={check.state} working={`Reading ${plural(sources.length, "file")} into a catalogue, without saving anything…`} />
          {checked && checkedResult ? <CheckSummary view={checked} result={checkedResult.result} /> : null}
        </Step>
      ) : null}
      {checked !== null && checked.unreadable.length === 0 ? (
        <Step n={5} title="Set it up" done={made !== null}>
          {made === null && setup.state.phase === "idle" ? (
            <Confirm
              ask="Set up Welsh for this service"
              explain={`This opens a draft pull request in ${repoName(repo)}, as you, adding the welsh folder with ${plural(checked.added, "translation")} in its catalogue. Nothing is used until the team merges it.`}
              confirm="Open the pull request"
              busy={busy}
              onConfirm={() => void setup.run({ kind: "setup", product, args })}
            />
          ) : null}
          <JobStatus busy={busy} state={setup.state} working="Opening the pull request…" />
          {made ? <SetUp view={made} /> : null}
        </Step>
      ) : null}
    </>
  );
}

function CheckSummary({ view, result }: Readonly<{ view: SetupView; result: Record<string, unknown> }>) {
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <p>
        {view.sources === 0
          ? "No earlier translations: the catalogue starts empty."
          : `${plural(view.read, "translation")} read from ${plural(view.sources, "file")}: ${plural(view.added, "catalogue row")}, ${view.needsReview} of them needing review.`}
        {view.copiesDropped > 0 ? ` ${plural(view.copiesDropped, "JSON entry", "JSON entries")} left out, because a spreadsheet has the same English.` : ""}
      </p>
      {view.unreadable.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1 text-asst-error">
          <p>{plural(view.unreadable.length, "file")} could not be read. Remove or fix them, then check again:</p>
          <ul className="list-disc pl-5">
            {view.unreadable.map((u) => (
              <li key={u.file}>
                {u.file}: {u.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.conflicts > 0 ? (
        <details>
          <summary className="cursor-pointer text-asst-warn">
            {plural(view.conflicts, "English phrase")} {view.conflicts === 1 ? "has" : "have"} more than one Welsh. They are added as needing review, and not
            used until someone confirms which is right.
          </summary>
          <ul className="mt-1 list-disc pl-5 text-xs text-asst-muted">
            {view.conflictExamples.map((c) => (
              <li key={`${c.english}|${c.context}`}>
                “{c.english}”{c.context ? ` (${c.context})` : ""}: {c.options.map((o) => `“${o.welsh}” in ${o.where}`).join("; ")}
              </li>
            ))}
          </ul>
          {view.conflicts > view.conflictExamples.length ? (
            <p className="text-xs text-asst-muted">The pull request's welsh/needs-review.md lists them all.</p>
          ) : null}
        </details>
      ) : null}
      <ToolMessage result={result} />
    </div>
  );
}

function SetUp({ view }: Readonly<{ view: SetupView }>) {
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <p>
        <span>Pull request: </span>
        <OutLink url={view.pr}>{view.pr}</OutLink>
      </p>
      <p className="text-asst-body">
        Once the team merges it, the service is ready: its translations can be looked up and used in Jira stories straight away. To find Welsh that is missing
        from the code, a developer lists the repos to check in welsh/config.yaml.
      </p>
    </div>
  );
}
