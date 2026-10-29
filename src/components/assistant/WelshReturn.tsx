"use client";

import { useRef, useState } from "react";
import { importView } from "@/assistant/welsh-views";
import { WelshApply } from "@/components/assistant/WelshApply";
import { Downloads, doneResult, FIELD, JobStatus, OutLink, PRIMARY, plural, Step, ToolMessage, useWelshJob } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/**
 * "The Welsh unit sent translations back", from step 2: upload their spreadsheet, see it checked, add it to the
 * service's catalogue through a draft pull request in cft-workspace, then put the Welsh into the code.
 */
export function WelshReturn({ product, repos, client }: { product: string; repos: readonly string[]; client: WelshClient }) {
  const input = useRef<HTMLInputElement>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [repo, setRepo] = useState(repos[0] ?? "");
  const check = useWelshJob(client);
  const add = useWelshJob(client);

  const checked = doneResult(check.state);
  const view = checked ? importView(checked.result) : null;
  const usable = view ? view.added + view.superseded + view.conflicting + view.unchanged : 0;
  const added = doneResult(add.state);
  const addedView = added ? importView(added.result) : null;
  const busy = uploading || [check, add].some((job) => job.state.phase === "pending" || job.state.phase === "waking");

  async function choose(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }
    setUploadError("");
    setFileId(null);
    check.reset();
    add.reset();
    setUploading(true);
    const uploaded = await client.upload(file);
    setUploading(false);
    if ("error" in uploaded) {
      setUploadError(uploaded.error);
      return;
    }
    setFileId(uploaded.file_id);
    setFileName(file.name);
    void check.run({ kind: "import_check", product, args: { file_id: uploaded.file_id } });
  }

  function startAgain(): void {
    setFileId(null);
    check.reset();
    add.reset();
    if (input.current) {
      input.current.value = "";
    }
  }

  return (
    <>
      <Step n={2} title="Upload their spreadsheet" done={fileId !== null} summary={fileId ? fileName : undefined}>
        {fileId ? (
          <button type="button" className="self-start text-[13px] text-asst-accent underline hover:text-asst-accent-hover" disabled={busy} onClick={startAgain}>
            Use a different spreadsheet
          </button>
        ) : (
          <label className="flex flex-col gap-1 text-[13px] text-asst-muted">
            The .xlsx the Welsh Language Unit sent back
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(event) => void choose(event.target.files?.[0])}
              className="text-[13px] text-asst-text"
            />
          </label>
        )}
        {uploadError ? (
          <p role="alert" className="text-[13px] text-asst-error">
            {uploadError}
          </p>
        ) : null}
        <p role="status" className="text-[13px] text-asst-muted">
          {uploading ? "Uploading…" : ""}
        </p>
      </Step>

      {fileId ? (
        <Step n={3} title="Check it" done={view !== null} summary={view ? `${plural(usable, "row")} can be used` : undefined}>
          <JobStatus
            state={check.state}
            working={`Checking ${fileName}: each Ref must match its English, the Welsh must be filled in, and placeholders kept…`}
          />
          {view && checked ? (
            <div className="flex flex-col gap-2 text-[13px]">
              <p>
                {view.blank > 0 ? `${plural(view.blank, "row")} the Welsh unit left blank. ` : ""}
                {view.problems.length > 0 ? `${plural(view.problems.length, "row")} have a problem and will be sent back to them.` : "No problems."}
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
                  {plural(view.conflicting, "row")} differ from Welsh already approved for the same English. They are added as needing review, and not used
                  until someone confirms which is right.
                </p>
              ) : null}
              <ToolMessage result={checked.result} />
            </div>
          ) : null}
        </Step>
      ) : null}

      {view && usable > 0 ? (
        <Step n={4} title="Add it to the catalogue" done={addedView !== null}>
          {!addedView && add.state.phase === "idle" ? (
            <div>
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={() => fileId && void add.run({ kind: "import", product, args: { file_id: fileId } })}
              >
                Add to the catalogue
              </button>
              <p className="mt-1 text-xs text-asst-muted">
                This opens a draft pull request in cft-workspace, as you, so the change to the catalogue is reviewed.
              </p>
            </div>
          ) : null}
          <JobStatus state={add.state} working="Adding it to the catalogue…" />
          {addedView && added ? (
            <div className="flex flex-col gap-1 text-[13px]">
              <p>
                {plural(addedView.added, "translation")} added
                {addedView.superseded > 0 ? `, ${plural(addedView.superseded, "older translation")} replaced` : ""}.{" "}
                {addedView.pr ? (
                  <>
                    Pull request: <OutLink url={addedView.pr}>{addedView.pr}</OutLink>
                  </>
                ) : (
                  "Nothing new for the catalogue, so no pull request was needed."
                )}
              </p>
              {added.files.length > 0 ? <p className="text-xs text-asst-muted">Send the queries back to the Welsh unit:</p> : null}
              <Downloads files={added.files} label="Queries for the Welsh Language Unit" />
            </div>
          ) : null}
        </Step>
      ) : null}

      {addedView && fileId && repos.length > 0 ? (
        <WelshApply
          key={repo}
          n={5}
          product={product}
          repo={repo || null}
          fileId={fileId}
          choices={[]}
          start="Put them into the code"
          client={client}
          before={
            repos.length > 1 ? (
              <label className="flex flex-col gap-1 text-[13px] text-asst-muted">
                Repo to put them in
                <select value={repo} onChange={(event) => setRepo(event.target.value)} className={`${FIELD} max-w-xs`}>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r.split("/").pop()}
                    </option>
                  ))}
                </select>
              </label>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
