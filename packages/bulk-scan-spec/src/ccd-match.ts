import { byCode } from "./compare.ts";
import type { CcdMatch, Field, FormSpec } from "./schema.ts";
import { dice, tokens } from "./similarity.ts";

/** One case field of a CCD case type, as matching needs it. */
export interface CcdField {
  id: string;
  label: string;
  type: string;
  typeParameter?: string;
  hint?: string;
}

/** What a form field is, for deciding which CCD field types it can be stored in. */
export type Shape = "text" | "date" | "yesno" | "choice" | "checkbox" | "address" | "number";

const COMPATIBLE: Record<Shape, readonly string[]> = {
  text: ["Text", "TextArea", "Email", "PhoneUK", "Postcode"],
  date: ["Date", "DateTime"],
  yesno: ["YesOrNo"],
  choice: ["FixedList", "FixedRadioList", "MultiSelectList"],
  checkbox: ["YesOrNo", "MultiSelectList"],
  address: ["AddressUK", "AddressGlobalUK", "AddressGlobal"],
  number: ["Number"]
};

const SUGGEST = 0.4;
const EXISTING = 0.75;
const MARGIN = 0.1;
const INCOMPATIBLE = 0.5;
const MAX_CANDIDATES = 3;
/** A prefix is the service's style when this share of its field ids start with it. */
const STYLE_SHARE = 0.25;
const MIN_STYLE = 5;

export function compatible(shape: Shape, field: Pick<CcdField, "type" | "typeParameter">): boolean {
  if (COMPATIBLE[shape].includes(field.type)) {
    return true;
  }
  return shape === "yesno" && field.type === "FixedRadioList" && /^yes_?no$/i.test(field.typeParameter ?? "");
}

const PARTIES: Record<string, string> = {
  applicant: "main",
  appellant: "main",
  subject: "main",
  claimant: "main",
  petitioner: "main",
  representative: "rep",
  solicitor: "rep",
  respondent: "respondent",
  defendant: "respondent",
  applicant1: "one",
  applicant2: "two"
};

/** The parties a set of words names. "Appellant's representative" is about the representative, so a named representative or respondent leaves the main party out. */
function partiesOf(...sets: Set<string>[]): Set<string> {
  const found = new Set<string>();
  for (const set of sets) {
    for (const word of set) {
      const party = PARTIES[word];
      if (party) {
        found.add(party);
      }
    }
  }
  if (found.has("main") && (found.has("rep") || found.has("respondent"))) {
    found.delete("main");
  }
  return found;
}

/** Words that name a kind of value rather than which one: sharing only these says little. */
const WEAK = new Set(["first", "last", "second", "line", "number", "name", "date", "detail", "type", "case", "reference", "no", "other", "full"]);

const camelWords = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

/** The leading word or two most of the case type's own ids share (`cicCase`), or none when no prefix is that common. */
export function stylePrefix(ids: string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const parts = camelWords(id);
    for (const n of [1, 2]) {
      if (parts.length > n) {
        const prefix = parts.slice(0, n).join("");
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
  }
  const common = [...counts].filter(([, n]) => n >= MIN_STYLE && n >= ids.length * STYLE_SHARE).sort((a, b) => b[0].length - a[0].length || byCode(a[0], b[0]));
  const best = common[0]?.[0] ?? "";
  return /^[a-z]/.test(best) ? best : "";
}

const GENERIC = new Set(["information", "detail", "section", "your", "about", "appeal", "appealing", "request", "reason", "following", "behalf", "on"]);
const FILLER = new Set(["first", "line", "contact", "detail", "what", "name"]);

const pascal = (parts: string[]): string => parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");

interface Subject {
  /** Indexes into the flattened field list. */
  members: number[];
  label: string;
  own: Set<string>;
  context: Set<string>;
  parties: Set<string>;
  shape: Shape;
  section: string;
  maxLength?: number;
}

type Ref = { s: number; f: number; field: Field };

const YES_NO_QUESTION = /^\s*(do|does|did|is|are|was|were|have|has|will|would|can|could|should)\b/i;
const ADDRESS_START = /\baddress\b/i;
const NOT_ADDRESS = /e-?mail|\bip address\b/i;
const ADDRESS_PART = /\b(line|town|city|county|post ?code|country|street|building|dx|firm)\b/i;

const firstLine = (label: string): string => (label.split("\n")[0] ?? "").trim();

function shapeOf(field: Field): Shape {
  if (field.inputType === "date") {
    return "date";
  }
  if (field.inputType === "checkbox") {
    const options = field.group?.options ?? [];
    if (options.length === 0) {
      return "checkbox";
    }
    const named = options.map((o) => `${o.key} ${o.label ?? ""}`.toLowerCase());
    const yes = named.some((n) => /(^|[^a-z])yes/.test(n));
    const no = named.some((n) => /(^|[^a-z])no([^a-z]|$)/.test(n));
    return (options.length === 2 && yes && no) || (YES_NO_QUESTION.test(field.label) && (field.group?.size ?? 2) <= 2) ? "yesno" : "choice";
  }
  return field.regex && /^\^?\\d[+*]?\$?$|^\^?\[0-9]/.test(field.regex) ? "number" : "text";
}

function sectionWords(title: string): string[] {
  return title
    .replace(/^section\s+\d+\s*[–-]?\s*/i, "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !GENERIC.has(w) && !tokenStop(w));
}

const tokenStop = (w: string): boolean => tokens(w).size === 0;

function subjectsOf(refs: Ref[], titles: string[]): Subject[] {
  const subjects: Subject[] = [];
  const used = new Set<number>();
  const base = (members: number[], label: string, shape: Shape, own: Set<string>): Subject => {
    const first = refs[members[0] as number] as Ref;
    const title = titles[first.s] ?? "";
    const keyTokens = tokens(members.map((m) => (refs[m] as Ref).field.keys.join(" ")).join(" "));
    const section = tokens(title.replace(/^section\s+\d+\s*[–-]?\s*/i, ""));
    return {
      members,
      label,
      own,
      context: new Set([...section, ...keyTokens]),
      parties: partiesOf(own, section, keyTokens),
      shape,
      section: title,
      ...(first.field.maxLength ? { maxLength: first.field.maxLength } : {})
    };
  };
  refs.forEach((ref, i) => {
    const { field } = ref;
    if (used.has(i) || field.role !== "field" || field.keys.length === 0 || field.inputType === "qr" || field.inputType === "none") {
      return;
    }
    const label = firstLine(field.label);
    if (field.inputType === "text" && ADDRESS_START.test(label) && !NOT_ADDRESS.test(label)) {
      const members = [i];
      for (let j = i + 1; j < refs.length; j++) {
        const next = refs[j] as Ref;
        if (next.s !== ref.s || next.field.id || !ADDRESS_PART.test(next.field.label)) {
          break;
        }
        members.push(j);
      }
      const own = new Set([...tokens(label)].filter((w) => !FILLER.has(w)));
      for (const m of members) {
        used.add(m);
      }
      subjects.push(base(members, label, "address", own));
      return;
    }
    const day = /^(.*?)\s*\bday\b\s*$/i.exec(label);
    if (
      day &&
      refs[i + 1] &&
      /^month$/i.test(firstLine((refs[i + 1] as Ref).field.label)) &&
      refs[i + 2] &&
      /^year$/i.test(firstLine((refs[i + 2] as Ref).field.label))
    ) {
      const members = [i, i + 1, i + 2];
      for (const m of members) {
        used.add(m);
      }
      subjects.push(base(members, day[1] ?? label, "date", tokens(day[1] ?? label)));
      return;
    }
    used.add(i);
    subjects.push(base([i], label, shapeOf(field), tokens(label)));
  });
  return subjects;
}

interface Scored {
  field: CcdField;
  score: number;
  fits: boolean;
}

function score(subject: Subject, ccd: CcdField, prefix: Set<string>, lead: string): number {
  const idWords = new Set([...tokens(ccd.id)].filter((w) => !prefix.has(w)));
  const labelWords = tokens(ccd.label);
  const hintWords = tokens(ccd.hint ?? "");
  // The id leads and the label or hint only confirms it: labels repeat across a case type (every phone field is "Phone number").
  const byId = dice(subject.own, idWords);
  const byText = Math.max(dice(subject.own, labelWords), 0.8 * dice(subject.own, hintWords));
  let base = Math.max(byId, (byId + byText) / 2);
  const shared = [...subject.own].filter((w) => idWords.has(w) || labelWords.has(w) || hintWords.has(w));
  if (shared.length === 1 && WEAK.has(shared[0] as string)) {
    base *= 0.5;
  }
  const candidateParties = partiesOf(idWords.size > 0 && partiesOf(idWords).size > 0 ? idWords : labelWords);
  let factor = 1;
  if (subject.parties.size > 0) {
    if (candidateParties.size === 0) {
      factor = 0.95;
    } else {
      factor = [...candidateParties].some((p) => subject.parties.has(p)) ? 1.25 : 0.7;
    }
  }
  return Math.min(1, base * factor * (lead && ccd.id.startsWith(lead) ? 1.05 : 1));
}

function rank(subject: Subject, pool: CcdField[], prefix: Set<string>, lead: string): Scored[] {
  return pool
    .map((field) => {
      const fits = compatible(subject.shape, field);
      return { field, fits, score: score(subject, field, prefix, lead) * (fits ? 1 : INCOMPATIBLE) };
    })
    .filter((s) => s.score >= SUGGEST * INCOMPATIBLE)
    .sort((a, b) => b.score - a.score || byCode(a.field.id, b.field.id));
}

function proposedType(subject: Subject, types: Set<string>): string {
  const label = subject.label.toLowerCase();
  switch (subject.shape) {
    case "date":
      return "Date";
    case "yesno":
    case "checkbox":
      return "YesOrNo";
    case "choice":
      return "FixedRadioList";
    case "number":
      return "Number";
    case "address":
      return types.has("AddressUK") || !types.has("AddressGlobalUK") ? "AddressUK" : "AddressGlobalUK";
    default:
      if (types.has("Email") && /e-?mail/.test(label)) {
        return "Email";
      }
      if (types.has("PhoneUK") && /phone|mobile|telephone/.test(label)) {
        return "PhoneUK";
      }
      return (subject.maxLength ?? 0) > 255 || /\b(explain|describe|tell us|reasons?|details of)\b/.test(label) ? "TextArea" : "Text";
  }
}

function proposedId(subject: Subject, prefix: string, taken: Set<string>): string {
  let words = [
    ...firstLine(subject.label)
      .replace(/\([^)]*\)/g, " ")
      .toLowerCase()
      .matchAll(/[a-z0-9]+/g)
  ]
    .map((m) => m[0])
    .filter((w) => tokens(w).size > 0 || w === "date");
  if (subject.shape === "address") {
    words = words.filter((w) => !FILLER.has(w) && w !== "line");
    if (!words.includes("address")) {
      words.push("address");
    }
  }
  if (words.length === 0) {
    words = ["field"];
  }
  words = words.slice(0, 5);
  const qualifier = words.length <= 2 ? sectionWords(subject.section).slice(-2) : [];
  const qualified = [...qualifier.filter((q) => !words.includes(q)), ...words];
  const make = (parts: string[]): string => `${prefix}${prefix ? pascal(parts) : (parts[0] ?? "") + pascal(parts.slice(1))}`;
  let id = make(words);
  if (taken.has(id)) {
    id = make(qualified);
  }
  for (let n = 2; taken.has(id); n++) {
    id = `${make(qualified)}${n}`;
  }
  return id;
}

export interface MatchOptions {
  /** Leave the CCD ids a field already has alone and only say whether they exist. */
  keepSet?: boolean;
}

/** `ccd` ids and `ccdMatch` for every field of a form that is read, from the case type's fields. */
export function matchCcd(spec: FormSpec, fields: CcdField[], options: MatchOptions = {}): FormSpec {
  const top = fields.filter((f) => f.type !== "Label" && !f.id.includes("."));
  const known = new Set(fields.map((f) => f.id));
  const types = new Set(top.map((f) => f.type));
  const lead = stylePrefix(top.map((f) => f.id));
  const prefixWords = new Set(tokens(lead));
  const refs: Ref[] = spec.sections.flatMap((section, s) => section.fields.map((field, f) => ({ s, f, field })));
  const titles = spec.sections.map((s) => s.title);
  const subjects = subjectsOf(refs, titles);
  const taken = new Set<string>([...known, ...refs.flatMap((r) => r.field.ccd)]);
  const out = new Map<number, { ccd: string[]; match: CcdMatch }>();

  const decisions = subjects.map((subject) => {
    const set = options.keepSet ? (refs[subject.members.find((m) => (refs[m] as Ref).field.ccd.length > 0) ?? -1]?.field.ccd ?? []) : [];
    const ranked = rank(subject, top, prefixWords, lead);
    return { subject, set, ranked };
  });

  const claimed = new Map<string, number>();
  decisions.forEach((d, i) => {
    const best = d.ranked[0];
    if (d.set.length === 0 && best?.fits && best.score >= EXISTING && best.score - (d.ranked.find((r) => r.fits && r !== best)?.score ?? 0) >= MARGIN) {
      const rival = claimed.get(best.field.id);
      if (rival === undefined || (decisions[rival]?.ranked[0]?.score ?? 0) < best.score) {
        claimed.set(best.field.id, i);
      }
    }
  });

  decisions.forEach((d, i) => {
    const { subject, set, ranked } = d;
    const best = ranked[0];
    const newField = (): { id: string; type: string } => {
      const id = proposedId(subject, lead, taken);
      taken.add(id);
      return { id, type: proposedType(subject, types) };
    };
    let ccd: string[];
    let match: CcdMatch;
    if (set.length > 0) {
      ccd = set;
      const here = set.every((id) => known.has(id));
      const prior = subject.members.map((m) => (refs[m] as Ref).field.ccdMatch?.newField).find(Boolean);
      match = here
        ? { status: "existing" }
        : {
            status: "new",
            newField: { id: set[0] as string, type: prior?.type ?? proposedType(subject, types) },
            reason: "this id is not a field of the case type"
          };
    } else if (best?.fits && claimed.get(best.field.id) === i) {
      ccd = [best.field.id];
      match = { status: "existing", reason: `closest field of the case type by wording (similarity ${best.score.toFixed(2)})` };
    } else if (best && best.score >= SUGGEST) {
      const candidates = ranked.filter((r) => r.score >= SUGGEST).slice(0, MAX_CANDIDATES);
      ccd = [];
      match = {
        status: "unsure",
        candidates: candidates.map((c) => ({ id: c.field.id, type: c.field.type, ...(c.field.label.trim() ? { label: c.field.label.trim() } : {}) })),
        newField: newField(),
        reason: best.fits ? "more than one close field, or not close enough to be sure" : `closest field is a ${best.field.type}, which does not fit this input`
      };
    } else {
      const proposed = newField();
      ccd = [proposed.id];
      match = { status: "new", newField: proposed, reason: "no field of the case type is close" };
    }
    for (const m of subject.members) {
      out.set(m, { ccd, match });
    }
  });

  let at = 0;
  return {
    ...spec,
    sections: spec.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        const decided = out.get(at++);
        return decided ? { ...field, ccd: decided.ccd, ccdMatch: decided.match } : field;
      })
    }))
  };
}

/** The new fields a form needs added to its case type, once each, in form order. */
export function newCcdFields(spec: FormSpec): { id: string; type: string; label: string }[] {
  const seen = new Map<string, { id: string; type: string; label: string }>();
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const add = field.ccdMatch?.status === "new" ? field.ccdMatch.newField : undefined;
      if (add && !seen.has(add.id)) {
        seen.set(add.id, { id: add.id, type: add.type, label: firstLine(field.label) });
      }
    }
  }
  return [...seen.values()];
}
