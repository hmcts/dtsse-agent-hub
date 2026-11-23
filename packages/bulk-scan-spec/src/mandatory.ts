import type { Choice, DraftField } from "./pdf-draft.ts";
import type { Field, Operand, Review } from "./schema.ts";

/** What the form says about whether a field must be filled in. */
export interface MandatoryDecision {
  mandatory: Field["mandatory"];
  required?: NonNullable<Field["required"]>;
  review: Review[];
}

/** A bracketed note such as "(optional)", "(if known)" or "(if you have one)" in a field's own words. */
/** The form saying a tick box has to be ticked. */
const MUST_TICK = /\bmust\s+(?:be\s+)?tick(?:ed)?\b/i;

const OPTIONAL_NOTE = /\((?:optional|if [a-z ]+)\)/i;

interface Condition {
  label: string;
  when: Record<string, Operand>;
  reason: string;
  confidence: Review["confidence"];
}

const quote = (text: string): string => `'${text}'`;

function describe(choice: Choice): string {
  return choice.route ? `${quote(choice.label)} (${choice.route.text})` : quote(choice.label);
}

/** The draft the route points at, after the question that holds it. */
function targetOf(drafts: DraftField[], from: number, choice: Choice): number | undefined {
  const route = choice.route;
  if (!route) {
    return undefined;
  }
  const at = drafts.findIndex((d, i) => i > from && (route.kind === "section" ? d.sectionId === route.id : d.field.id === route.id));
  return at < 0 ? undefined : at;
}

/** Wording for "this option is picked", for a Yes/No pair's one key and for a box of its own. */
function pickedLabel(question: DraftField, choice: Choice, picked: boolean): string {
  if (question.choices?.some((c) => c.slot === choice.slot && c.ticked !== choice.ticked)) {
    return `${quote(question.field.label)} is answered ${choice.ticked === picked ? "Yes" : "No"}`;
  }
  return `${quote(choice.label)} is ${picked ? "ticked" : "not ticked"}`;
}

/**
 * What one routing question makes of the field at `index` after it: nothing when every option reaches it, a condition on the options that do,
 * or a note that the routes could not be followed.
 */
function routedBy(drafts: DraftField[], keys: string[][], at: number, index: number): Condition | { unresolved: string } | undefined {
  const question = drafts[at] as DraftField;
  const choices = question.choices ?? [];
  const targets = choices.map((c) => targetOf(drafts, at, c));
  const lost = choices.find((c, n) => c.route && targets[n] === undefined);
  if (lost?.route) {
    return {
      unresolved: `${describe(lost)} on question ${question.field.id ?? quote(question.field.label)} leads to ${lost.route.kind} ${lost.route.id}, which is not after it in the form`
    };
  }
  const reaching = choices.filter((_, n) => targets[n] === undefined || index >= (targets[n] as number));
  if (reaching.length === choices.length) {
    return undefined;
  }
  const skipping = choices.filter((c) => !reaching.includes(c));
  const where = `question ${question.field.id ?? quote(question.field.label)}`;
  if (reaching.length === 0) {
    return { unresolved: `every option of ${where} skips it` };
  }
  const key = (c: Choice): string => keys[at]?.[c.slot] ?? "";
  const [only] = reaching;
  if (only && reaching.length === 1) {
    return {
      label: pickedLabel(question, only, true),
      when: { [key(only)]: { ticked: only.ticked } },
      reason: `${where} sends ${describe(only)} here and skips it for ${skipping.map(describe).join(", ")}`,
      confidence: "medium"
    };
  }
  const [other] = skipping;
  if (other && skipping.length === 1) {
    return {
      label: pickedLabel(question, other, false),
      when: { [key(other)]: { ticked: !other.ticked } },
      reason: `${where} skips it only for ${describe(other)}; it is reached by ${reaching.map(describe).join(" and ")}, since a section the form does not route out of runs on into the next`,
      confidence: "low"
    };
  }
  return { unresolved: `${where} sends ${reaching.map(describe).join(", ")} here, which is more than one option and not all but one` };
}

/**
 * Every field is mandatory, with no marker, unless the form marks it "(optional)" or "(if …)", or an option's "go to" route skips the section or question it sits in,
 * in which case it is required when an option that reaches it is picked. A field whose routes cannot be followed stays mandatory.
 * `keys[i]` are the keys proposed for `drafts[i]`.
 */
export function decideMandatory(drafts: DraftField[], keys: string[][]): MandatoryDecision[] {
  const routing = drafts.flatMap((d, i) => (d.choices?.some((c) => c.route) ? [i] : []));
  return drafts.map((d, index) => {
    const note = [d.field.label, d.question].map((t) => OPTIONAL_NOTE.exec(t)?.[0]).find((n) => n !== undefined);
    if (note) {
      return { mandatory: "optional", review: [{ about: "mandatory", reason: `optional: the form marks it ${note}`, confidence: "high" }] };
    }
    const single = d.field.inputType === "checkbox" && d.choices?.length === 1;
    if (single && ![d.field.label, d.question].some((t) => MUST_TICK.test(t))) {
      return {
        mandatory: "optional",
        review: [{ about: "mandatory", reason: "optional: a single tick box, which the form does not say must be ticked", confidence: "medium" }]
      };
    }
    const conditions: Condition[] = [];
    const unresolved: string[] = [];
    for (const at of routing.filter((r) => r < index)) {
      const result = routedBy(drafts, keys, at, index);
      if (result && "unresolved" in result) {
        unresolved.push(result.unresolved);
      } else if (result) {
        conditions.push(result);
      }
    }
    const review: Review[] = unresolved.map((reason) => ({
      about: "mandatory",
      reason: `mandatory, but a person must check it: ${reason}`,
      confidence: "low"
    }));
    if (conditions.length === 0) {
      return {
        mandatory: "mandatory",
        review
      };
    }
    return {
      mandatory: "conditional",
      required: { label: conditions.map((c) => c.label).join(" and "), when: Object.assign({}, ...conditions.map((c) => c.when)) as Record<string, Operand> },
      review: [...review, ...conditions.map((c): Review => ({ about: "mandatory", reason: `required ${c.label}: ${c.reason}`, confidence: c.confidence }))]
    };
  });
}
