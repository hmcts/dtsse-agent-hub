"use client";

import type { CcdRow } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { byCode } from "@hmcts-cft/bulk-scan-spec/compare";
import type { CcdConfig } from "@hmcts-cft/bulk-scan-spec/schema";
import { useEffect, useId, useRef, useState } from "react";
import { type PodJobWords, runPodJob } from "@/components/assistant/podJobRun";
import { FIELD } from "@/components/assistant/WelshParts";
import { useHubSubscribe } from "@/components/live/HubStream";

export interface ListedCaseType {
  product: string;
  service: string;
  case_type: string;
  config: CcdConfig | null;
  repo?: string;
}

/** A case type the person picked, with the fields their pod found for it. `omitted` is how many fields were left out to fit the answer. */
export interface PickedCaseType {
  product: string;
  service: string;
  caseType: string;
  config: ListedCaseType["config"];
  repo?: string;
  rows: CcdRow[];
  omitted: number;
}

const WORDS: PodJobWords = {
  unsupported: "Your assistant needs an update to do this. It gets one the next time it restarts. You can carry on without a case type.",
  noPod: "This chat runs on your own computer, so the CFT Workspace cannot read your workspace for it. You can carry on without a case type.",
  assistantGone: "Your assistant has been replaced. You can carry on without a case type."
};
/** What the picker's list has come to: not asked for yet or being read, read, or not readable (no assistant to ask, or the ask failed). */
export interface ListedCaseTypes {
  state: "none" | "idle" | "loading" | "ready" | "failed";
  types: ListedCaseType[];
}

export const WAKING_WORDS = "Your assistant is starting. This takes a minute or two, then this carries on by itself.";
export const NO_CHAT = "Start a chat in the CFT Workspace first, so your assistant is running, and this list is read from your workspace.";

type ListState =
  | { state: "none" }
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; types: ListedCaseType[] }
  | { state: "failed"; message: string; retry: boolean };

/** Failures that repeat: an assistant that needs an update or has no pod, and a workspace or case type the same request finds wrong again. */
const FINAL_CODES: readonly string[] = ["script_missing", "tool_missing", "not_cloned", "unknown_case_type", "ambiguous_case_type"];
const retryable = (outcome: { status?: string; code?: string }): boolean =>
  outcome.status !== "unsupported" && outcome.status !== "no_pod" && outcome.status !== "assistant_gone" && !FINAL_CODES.includes(outcome.code ?? "");

const NONE: ListedCaseType[] = [];
const keyOf = (type: Pick<ListedCaseType, "product" | "case_type">): string => `${type.product}/${type.case_type}`;

/**
 * The service and CCD case type a form maps into, chosen from the case types the person's own workspace declares and read by
 * their pod: choosing one fetches its fields. Needs a chat on the person's assistant to run the jobs in (`conversationId`).
 * The choice is optional, and leaving it empty clears it.
 */
export function BulkScanCaseTypePicker({
  conversationId,
  selected,
  onPicked,
  onCleared,
  onFetching,
  onList,
  disabled = false
}: Readonly<{
  conversationId: string | null;
  selected: { product: string; caseType: string } | null;
  onPicked: (picked: PickedCaseType) => void;
  onCleared: () => void;
  /** Told when the fields of a chosen case type start and stop being fetched, so what is typed meanwhile is not overwritten by them. */
  onFetching?: (fetching: boolean) => void;
  /** Told what the list of case types has come to, so the form can offer a typed id where the list cannot be read or lacks the case type. */
  onList?: (list: ListedCaseTypes) => void;
  disabled?: boolean;
}>) {
  const id = useId();
  const events = useHubSubscribe("assistant_pod_job");
  const [list, setList] = useState<ListState>(conversationId === null ? { state: "none" } : { state: "idle" });
  const [fetching, setFetching] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<{ message: string; value: string; retry: boolean } | null>(null);
  const [omitted, setOmitted] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const control = useRef<AbortController | null>(null);

  const listing = useRef<AbortController | null>(null);
  const fetchingRef = useRef(onFetching);
  fetchingRef.current = onFetching;
  const listedRef = useRef(onList);
  listedRef.current = onList;
  const listState = list.state;
  const listedTypes = list.state === "ready" ? list.types : NONE;
  useEffect(() => listedRef.current?.({ state: listState, types: listedTypes }), [listState, listedTypes]);
  const isFetching = fetching !== null;
  useEffect(() => fetchingRef.current?.(isFetching), [isFetching]);

  /** Asks the pod for the case types: when the person first opens the picker, and again on Try again. Never on page load, which would wake a stopped pod for a page that is only looked at. */
  function loadList(): void {
    if (conversationId === null) {
      return;
    }
    listing.current?.abort();
    const own = new AbortController();
    listing.current = own;
    setList({ state: "loading" });
    setWaking(false);
    void runPodJob<{ case_types: ListedCaseType[] }>(conversationId, "ccd.case-types", {}, eventsRef.current, own.signal, {
      ...WORDS,
      onWaking: () => setWaking(true)
    })
      .then((outcome) => {
        setWaking(false);
        setList(outcome.ok ? { state: "ready", types: outcome.result.case_types } : { state: "failed", message: outcome.message, retry: retryable(outcome) });
      })
      .catch(() => undefined);
  }

  useEffect(
    () => () => {
      control.current?.abort();
      listing.current?.abort();
    },
    []
  );

  async function choose(value: string): Promise<void> {
    control.current?.abort();
    setError(null);
    setOmitted(0);
    if (value === "" || list.state !== "ready" || conversationId === null) {
      setFetching(null);
      onCleared();
      return;
    }
    const type = list.types.find((t) => keyOf(t) === value);
    if (type === undefined) {
      return;
    }
    const own = new AbortController();
    control.current = own;
    setFetching(value);
    try {
      const outcome = await runPodJob<{ fields: CcdRow[]; omitted: number }>(
        conversationId,
        "ccd.case-type-fields",
        { case_type: type.case_type, product: type.product },
        eventsRef.current,
        own.signal,
        { ...WORDS, onWaking: () => setWaking(true) }
      );
      if (own.signal.aborted) {
        return;
      }
      if (outcome.ok) {
        setOmitted(outcome.result.omitted);
        onPicked({
          product: type.product,
          service: type.service,
          caseType: type.case_type,
          config: type.config,
          ...(type.repo ? { repo: type.repo } : {}),
          rows: outcome.result.fields,
          omitted: outcome.result.omitted
        });
      } else {
        setError({ message: outcome.message, value, retry: retryable(outcome) });
      }
    } catch {
      // Aborted: another case type was chosen, or the panel went away.
    } finally {
      if (!own.signal.aborted) {
        setFetching(null);
        setWaking(false);
      }
    }
  }

  const types = list.state === "ready" ? list.types : [];
  const current = fetching ?? (selected === null ? "" : `${selected.product}/${selected.caseType}`);
  const known = types.some((t) => keyOf(t) === current);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-asst-muted">
        Case type
      </label>
      <select
        id={id}
        className={`${FIELD} max-w-md`}
        value={current}
        disabled={disabled || list.state === "none" || fetching !== null}
        onFocus={() => (list.state === "idle" ? loadList() : undefined)}
        onMouseDown={() => (list.state === "idle" ? loadList() : undefined)}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">{list.state === "loading" ? "Reading your workspace…" : "No case type"}</option>
        {current !== "" && !known ? <option value={current}>{current.replace("/", ": ")}</option> : null}
        {[...types]
          .sort((a, b) => byCode(`${a.service}: ${a.case_type}`, `${b.service}: ${b.case_type}`))
          .map((t) => (
            <option key={keyOf(t)} value={keyOf(t)}>
              {`${t.service}: ${t.case_type}`}
            </option>
          ))}
      </select>
      <p aria-live="polite" className="text-[13px] text-asst-muted">
        {list.state === "none"
          ? NO_CHAT
          : waking
            ? WAKING_WORDS
            : fetching !== null
              ? "Reading the case type's fields. A service that builds its definition takes up to a minute…"
              : ""}
      </p>
      {omitted > 0 ? (
        <p role="status" className="text-[13px] text-asst-muted">
          {`The case type has more fields than fit in one answer (1 MiB): ${omitted} were left out, the nested ones first. Fields not listed read as new.`}
        </p>
      ) : null}
      {list.state === "failed" || error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-asst-error">
          <span>{error?.message ?? (list.state === "failed" ? list.message : "")}</span>
          {(error?.retry ?? (list.state === "failed" && list.retry)) ? (
            <button
              type="button"
              className="rounded-lg border border-asst-line px-2.5 py-1 text-asst-text"
              onClick={() => (error === null ? loadList() : void choose(error.value))}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
