"use client";

import { useRef, useState } from "react";
import type { ImportView } from "@/assistant/welsh-views";
import { importView } from "@/assistant/welsh-views";
import { WelshApply } from "@/components/assistant/WelshApply";
import {
  Downloads,
  doneResult,
  isBusy,
  type JobState,
  JobStatus,
  Labelled,
  OutLink,
  PRIMARY,
  plural,
  RepoSelect,
  Step,
  ToolMessage,
  useWelshJob
} from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/**
 * "The Welsh unit sent translations back", from step 2: upload their spreadsheet, see it checked, add it to the
 * service's catalogue through a draft pull request in cft-workspace, then put the Welsh into the code.
 */
export function WelshReturn({ product, repos, client }: Readonly<{ product: string; repos: readonly string[]; client: WelshClient }>) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [repo, setRepo] = useState(repos[0] ?? "");
  const check = useWelshJob(client);
  const add = useWelshJob(client);

  const checked = doneResult(check.state);
  const view = checked ? importView(checked.result) : null;
  const added = doneResult(add.state);
  const addedView = added ? importView(added.result) : null;
  const busy = uploading || isBusy(check.state, add.state);

  async function choose(chosen: File | undefined): Promise<void> {
    if (!chosen) {
      return;
    }
    startAgain();
    setUploadError("");
    setUploading(true);
    const uploaded = await client.upload(chosen);
    setUploading(false);
    if ("error" in uploaded) {
      setUploadError(uploaded.error);
      return;
    }
    setFile({ id: uploaded.file_id, name: chosen.name });
    void check.run({ kind: "import_check", product, args: { file_id: uploaded.file_id } });
  }

  function startAgain(): void {
    setFile(null);
    check.reset();
    add.reset();
    if (input.current) {
      input.current.value = "";
    }
  }

  return (
    <>
      <UploadStep file={file} busy={busy} uploading={uploading} error={uploadError} input={input} onChoose={choose} onStartAgain={startAgain} />
      {file ? <CheckStep fileName={file.name} state={check.state} view={view} result={checked?.result ?? {}} /> : null}
      {view && usableRows(view) > 0 && file ? (
        <AddStep
          state={add.state}
          view={addedView}
          files={added?.files ?? []}
          busy={busy}
          onAdd={() => void add.run({ kind: "import", product, args: { file_id: file.id } })}
        />
      ) : null}
      {addedView && file && repos.length > 0 ? (
        <WelshApply
          key={repo}
          n={5}
          product={product}
          repo={repo || null}
          fileId={file.id}
          choices={[]}
          start="Put them into the code"
          client={client}
          before={repos.length > 1 ? <RepoSelect repos={repos} value={repo} onChange={setRepo} label="Repo to put them in" /> : null}
        />
      ) : null}
    </>
  );
}

/** Rows the catalogue can take: new ones, ones replacing an older rendering, ones it has already, and ones to review. */
function usableRows(view: ImportView): number {
  return view.added + view.superseded + view.conflicting + view.unchanged;
}

function UploadStep({
  file,
  busy,
  uploading,
  error,
  input,
  onChoose,
  onStartAgain
}: Readonly<{
  file: { id: string; name: string } | null;
  busy: boolean;
  uploading: boolean;
  error: string;
  input: React.RefObject<HTMLInputElement | null>;
  onChoose: (file: File | undefined) => Promise<void>;
  onStartAgain: () => void;
}>) {
  return (
    <Step n={2} title="Upload their spreadsheet" done={file !== null} summary={file?.name}>
      {file ? (
        <button type="button" className="self-start text-[13px] text-asst-accent underline hover:text-asst-accent-hover" disabled={busy} onClick={onStartAgain}>
          Use a different spreadsheet
        </button>
      ) : (
        <Labelled label="The .xlsx the Welsh Language Unit sent back">
          {(id) => (
            <input
              id={id}
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(event) => void onChoose(event.target.files?.[0])}
              className="text-[13px] text-asst-text"
            />
          )}
        </Labelled>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      ) : null}
      <output className="block text-[13px] text-asst-muted">{uploading ? "Uploading…" : ""}</output>
    </Step>
  );
}

function CheckStep({
  fileName,
  state,
  view,
  result
}: Readonly<{ fileName: string; state: JobState; view: ImportView | null; result: Record<string, unknown> }>) {
  const blank = view && view.blank > 0 ? `${plural(view.blank, "row")} the Welsh unit left blank. ` : "";
  const problems = view && view.problems.length > 0 ? `${plural(view.problems.length, "row")} have a problem and will be sent back to them.` : "No problems.";
  return (
    <Step n={3} title="Check it" done={view !== null} summary={view ? `${plural(usableRows(view), "row")} can be used` : undefined}>
      <JobStatus state={state} working={`Checking ${fileName}: each Ref must match its English, the Welsh must be filled in, and placeholders kept…`} />
      {view ? (
        <div className="flex flex-col gap-2 text-[13px]">
          <p>
            {blank}
            {problems}
          </p>
          {view.problems.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-asst-warn">Rows with a problem</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-asst-muted">
                {view.problems.map((p) => (
                  <li key={`${p.row}-${p.ref}`}>
                    Row {p.row}, “{p.english}”: {p.problem}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {view.conflicting > 0 ? (
            <p className="text-xs text-asst-warn">
              {plural(view.conflicting, "row")} differ from Welsh already approved for the same English. They are added as needing review, and not used until
              someone confirms which is right.
            </p>
          ) : null}
          <ToolMessage result={result} />
        </div>
      ) : null}
    </Step>
  );
}

function AddStep({
  state,
  view,
  files,
  busy,
  onAdd
}: Readonly<{ state: JobState; view: ImportView | null; files: Parameters<typeof Downloads>[0]["files"]; busy: boolean; onAdd: () => void }>) {
  return (
    <Step n={4} title="Add it to the catalogue" done={view !== null}>
      {!view && state.phase === "idle" ? (
        <div>
          <button type="button" className={PRIMARY} disabled={busy} onClick={onAdd}>
            Add to the catalogue
          </button>
          <p className="mt-1 text-xs text-asst-muted">This opens a draft pull request in cft-workspace, as you, so the change to the catalogue is reviewed.</p>
        </div>
      ) : null}
      <JobStatus state={state} working="Adding it to the catalogue…" />
      {view ? <AddedSummary view={view} files={files} /> : null}
    </Step>
  );
}

function AddedSummary({ view, files }: Readonly<{ view: ImportView; files: Parameters<typeof Downloads>[0]["files"] }>) {
  const replaced = view.superseded > 0 ? `, ${plural(view.superseded, "older translation")} replaced` : "";
  return (
    <div className="flex flex-col gap-1 text-[13px]">
      <p>
        {`${plural(view.added, "translation")} added${replaced}. `}
        {view.pr ? (
          <>
            <span>Pull request: </span>
            <OutLink url={view.pr}>{view.pr}</OutLink>
          </>
        ) : (
          "Nothing new for the catalogue, so no pull request was needed."
        )}
      </p>
      {files.length > 0 ? <p className="text-xs text-asst-muted">Send the queries back to the Welsh unit:</p> : null}
      <Downloads files={files} label="Queries for the Welsh Language Unit" />
    </div>
  );
}
