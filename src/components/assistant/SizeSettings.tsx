"use client";

import { useId } from "react";
import type { AssistantMemory } from "@/assistant/memory";
import {
  describeChatCost,
  MEMORY_REPORT_INTERVAL_MINUTES,
  type MemoryPressure,
  type MemoryUse,
  memoryAdvice,
  memoryPressure,
  memoryWarning,
  offerMemory,
  sizeOffers,
  sizeSentence
} from "@/assistant/memory-report";
import { describeSize } from "@/assistant/upload-report";
import type { FormAction } from "@/components/ActionForm";
import { useSettingsDraft } from "@/components/assistant/useSettingsDraft";
import { Timestamp } from "@/components/time/Timestamp";

/**
 * How much the person's assistant has to work with, as the Assistant's settings show it: what its pod reports about
 * its own memory, and the size that decides both that memory and how many chats it runs at once. Every figure, rule
 * and threshold is `src/assistant/memory-report.ts`'s and `src/virtual-agents/size.ts`'s, so nothing is decided a
 * second time here.
 *
 * The two belong in one section because neither is any use alone: a warning that memory is tight with nowhere to go
 * is a dead end, and a size setting with no figures beside it is a guess.
 */
export interface AssistantSize {
  view: AssistantMemory;
  assistantId: string;
  /** `saveVirtualAgentPod`, which the dialog's Save sends the size with the plugins, so a change of both restarts once. */
  save: FormAction;
}

/** Why there are no figures, in words that do not read as "your assistant is using nothing". */
const NO_REPORT: Record<Exclude<MemoryUse, { reported: true }>["reason"], string> = {
  older_client: "Your assistant is running an older version that cannot tell us how much memory it is using. It can the next time it starts.",
  not_running: "Your assistant is stopped, so there is nothing using memory and nothing to report. It reports when it next starts.",
  waiting: `Your assistant has not reported its memory yet. It checks every ${MEMORY_REPORT_INTERVAL_MINUTES} minutes.`
};

/**
 * The peak against the limit, what the pod is holding of that now, and when it last looked.
 *
 * The peak leads because it is the fuller account of what the pod has had to hold. The figure beside it is `anon`,
 * the part that cannot be reclaimed, rather than `memory.current`: it is what the warning is computed from and what
 * a chat adds to, so it is the one the per-chat cost belongs against — `memoryPressure` has why.
 *
 * "right now" is as close to current as this gets, and it is mostly earned: every path that replaces a pod drops the
 * last one's report and its launch token together, so the figures are this pod's rather than its predecessor's. The
 * exception is a pod the kubelet restarted without the hub being told, which its report at boot bounds rather than
 * removes. The date underneath is always shown, because the hub cannot see a pod's memory between reports, and a
 * stopped pod's line says "when it stopped" instead — there is no "now" for a container that is gone.
 */
function Use({ use }: Readonly<{ use: MemoryUse }>) {
  if (!use.reported) {
    return <p className="text-pretty text-[13px] text-asst-warn">{NO_REPORT[use.reason]}</p>;
  }
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-line bg-asst-raised px-3.5 py-3">
      <p className="text-sm font-semibold">
        {describeSize(use.peakBytes)} of {describeSize(use.limitBytes)} at its busiest
      </p>
      {/* "was holding" for a stopped pod: there is no "right now" for a container that no longer exists, and the
          line above it says the assistant is stopped. The per-chat figure comes from the constant the warning is
          computed from, so the sentence cannot say one cost while the threshold uses another, and through
          `describeChatCost` rather than `describeSize` so it is not shown to a precision one measurement cannot
          support. */}
      <p className="text-[13px] text-asst-body">
        {use.stopped ? "Was holding " : "Holding "}
        {describeSize(use.anonBytes)} {use.stopped ? "when it stopped" : "right now"}, about {describeChatCost()} of it for each chat open.
      </p>
      <p className="text-xs text-asst-muted">
        {use.stopped ? "Your assistant is stopped. Last reported " : "Last reported "}
        <Timestamp iso={use.at} />.
      </p>
    </div>
  );
}

/** The warning. Which sentence it carries is `memoryAdvice`'s, so the words sit beside the rule they come from. */
function Warning({ pressure }: Readonly<{ pressure: MemoryPressure }>) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-warn bg-asst-raised px-3.5 py-3">
      <p className="text-[13px] font-semibold text-asst-text">{memoryWarning(pressure)}</p>
      <p className="text-pretty text-[13px] text-asst-body">{memoryAdvice(pressure)}</p>
    </div>
  );
}

/**
 * Choosing a size, which the dialog's Save sends.
 *
 * The size is in the pod template, so a change replaces a running pod and every chat with a session running on it
 * stops where it is. What that ends is asked once by the Save, beside anything else the same save restarts the pod
 * for; this says only whether it will restart.
 *
 * It **proceeds** once the person says so, rather than refusing while a chat is working. A pod is short of memory
 * precisely when chats are running on it, so a refusal would withhold the setting exactly where it is needed; and the
 * work is theirs to interrupt.
 */
function Change({ size, rollsPod }: Readonly<{ size: string; rollsPod: boolean }>) {
  const chosen = useSettingsDraft("size", size);
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5">
      {/* Named for the choice rather than "Size", which is the section's own heading and would be a second thing of
          that name for anyone reading by label. */}
      <label htmlFor={`${id}-size`} className="text-[13px] font-medium">
        Choose a size
      </label>
      <select
        id={`${id}-size`}
        name="size"
        value={chosen.value}
        onChange={(event) => chosen.set(event.target.value)}
        className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line"
      >
        {/* Each size as it would be after the change, so these are the constants rather than what the pod in front
            of the person enforces now; the sentence above the section says that where the two differ. */}
        {sizeOffers().map((offer) => (
          <option key={offer.size} value={offer.size}>
            {offer.size} — {offer.chats} chats at once, {offerMemory(offer)} of memory
          </option>
        ))}
      </select>
      <p className="text-[13px] text-asst-muted">
        {chosen.value === size
          ? "This is the size you are on."
          : rollsPod
            ? `Saving changes it to ${chosen.value} and restarts your assistant. Your chats are all kept and carry on where they left off.`
            : `Saving changes it to ${chosen.value}. Your assistant starts at the new size the next time you use it.`}
      </p>
      {chosen.error === null ? null : (
        <p role="alert" className="text-xs text-asst-error">
          {chosen.error}
        </p>
      )}
    </div>
  );
}

/**
 * The size part of the Assistant section of the settings.
 *
 * It is the one place the Assistant says how much its pod has and how much of it is gone, and the one place a person
 * can do anything about either. The warning above the choice is deliberately next to the thing that answers it.
 */
export function Size({ size }: Readonly<{ size: AssistantSize }>) {
  const { view } = size;
  const pressure = memoryPressure(view.use, view.openChats, view.size);
  return (
    <section aria-labelledby="assistant-settings-size" className="flex flex-col gap-2.5">
      <h4 id="assistant-settings-size" className="text-[13px] font-semibold">
        Size
      </h4>
      <p className="text-pretty text-[13px] text-asst-muted">
        How much your assistant has to work with. A bigger assistant holds more chats at once and has more memory for each of them; it costs more to run, so
        take the size you need. {sizeSentence(view.size, view.capacity)}
      </p>
      <Use use={view.use} />
      {pressure === undefined ? null : <Warning pressure={pressure} />}
      {view.refusal === undefined ? (
        <Change size={view.size} rollsPod={view.rollsPod} />
      ) : (
        <p className="text-[13px] text-asst-muted">The size cannot be changed just now: {view.refusal}.</p>
      )}
    </section>
  );
}
