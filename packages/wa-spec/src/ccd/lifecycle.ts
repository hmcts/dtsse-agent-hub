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
  /** Whether the event is `Publish: Y`, which is the only way Work Allocation sees it. */
  publish: boolean;
}

const Text = z.string().optional();

const StateRow = z.looseObject({ CaseTypeID: z.string(), ID: z.string(), Name: Text });
const CaseEventRow = z.looseObject({
  CaseTypeID: z.string(),
  ID: z.string(),
  Name: Text,
  "PreConditionState(s)": Text,
  PostConditionState: Text,
  Publish: Text
});
const CaseTypeRow = z.looseObject({ ID: z.string() });

const rowsOf = <S extends z.ZodType>(schema: S, sheet: string, files: Record<string, unknown>): Array<z.infer<S>> => {
  const value = files[sheet];
  if (value === undefined) {
    return [];
  }
  return z.array(schema).parse(value);
};

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

/**
 * One lifecycle per case type of the definition's `CaseType` sheet, from its `State` and `CaseEvent` sheets. `files` holds the
 * parsed rows of each sheet by sheet name, with a sheet split over several files already concatenated, so the same shape serves
 * a definition kept as JSON sheets and the JSON ccd-config-generator writes.
 */
export function readCcdDefinition(files: Record<string, unknown>): Lifecycle[] {
  const states = rowsOf(StateRow, "State", files);
  const events = rowsOf(CaseEventRow, "CaseEvent", files);
  const seen = new Set<string>();
  for (const { CaseTypeID, ID } of events) {
    if (seen.has(`${CaseTypeID}/${ID}`)) {
      throw new Error(`the event ${ID} of ${CaseTypeID} is defined more than once, so the definition store would refuse the import`);
    }
    seen.add(`${CaseTypeID}/${ID}`);
  }
  return rowsOf(CaseTypeRow, "CaseType", files).map(({ ID: caseType }) => ({
    caseType,
    states: states.filter((s) => s.CaseTypeID === caseType).map((s) => ({ id: s.ID, name: s.Name ?? s.ID })),
    events: events
      .filter((e) => e.CaseTypeID === caseType)
      .map((e) => {
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
          publish: ["Y", "YES", "TRUE"].includes(e.Publish?.trim().toUpperCase() ?? "")
        };
      })
  }));
}
