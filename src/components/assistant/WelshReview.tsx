"use client";

import { useEffect, useState } from "react";
import { type ReviewGroup, reviewedView, reviewListView } from "@/assistant/welsh-views";
import { Confirm, doneResult, isBusy, JobStatus, OutLink, plural, Step, useWelshJob } from "@/components/assistant/WelshParts";
import type { WelshClient } from "@/components/assistant/welshClient";

/** How many steps reviewing has, the service's included. */
export const REVIEW_STEPS = 3;

/**
 * "Review translations", from step 2: each English in the catalogue with Welsh waiting for review, and every rendering
 * of it to choose from, the one already approved too. The person picks the Welsh the Welsh Language Unit confirmed, or
 * leaves it for later, then opens one draft pull request in the service's own repo that approves what they picked and
 * supersedes the rest. The page only chooses between Welsh that is already in the catalogue.
 */
export function WelshReview({ product, client }: Readonly<{ product: string; client: WelshClient }>) {
  const list = useWelshJob(client);
  const apply = useWelshJob(client);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const { run } = list;

  useEffect(() => {
    void run({ kind: "review_list", product, args: {} });
  }, [product, run]);

  const listed = doneResult(list.state);
  const view = listed ? reviewListView(listed.result) : null;
  const appliedResult = doneResult(apply.state);
  const applied = appliedResult ? reviewedView(appliedResult.result) : null;
  const busy = isBusy(list.state, apply.state);
  const picks = Object.values(chosen);

  return (
    <>
      <Step n={2} title="Choose the right Welsh" done={applied !== null} summary={picks.length > 0 ? `${plural(picks.length, "chosen")}` : undefined}>
        <JobStatus state={list.state} working="Reading the translations waiting for review…" />
        {view && view.groups.length === 0 ? <p className="text-[13px]">Nothing in this service&apos;s catalogue is waiting for review.</p> : null}
        {view && view.groups.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-asst-body">
              For each, choose the Welsh the Welsh Language Unit has confirmed. The others are kept as history and no longer used. Leave any you have not
              settled yet as they are.
            </p>
            {view.total > view.groups.length ? (
              <p className="text-xs text-asst-muted">
                Showing the first {view.groups.length} of {view.total}. The rest are listed again once these are settled.
              </p>
            ) : null}
            {view.groups.map((group) => (
              <GroupChoice
                key={keyOf(group)}
                group={group}
                value={chosen[keyOf(group)] ?? ""}
                disabled={busy || applied !== null}
                onChange={(id) =>
                  setChosen((before) => {
                    const next = { ...before };
                    if (id === "") {
                      delete next[keyOf(group)];
                    } else {
                      next[keyOf(group)] = id;
                    }
                    return next;
                  })
                }
              />
            ))}
          </div>
        ) : null}
      </Step>
      {view && view.groups.length > 0 ? (
        <Step n={3} title="Approve them" done={applied !== null}>
          {applied === null && apply.state.phase === "idle" ? (
            picks.length === 0 ? (
              <p className="text-[13px] text-asst-muted">Choose the Welsh for at least one above.</p>
            ) : (
              <Confirm
                ask={`Approve ${plural(picks.length, "translation")}`}
                explain="This opens a draft pull request in the service's own repo, as you, approving the Welsh you chose. It is used once the team merges it."
                confirm="Open the pull request"
                busy={busy}
                onConfirm={() => void apply.run({ kind: "review_apply", product, args: { approve: picks } })}
              />
            )
          ) : null}
          <JobStatus busy={busy} state={apply.state} working="Opening the pull request…" />
          {applied ? (
            <div className="flex flex-col gap-1 text-[13px]">
              <p>
                <span>Pull request: </span>
                <OutLink url={applied.pr}>{applied.pr}</OutLink>
              </p>
              <p className="text-asst-body">
                {plural(applied.approved, "translation")} approved, {plural(applied.superseded, "other version")} kept as history.{" "}
                {applied.left > 0 ? `${plural(applied.left, "English phrase")} still to review.` : "Nothing else is waiting for review."}
              </p>
            </div>
          ) : null}
        </Step>
      ) : null}
    </>
  );
}

const keyOf = (group: ReviewGroup) => `${group.english}\u0000${group.context}`;

function GroupChoice({ group, value, disabled, onChange }: Readonly<{ group: ReviewGroup; value: string; disabled: boolean; onChange: (id: string) => void }>) {
  const name = `review-${keyOf(group)}`;
  return (
    <fieldset className="flex flex-col gap-1 rounded-[10px] border border-asst-line px-3 py-2 text-[13px]">
      <legend className="px-1 font-semibold">
        “{group.english}”{group.context ? <span className="font-normal text-asst-muted"> ({group.context})</span> : null}
      </legend>
      {group.why.length > 0 ? <p className="text-xs text-asst-muted">{group.why.join(" ")}</p> : null}
      {group.options.map((option) => (
        <label key={option.id} className="flex items-start gap-2">
          <input type="radio" name={name} value={option.id} checked={value === option.id} disabled={disabled} onChange={() => onChange(option.id)} />
          <span>
            “{option.welsh}”{" "}
            <span className="text-xs text-asst-muted">
              from {option.source || "the catalogue"}
              {option.approved ? ", approved now" : ""}
            </span>
          </span>
        </label>
      ))}
      <label className="flex items-start gap-2 text-asst-muted">
        <input type="radio" name={name} value="" checked={value === ""} disabled={disabled} onChange={() => onChange("")} />
        <span>Not settled yet</span>
      </label>
    </fieldset>
  );
}
