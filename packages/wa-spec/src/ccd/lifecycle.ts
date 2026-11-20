import { z } from "zod";

export interface Lifecycle {
  caseType: string;
  states: Array<{ id: string; name: string }>;
  events: LifecycleEvent[];
}

export interface LifecycleEvent {
  id: string;
  name: string;
  /** The states the event can start from; empty for an event that creates the case. */
  preStates: string[] | "*";
  /** The first post-state; a conditional post-state such as `Accepted(cond):1;Rejected` has the others in `otherPostStates`, where a `*` is the case staying in its state. */
  postState: string | "*";
  otherPostStates?: string[];
  /** The definition names no post-state, as ccd-config-generator writes for `postStateFromCallback`: the about-to-submit callback chooses it, so it can be any state. */
  postStateFromCallback?: true;
  /** The event has an about-to-submit callback, whose response may set any state: CCD data store applies it over the post-state. */
  aboutToSubmitCallback?: true;
  /** Whether the event is `Publish: Y`, which is the only way Work Allocation sees it. */
  publish: boolean;
}

/** The values the definition store reads as true for a yes/no column (`DefinitionDataItem.getBoolean`). */
const PUBLISH_VALUES = ["yes", "y", "t", "true"];

const Text = z.string().optional();

const StateRow = z.looseObject({ CaseTypeID: z.string(), ID: z.string(), Name: Text });
const CaseEventRow = z.looseObject({
  CaseTypeID: z.string(),
  ID: z.string(),
  Name: Text,
  "PreConditionState(s)": Text,
  PostConditionState: Text,
  Publish: Text,
  CallBackURLAboutToSubmitEvent: Text
});
const CaseTypeRow = z.looseObject({ ID: z.string() });

const rowsOf = <S extends z.ZodType>(schema: S, sheet: string, files: Record<string, unknown>, where?: Source): Array<z.infer<S>> => {
  const value = files[sheet];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${sheet} is not a list of rows`);
  }
  return value.map((row, index) => {
    const result = schema.safeParse(row);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(`${where?.(sheet, index) ?? `${sheet} row ${index + 1}`}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "is not valid"}`);
    }
    return result.data;
  });
};

/** Where a sheet's row came from, for an error message. */
export type Source = (sheet: string, index: number) => string;

/** Splits a `;` separated state list; `*` anywhere means every state. */
const stateList = (text: string | undefined): string[] | "*" => {
  const states = (text ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return states.includes("*") ? "*" : states;
};

/**
 * A post-state may carry a condition and a priority, `Accepted(preAcceptCase.caseAccepted="Yes"):1`; the state is what precedes
 * them. A `*` among other states is kept: the case may stay where it is.
 */
const postStates = (text: string | undefined): string[] | "*" => {
  const listed = (text ?? "")
    .split(";")
    .map((s) => s.replace(/\(.*$/s, "").trim())
    .filter(Boolean);
  return listed.length === 0 || listed.every((s) => s === "*") ? "*" : listed;
};

/** A source such as `dir/CaseEvent-prod.json row 3` without its row. */
const fileOf = (source: string): string => source.replace(/ row \d+$/, "");

/** A file name without its variant suffix, so `CaseEvent-prod.json` and `CaseEvent-nonprod.json` are alike. */
const stem = (file: string): string => file.replace(/-[^-/]+\.json$/, ".json");

/** The rows of a case type's events, which the definition store would refuse if two shared an id. */
function eventsOf<T extends { ID: string; CaseTypeID: string }>(rows: Array<{ e: T; index: number }>, caseType: string, where?: Source): T[] {
  const own = rows.filter(({ e }) => e.CaseTypeID === caseType);
  const first = new Map<string, number>();
  for (const { e, index } of own) {
    const before = first.get(e.ID);
    if (before === undefined) {
      first.set(e.ID, index);
      continue;
    }
    const sources = [before, index].map((i) => where?.("CaseEvent", i) ?? `CaseEvent row ${i + 1}`);
    const [one, two] = sources.map(fileOf) as [string, string];
    const variants = one !== two && stem(one) === stem(two) ? `; these files differ only by a variant suffix, so exclude one with --env or --exclude` : "";
    throw new Error(`the event ${e.ID} of ${caseType} is defined in ${sources.join(" and ")}, so the definition store would refuse the import${variants}`);
  }
  return own.map(({ e }) => e);
}

/**
 * One lifecycle per case type of the definition's `CaseType` sheet, from its `State` and `CaseEvent` sheets. `files` holds the
 * parsed rows of each sheet by sheet name, with a sheet split over several files already concatenated, so the same shape serves
 * a definition kept as JSON sheets and the JSON ccd-config-generator writes. With `only`, just those case types (compared
 * without regard to case) are read and checked.
 */
export function readCcdDefinition(files: Record<string, unknown>, only?: readonly string[], where?: Source): Lifecycle[] {
  const states = rowsOf(StateRow, "State", files, where);
  const events = rowsOf(CaseEventRow, "CaseEvent", files, where);
  const wanted = only?.map((id) => id.toLowerCase());
  const caseTypes = rowsOf(CaseTypeRow, "CaseType", files, where).filter(({ ID }) => !wanted || wanted.includes(ID.toLowerCase()));
  return caseTypes.map(({ ID: caseType }) => ({
    caseType,
    states: states.filter((s) => s.CaseTypeID === caseType).map((s) => ({ id: s.ID, name: s.Name ?? s.ID })),
    events: eventsOf(
      events.map((e, index) => ({ e, index })),
      caseType,
      where
    ).map((e) => {
      const fromCallback = (e.PostConditionState ?? "").trim() === "";
      const post = postStates(e.PostConditionState);
      const [first, ...others] = post === "*" ? ["*"] : post;
      return {
        id: e.ID,
        name: e.Name ?? e.ID,
        preStates: stateList(e["PreConditionState(s)"]),
        postState: first ?? "*",
        ...(others.length > 0 ? { otherPostStates: others } : {}),
        ...(fromCallback ? { postStateFromCallback: true as const } : {}),
        ...((e.CallBackURLAboutToSubmitEvent ?? "").trim() !== "" ? { aboutToSubmitCallback: true as const } : {}),
        publish: PUBLISH_VALUES.includes(e.Publish?.toLowerCase() ?? "")
      };
    })
  }));
}
