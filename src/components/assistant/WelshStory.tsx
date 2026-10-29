"use client";

import { useId, useState } from "react";
import { JIRA_KEY_RE, MAX_WELSH_STRINGS } from "@/assistant/welsh";
import { type StoryRow, storyCandidatesView, storyPreviewView, storyWriteView } from "@/assistant/welsh-views";
import {
  choiceReason,
  Downloads,
  doneResult,
  FIELD,
  JobStatus,
  OutLink,
  PRIMARY,
  plural,
  SECONDARY,
  Step,
  useWelshJob,
  WelshSourceNote
} from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

const STATE_LABEL: Record<StoryRow["state"], string> = {
  filled: "From the catalogue",
  required: "For the Welsh unit",
  ambiguous: "Choose one",
  "hand-edited": "Typed in by hand"
};

/**
 * "Add Welsh to a Jira story", from step 2: find the story, tick which of its English is content — the page offers
 * candidates, but only the person decides — check the Welsh table, then add it to the story.
 */
export function WelshStory({ product, client }: { product: string; client: WelshClient }) {
  const id = useId();
  const [key, setKey] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const find = useWelshJob(client);
  const preview = useWelshJob(client);
  const write = useWelshJob(client);

  const found = doneResult(find.state);
  const candidates = found ? storyCandidatesView(found.result) : null;
  const previewed = doneResult(preview.state);
  const table = previewed ? storyPreviewView(previewed.result) : null;
  const written = doneResult(write.state);
  const writtenView = written ? storyWriteView(written.result) : null;
  const busy = [find, preview, write].some((job) => job.state.phase === "pending" || job.state.phase === "waking");
  const storyKey = key.trim().toUpperCase();
  const validKey = JIRA_KEY_RE.test(storyKey);
  const unchosen = table?.rows.some((r) => r.state === "ambiguous") ?? false;

  function build(): void {
    setConfirming(false);
    write.reset();
    const choices = Object.entries(picked).map(([ref, row_id]) => ({ ref, row_id }));
    void preview.run({ kind: "story_preview", product, args: { key: storyKey, strings: [...ticked], ...(choices.length ? { choices } : {}) } });
  }

  return (
    <>
      <Step n={2} title="The story" done={candidates !== null} summary={candidates ? storyKey : undefined}>
        <form
          method="post"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (validKey) {
              setTicked(new Set());
              setPicked({});
              preview.reset();
              write.reset();
              void find.run({ kind: "story_candidates", product, args: { key: storyKey } });
            }
          }}
        >
          <label className="flex flex-col gap-1 text-[13px] text-asst-muted">
            Jira story
            <input value={key} onChange={(event) => setKey(event.target.value)} className={`${FIELD} w-40 font-plex-mono`} placeholder="PUB-1234" />
          </label>
          <button type="submit" className={candidates ? SECONDARY : PRIMARY} disabled={busy || !validKey}>
            Find its English
          </button>
        </form>
        <JobStatus state={find.state} working="Reading the story…" />
        {candidates ? (
          <p className="text-[13px]">
            <OutLink url={candidates.url}>{storyKey}</OutLink> {candidates.title}
          </p>
        ) : null}
      </Step>

      {candidates ? (
        <Step n={3} title="Pick the content" done={table !== null} summary={ticked.size ? `${ticked.size} picked` : undefined}>
          {candidates.candidates.length === 0 ? (
            <p className="text-[13px] text-asst-muted">
              No English content was found in quotes, in an English column of a table, or after “the following is shown”. Put the content in one of those forms
              in the story, then find it again.
            </p>
          ) : (
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-[13px] text-asst-muted">Which of these does a user see on screen? Leave out instructions.</legend>
              {candidates.candidates.map((c) => (
                <label key={c.english} className="flex items-start gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={ticked.has(c.english)}
                    disabled={!ticked.has(c.english) && ticked.size >= MAX_WELSH_STRINGS}
                    onChange={(event) =>
                      setTicked((t) => {
                        const next = new Set(t);
                        if (event.target.checked) {
                          next.add(c.english);
                        } else {
                          next.delete(c.english);
                        }
                        return next;
                      })
                    }
                  />
                  <span>{c.english}</span>
                </label>
              ))}
              <div className="pt-2">
                <button type="button" className={table ? SECONDARY : PRIMARY} disabled={busy || ticked.size === 0} onClick={build}>
                  {table ? "Build the table again" : "Build the Welsh table"}
                </button>
              </div>
            </fieldset>
          )}
        </Step>
      ) : null}

      {candidates && (table || preview.state.phase !== "idle") ? (
        <Step n={4} title="Check the Welsh table" done={table?.verified === true && !unchosen}>
          <JobStatus state={preview.state} working="Looking the English up in the catalogue…" />
          {table ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[13px]">
                  <caption className="sr-only">Welsh content for {storyKey}</caption>
                  <thead>
                    <tr className="border-b border-asst-line text-xs text-asst-muted">
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        English
                      </th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">
                        Welsh
                      </th>
                      <th scope="col" className="py-1.5 font-medium">
                        From
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row) => (
                      <tr key={row.ref} className="border-b border-asst-line align-top last:border-b-0">
                        <td className="py-1.5 pr-3">{row.english}</td>
                        <td className={`py-1.5 pr-3 ${row.state === "filled" ? "" : "text-asst-muted"}`} lang={row.state === "filled" ? "cy" : undefined}>
                          {row.state === "ambiguous" ? (
                            <span className="flex flex-col gap-1">
                              <span className="text-xs text-asst-muted">{choiceReason(row.english, row.options.length)}</span>
                              {row.options.map((o) => (
                                <label key={o.id} className="flex items-center gap-2 text-asst-text">
                                  <input
                                    type="radio"
                                    name={`${id}-${row.ref}`}
                                    checked={picked[row.ref] === o.id}
                                    onChange={() => setPicked((p) => ({ ...p, [row.ref]: o.id }))}
                                  />
                                  <span lang="cy">{o.welsh}</span>
                                  {o.context ? <span className="text-xs text-asst-muted">{o.context}</span> : null}
                                </label>
                              ))}
                            </span>
                          ) : (
                            row.welsh
                          )}
                        </td>
                        <td className={`py-1.5 text-xs ${row.state === "hand-edited" ? "text-asst-error" : "text-asst-muted"}`}>{STATE_LABEL[row.state]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {unchosen ? (
                <div>
                  <button type="button" className={SECONDARY} disabled={busy || Object.keys(picked).length === 0} onClick={build}>
                    Use my choices
                  </button>
                  <p className="mt-1 text-xs text-asst-muted">
                    Or add the table as it is: anything you do not choose stays as a placeholder for the Welsh unit.
                  </p>
                </div>
              ) : null}
              {!table.verified ? (
                <div role="alert" className="text-[13px] text-asst-error">
                  <p>This table cannot be added: some of its Welsh did not come from the catalogue or the Welsh Language Unit.</p>
                  <ul className="list-disc pl-5 text-xs">
                    {table.failures.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  <p className="text-xs">Remove the Welsh typed into the story by hand, or add it to the catalogue from a Welsh unit return first.</p>
                </div>
              ) : null}
              <WelshSourceNote />
            </>
          ) : null}
        </Step>
      ) : null}

      {table?.verified ? (
        <Step n={5} title="Add it to the story" done={writtenView !== null}>
          {!writtenView ? (
            confirming ? (
              <div className="flex flex-col gap-2 rounded-lg bg-asst-field px-3 py-2 text-[13px]">
                <p>This adds the table to {storyKey} as you, or replaces the Welsh content table already there. The rest of the story is left as it is.</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={PRIMARY}
                    disabled={busy}
                    onClick={() => void write.run({ kind: "story_write", product, args: { key: storyKey } })}
                  >
                    Add it to the story
                  </button>
                  <button type="button" className={SECONDARY} disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <button type="button" className={PRIMARY} disabled={busy} onClick={() => setConfirming(true)}>
                  Add to the Jira story…
                </button>
              </div>
            )
          ) : null}
          <JobStatus state={write.state} working="Updating the story…" />
          {writtenView && written ? (
            <div className="flex flex-col gap-1 text-[13px]">
              <p>
                Updated <OutLink url={writtenView.url}>{storyKey}</OutLink>.{" "}
                {writtenView.required > 0
                  ? `${plural(writtenView.required, "string")} still need the Welsh unit: send them this spreadsheet. When it comes back, choose “The Welsh unit sent translations back”, then build this table again.`
                  : "Every string has approved Welsh."}
              </p>
              <Downloads files={written.files} label="Spreadsheet for the Welsh Language Unit" />
            </div>
          ) : null}
        </Step>
      ) : null}
    </>
  );
}
