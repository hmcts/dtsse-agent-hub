"use client";

import { useId, useState } from "react";
import { JIRA_KEY_RE, MAX_WELSH_STRINGS, type WelshFileView } from "@/assistant/welsh";
import { type StoryCandidates, type StoryRow, storyCandidatesView, storyPreviewView, storyWriteView } from "@/assistant/welsh-views";
import {
  Confirm,
  choiceReason,
  Downloads,
  doneResult,
  FIELD,
  isBusy,
  type JobState,
  JobStatus,
  Labelled,
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

type Table = ReturnType<typeof storyPreviewView>;
type Picks = Record<string, string>;

/**
 * "Add Welsh to a Jira story", from step 2: find the story, tick which of its English is content — the page offers
 * candidates, but only the person decides — check the Welsh table, then add it to the story.
 */
export function WelshStory({ product, client }: Readonly<{ product: string; client: WelshClient }>) {
  const [key, setKey] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Picks>({});
  const find = useWelshJob(client);
  const preview = useWelshJob(client);
  const write = useWelshJob(client);

  const found = doneResult(find.state);
  const candidates = found ? storyCandidatesView(found.result) : null;
  const previewed = doneResult(preview.state);
  const table = previewed ? storyPreviewView(previewed.result) : null;
  const written = doneResult(write.state);
  const busy = isBusy(find.state, preview.state, write.state);
  const storyKey = key.trim().toUpperCase();

  function findEnglish(): void {
    setTicked(new Set());
    setPicked({});
    preview.reset();
    write.reset();
    void find.run({ kind: "story_candidates", product, args: { key: storyKey } });
  }

  function build(): void {
    write.reset();
    const choices = Object.entries(picked).map(([ref, row_id]) => ({ ref, row_id }));
    void preview.run({ kind: "story_preview", product, args: { key: storyKey, strings: [...ticked], ...(choices.length ? { choices } : {}) } });
  }

  return (
    <>
      <StoryStep storyKey={storyKey} value={key} onChange={setKey} state={find.state} candidates={candidates} busy={busy} onFind={findEnglish} />
      {candidates ? <PickStep candidates={candidates} ticked={ticked} onTick={setTicked} built={table !== null} busy={busy} onBuild={build} /> : null}
      {candidates && (table || preview.state.phase !== "idle") ? (
        <TableStep storyKey={storyKey} state={preview.state} table={table} picked={picked} onPick={setPicked} busy={busy} onRebuild={build} />
      ) : null}
      {table?.verified ? (
        <WriteStep
          key={table.rows.map((r) => r.welsh).join("\u0000")}
          storyKey={storyKey}
          state={write.state}
          written={written ? { ...storyWriteView(written.result), files: written.files } : null}
          busy={busy}
          onWrite={() => void write.run({ kind: "story_write", product, args: { key: storyKey } })}
        />
      ) : null}
    </>
  );
}

function StoryStep({
  storyKey,
  value,
  onChange,
  state,
  candidates,
  busy,
  onFind
}: Readonly<{
  storyKey: string;
  value: string;
  onChange: (key: string) => void;
  state: JobState;
  candidates: StoryCandidates | null;
  busy: boolean;
  onFind: () => void;
}>) {
  const valid = JIRA_KEY_RE.test(storyKey);
  return (
    <Step n={2} title="The story" done={candidates !== null} summary={candidates ? storyKey : undefined}>
      <form
        method="post"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            onFind();
          }
        }}
      >
        <Labelled label="Jira story">
          {(id) => (
            <input id={id} value={value} onChange={(event) => onChange(event.target.value)} className={`${FIELD} w-40 font-plex-mono`} placeholder="PUB-1234" />
          )}
        </Labelled>
        <button type="submit" className={candidates ? SECONDARY : PRIMARY} disabled={busy || !valid}>
          Find its English
        </button>
      </form>
      <JobStatus state={state} working="Reading the story…" />
      {candidates ? (
        <p className="text-[13px]">
          <OutLink url={candidates.url}>{storyKey}</OutLink>
          <span>{` ${candidates.title}`}</span>
        </p>
      ) : null}
    </Step>
  );
}

function PickStep({
  candidates,
  ticked,
  onTick,
  built,
  busy,
  onBuild
}: Readonly<{
  candidates: StoryCandidates;
  ticked: ReadonlySet<string>;
  onTick: (update: (ticked: Set<string>) => Set<string>) => void;
  built: boolean;
  busy: boolean;
  onBuild: () => void;
}>) {
  const toggle = (english: string, on: boolean) =>
    onTick((t) => {
      const next = new Set(t);
      if (on) {
        next.add(english);
      } else {
        next.delete(english);
      }
      return next;
    });
  return (
    <Step n={3} title="Pick the content" done={built} summary={ticked.size ? `${ticked.size} picked` : undefined}>
      {candidates.candidates.length === 0 ? (
        <p className="text-[13px] text-asst-muted">
          No English content was found in quotes, in an English column of a table, or after “the following is shown”. Put the content in one of those forms in
          the story, then find it again.
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
                onChange={(event) => toggle(c.english, event.target.checked)}
              />
              <span>{c.english}</span>
            </label>
          ))}
          <div className="pt-2">
            <button type="button" className={built ? SECONDARY : PRIMARY} disabled={busy || ticked.size === 0} onClick={onBuild}>
              {built ? "Build the table again" : "Build the Welsh table"}
            </button>
          </div>
        </fieldset>
      )}
    </Step>
  );
}

function TableStep({
  storyKey,
  state,
  table,
  picked,
  onPick,
  busy,
  onRebuild
}: Readonly<{
  storyKey: string;
  state: JobState;
  table: Table | null;
  picked: Picks;
  onPick: (update: (picked: Picks) => Picks) => void;
  busy: boolean;
  onRebuild: () => void;
}>) {
  const unchosen = table?.rows.some((r) => r.state === "ambiguous") ?? false;
  return (
    <Step n={4} title="Check the Welsh table" done={table?.verified === true && !unchosen}>
      <JobStatus state={state} working="Looking the English up in the catalogue…" />
      {table ? (
        <>
          <WelshTable storyKey={storyKey} rows={table.rows} picked={picked} onPick={onPick} />
          {unchosen ? (
            <div>
              <button type="button" className={SECONDARY} disabled={busy || Object.keys(picked).length === 0} onClick={onRebuild}>
                Use my choices
              </button>
              <p className="mt-1 text-xs text-asst-muted">Or add the table as it is: anything you do not choose stays as a placeholder for the Welsh unit.</p>
            </div>
          ) : null}
          {table.verified ? null : <Untraced failures={table.failures} />}
          <WelshSourceNote />
        </>
      ) : null}
    </Step>
  );
}

function WelshTable({
  storyKey,
  rows,
  picked,
  onPick
}: Readonly<{ storyKey: string; rows: readonly StoryRow[]; picked: Picks; onPick: (update: (picked: Picks) => Picks) => void }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <caption className="sr-only">{`Welsh content for ${storyKey}`}</caption>
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
          {rows.map((row) => (
            <tr key={row.ref} className="border-b border-asst-line align-top last:border-b-0">
              <td className="py-1.5 pr-3">{row.english}</td>
              <WelshCell row={row} picked={picked[row.ref]} onPick={onPick} />
              <td className={`py-1.5 text-xs ${row.state === "hand-edited" ? "text-asst-error" : "text-asst-muted"}`}>{STATE_LABEL[row.state]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Welsh for one row, or, where the catalogue has more than one answer, the choice between them. */
function WelshCell({ row, picked, onPick }: Readonly<{ row: StoryRow; picked: string | undefined; onPick: (update: (picked: Picks) => Picks) => void }>) {
  const name = `${useId()}-${row.ref}`;
  if (row.state !== "ambiguous") {
    return (
      <td className={`py-1.5 pr-3 ${row.state === "filled" ? "" : "text-asst-muted"}`} lang={row.state === "filled" ? "cy" : undefined}>
        {row.welsh}
      </td>
    );
  }
  return (
    <td className="py-1.5 pr-3 text-asst-muted">
      <span className="flex flex-col gap-1">
        <span className="text-xs text-asst-muted">{choiceReason(row.english, row.options.length)}</span>
        {row.options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-asst-text">
            <input type="radio" name={name} checked={picked === o.id} onChange={() => onPick((p) => ({ ...p, [row.ref]: o.id }))} />
            <span lang="cy">{o.welsh}</span>
            {o.context ? <span className="text-xs text-asst-muted">{o.context}</span> : null}
          </label>
        ))}
      </span>
    </td>
  );
}

function Untraced({ failures }: Readonly<{ failures: readonly string[] }>) {
  return (
    <div role="alert" className="text-[13px] text-asst-error">
      <p>This table cannot be added: some of its Welsh did not come from the catalogue or the Welsh Language Unit.</p>
      <ul className="list-disc pl-5 text-xs">
        {failures.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <p className="text-xs">Remove the Welsh typed into the story by hand, or add it to the catalogue from a Welsh unit return first.</p>
    </div>
  );
}

function WriteStep({
  storyKey,
  state,
  written,
  busy,
  onWrite
}: Readonly<{
  storyKey: string;
  state: JobState;
  written: { url: string; required: number; files: readonly WelshFileView[] } | null;
  busy: boolean;
  onWrite: () => void;
}>) {
  return (
    <Step n={5} title="Add it to the story" done={written !== null}>
      {written ? null : (
        <Confirm
          ask="Add to the Jira story…"
          explain={`This adds the table to ${storyKey} as you, or replaces the Welsh content table already there. The rest of the story is left as it is.`}
          confirm="Add it to the story"
          busy={busy}
          onConfirm={onWrite}
        />
      )}
      <JobStatus state={state} working="Updating the story…" />
      {written ? (
        <div className="flex flex-col gap-1 text-[13px]">
          <p>
            <span>Updated </span>
            <OutLink url={written.url}>{storyKey}</OutLink>
            <span>
              {written.required > 0
                ? `. ${plural(written.required, "string")} still need the Welsh unit: send them this spreadsheet. When it comes back, choose “The Welsh unit sent translations back”, then build this table again.`
                : ". Every string has approved Welsh."}
            </span>
          </p>
          <Downloads files={written.files} label="Spreadsheet for the Welsh Language Unit" />
        </div>
      ) : null}
    </Step>
  );
}
