"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AssistantMemory } from "@/assistant/memory";
import { MEMORY_REPORT_INTERVAL_MINUTES, type MemoryPressure, type MemoryUse, memoryPressure, sizeOffers } from "@/assistant/memory-report";
import { describeSize } from "@/assistant/upload-report";
import { ActionForm, type FormAction } from "@/components/ActionForm";
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
  /** The hub's own resize action, which re-reads the viewer; the agent page posts to the same one. */
  save: FormAction;
}

const LINK = "text-xs text-asst-muted underline hover:text-asst-text";

/** Why there are no figures, in words that do not read as "your assistant is using nothing". */
const NO_REPORT: Record<Exclude<MemoryUse, { reported: true }>["reason"], string> = {
  older_client: "Your assistant is running an older version that cannot tell us how much memory it is using. It can the next time it starts.",
  not_running: "Your assistant is stopped, so there is nothing using memory and nothing to report. It reports when it next starts.",
  waiting: `Your assistant has not reported its memory yet. It checks every ${MEMORY_REPORT_INTERVAL_MINUTES} minutes.`
};

/**
 * The peak against the limit, with the live figure beside it, and when the pod last looked.
 *
 * The peak leads because it is what the warning is about: the live figure falls away between turns, so a pod that has
 * twice come within a hair of being killed reads as idle whenever nobody is mid-answer. It is never presented as
 * current — the hub cannot see a pod's memory between reports.
 */
function Use({ use }: { use: MemoryUse }) {
  if (!use.reported) {
    return <p className="text-pretty text-[13px] text-asst-warn">{NO_REPORT[use.reason]}</p>;
  }
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-line bg-asst-raised px-3.5 py-3">
      <p className="text-sm font-semibold">
        {describeSize(use.peakBytes)} of {describeSize(use.limitBytes)} at its busiest
      </p>
      <p className="text-[13px] text-asst-body">Using {describeSize(use.currentBytes)} right now. Each chat you have open takes about 1.2 GB of it.</p>
      <p className="text-xs text-asst-muted">
        {use.stopped ? "Your assistant is stopped. Last reported " : "Last reported "}
        <Timestamp iso={use.at} />.
      </p>
    </div>
  );
}

/**
 * The warning, which names what to do about it and nothing else.
 *
 * Both answers are offered when there is a bigger size and a chat to close; on the largest size there is only one,
 * and with a single chat open "close some chats" would be an instruction to stop working. Telling someone memory is
 * low and leaving them nowhere to go is the thing this section exists not to do.
 */
function Warning({ pressure }: { pressure: MemoryPressure }) {
  const bigger = pressure.nextSize;
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-asst-warn bg-asst-raised px-3.5 py-3">
      <p className="text-[13px] font-semibold text-asst-text">Your assistant is low on memory</p>
      <p className="text-pretty text-[13px] text-asst-body">
        It has reached {describeSize(pressure.peakBytes)} of its {describeSize(pressure.limitBytes)}, which leaves no room for another chat.{" "}
        {bigger === undefined
          ? "This is the largest size there is, so close a chat you have finished with before you start another."
          : `Move up to ${bigger.size} below for ${bigger.chats} chats at once and ${bigger.limit} of memory${pressure.openChats > 1 ? ", or close a chat you have finished with" : ""}.`}
      </p>
    </div>
  );
}

/**
 * Changing the size, behind a confirmation.
 *
 * Asked for rather than done on one submit, in the shape `DeleteEverything` asks: the size is in the pod template, so
 * a change replaces the pod, and every chat with a session running on it stops where it is. The question counts those
 * chats, because that is the part worth being sure about.
 *
 * It **proceeds** once the person says so, rather than refusing while a chat is working. A pod is short of memory
 * precisely when chats are running on it, so a refusal would withhold the setting exactly where it is needed; and the
 * work is theirs to interrupt. What it owes them is the cost in plain words before they commit, which is this.
 *
 * The question stays open after a successful post, because closing it would unmount the form that had just been
 * submitted. What takes it away is the section re-rendering at the new size.
 */
function Change({
  size,
  assistantId,
  save,
  rollsPod,
  openChats
}: {
  size: string;
  assistantId: string;
  save: FormAction;
  rollsPod: boolean;
  openChats: number;
}) {
  const [chosen, setChosen] = useState(size);
  const [asking, setAsking] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (asking) {
      confirm.current?.focus();
    }
  }, [asking]);

  const offers = sizeOffers();
  return (
    <ActionForm action={save} label="Change the size of your assistant" keepValues className="flex flex-col gap-2.5">
      <input type="hidden" name="id" value={assistantId} />
      {/* Named for the choice rather than "Size", which is the section's own heading and would be a second thing of
          that name for anyone reading by label. */}
      <label htmlFor={`${id}-size`} className="text-[13px] font-medium">
        Choose a size
      </label>
      <select
        id={`${id}-size`}
        name="size"
        value={chosen}
        onChange={(event) => {
          setChosen(event.target.value);
          // A different size is a different question, so an answer already on the screen stops being the one asked.
          setAsking(false);
        }}
        className="rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-none focus:border-asst-accent-line"
      >
        {offers.map((offer) => (
          <option key={offer.size} value={offer.size}>
            {offer.size} — {offer.chats} chats at once, {offer.limit} of memory
          </option>
        ))}
      </select>
      {chosen === size ? (
        <p className="text-[13px] text-asst-muted">This is the size you are on.</p>
      ) : asking ? (
        <>
          <p className="text-[13px] font-semibold">
            {rollsPod
              ? `Change to ${chosen}? Your assistant restarts, which stops ${openChats === 0 ? "whatever it is working on" : openChats === 1 ? "the one chat you have open" : `all ${openChats} chats you have open`}.`
              : `Change to ${chosen}? Your assistant starts at the new size the next time you use it.`}
          </p>
          {rollsPod ? (
            <p className="text-pretty text-[13px] text-asst-body">
              Your chats are all kept and carry on where they left off. Only what one of them was working on at the moment you change is lost.
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              ref={confirm}
              type="submit"
              className="rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover"
            >
              {rollsPod ? "Change size and restart" : "Change size"}
            </button>
            <button type="button" onClick={() => setAsking(false)} className={LINK}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="self-start rounded-[10px] border border-asst-strong px-3.5 py-2 text-[13px] font-semibold text-asst-text hover:bg-asst-active"
        >
          Change to {chosen}
        </button>
      )}
    </ActionForm>
  );
}

/**
 * The Size section of the Assistant's settings.
 *
 * It is the one place the Assistant says how much its pod has and how much of it is gone, and the one place a person
 * can do anything about either. The warning above the choice is deliberately next to the thing that answers it.
 */
export function Size({ size }: { size: AssistantSize }) {
  const { view, assistantId, save } = size;
  const pressure = memoryPressure(view.use, view.openChats, view.size);
  const current = sizeOffers().find((offer) => offer.size === view.size);
  return (
    <section aria-labelledby="assistant-settings-size" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-size" className="text-sm font-semibold">
        Size
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        How much your assistant has to work with. A bigger assistant holds more chats at once and has more memory for each of them; it costs more to run, so
        take the size you need.
        {current === undefined ? null : ` You are on ${current.size}: ${current.chats} chats at once, ${current.limit} of memory.`}
      </p>
      <Use use={view.use} />
      {pressure === undefined ? null : <Warning pressure={pressure} />}
      {view.refusal === undefined ? (
        <Change size={view.size} assistantId={assistantId} save={save} rollsPod={view.rollsPod} openChats={view.openChats} />
      ) : (
        <p className="text-[13px] text-asst-muted">The size cannot be changed just now: {view.refusal}.</p>
      )}
    </section>
  );
}
