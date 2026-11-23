import { byCode } from "./compare.ts";
import type { CcdMatch, Field, FormSpec } from "./schema.ts";
import { dice, tokens, words as words_ } from "./similarity.ts";

/** One case field of a CCD case type, as matching needs it. */
export interface CcdField {
  id: string;
  label: string;
  type: string;
  typeParameter?: string;
  hint?: string;
}

export interface CcdRow {
  ID?: unknown;
  Label?: unknown;
  FieldType?: unknown;
  FieldTypeParameter?: unknown;
  HintText?: unknown;
  CaseTypeID?: unknown;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The rows as matching reads them, leaving out label fields and rows without an id. */
export function ccdFieldsOf(rows: CcdRow[]): CcdField[] {
  return rows.flatMap((r) =>
    typeof r.ID === "string" && r.ID !== "" && r.FieldType !== "Label"
      ? [
          {
            id: r.ID,
            label: str(r.Label),
            type: str(r.FieldType),
            ...(str(r.FieldTypeParameter) ? { typeParameter: str(r.FieldTypeParameter) } : {}),
            ...(str(r.HintText) ? { hint: str(r.HintText) } : {})
          }
        ]
      : []
  );
}

/** The CCD FieldTypes a new field may be given: every one the matcher proposes, and the ones a person may pick instead. */
export const NEW_FIELD_TYPES = [
  "Text",
  "TextArea",
  "Email",
  "PhoneUK",
  "Postcode",
  "Number",
  "Date",
  "DateTime",
  "YesOrNo",
  "FixedRadioList",
  "FixedList",
  "MultiSelectList",
  "AddressUK",
  "AddressGlobalUK"
] as const;
export type NewFieldType = (typeof NEW_FIELD_TYPES)[number];

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

/** Whether `next` is a field of `ref`'s own section whose label is `word`: the box after a day box, not a row of another kind or section. */
function isBox(next: Ref | undefined, ref: Ref, word: RegExp): boolean {
  return next !== undefined && next.s === ref.s && next.field.role === "field" && word.test(firstLine(next.field.label));
}

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
    const [month, year] = [refs[i + 1], refs[i + 2]];
    if (day && isBox(month, ref, /^month$/i) && isBox(year, ref, /^year$/i)) {
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

/** A case field's words and parties, worked out once for a match rather than once for each form field. */
interface Prepared {
  field: CcdField;
  idWords: Set<string>;
  labelWords: Set<string>;
  hintWords: Set<string>;
  parties: Set<string>;
  inStyle: boolean;
}

function prepare(fields: CcdField[], prefix: Set<string>, lead: string): Prepared[] {
  return fields.map((field) => {
    const idWords = new Set([...tokens(field.id)].filter((w) => !prefix.has(w)));
    const labelWords = tokens(field.label);
    return {
      field,
      idWords,
      labelWords,
      hintWords: tokens(field.hint ?? ""),
      parties: partiesOf(idWords.size > 0 && partiesOf(idWords).size > 0 ? idWords : labelWords),
      inStyle: lead !== "" && field.id.startsWith(lead)
    };
  });
}

function score(subject: Subject, candidate: Prepared): number {
  const { idWords, labelWords, hintWords } = candidate;
  // The id leads and the label or hint only confirms it: labels repeat across a case type (every phone field is "Phone number").
  const byId = dice(subject.own, idWords);
  const byText = Math.max(dice(subject.own, labelWords), 0.8 * dice(subject.own, hintWords));
  let base = Math.max(byId, (byId + byText) / 2);
  let shared: string | undefined;
  let sharedCount = 0;
  for (const w of subject.own) {
    if (idWords.has(w) || labelWords.has(w) || hintWords.has(w)) {
      shared = w;
      sharedCount++;
    }
  }
  if (sharedCount === 1 && WEAK.has(shared as string)) {
    base *= 0.5;
  }
  let factor = 1;
  if (subject.parties.size > 0) {
    if (candidate.parties.size === 0) {
      factor = 0.95;
    } else {
      factor = [...candidate.parties].some((p) => subject.parties.has(p)) ? 1.25 : 0.7;
    }
  }
  return Math.min(1, base * factor * (candidate.inStyle ? 1.05 : 1));
}

function rank(subject: Subject, pool: Prepared[]): Scored[] {
  return pool
    .map((candidate) => {
      const fits = compatible(subject.shape, candidate.field);
      return { field: candidate.field, fits, score: score(subject, candidate) * (fits ? 1 : INCOMPATIBLE) };
    })
    .filter((s) => s.score >= SUGGEST * INCOMPATIBLE)
    .sort((a, b) => b.score - a.score || byCode(a.field.id, b.field.id));
}

/** The CCD FieldType a new field for this row would be given, as the matcher gives it when it proposes one. */
export function proposedTypeOf(field: Field, types: Set<string> = new Set()): string {
  const label = firstLine(field.label);
  const address = field.inputType === "text" && ADDRESS_START.test(label) && !NOT_ADDRESS.test(label);
  return proposedType({ label, shape: address ? "address" : shapeOf(field), ...(field.maxLength ? { maxLength: field.maxLength } : {}) }, types);
}

function proposedType(subject: Pick<Subject, "label" | "shape" | "maxLength">, types: Set<string>): string {
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
  let words = words_(firstLine(subject.label));
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
  const ident = (id: string): string => (/^[A-Za-z_]/.test(id) ? id : `field${id.charAt(0).toUpperCase()}${id.slice(1)}`);
  let id = ident(make(words));
  if (taken.has(id)) {
    id = ident(make(qualified));
  }
  for (let n = 2; taken.has(id); n++) {
    id = `${ident(make(qualified))}${n}`;
  }
  return id;
}

/** An id a person set, typed or chose, or one that came with the form: not one the matcher proposed against some case type. */
const isKept = (field: Field): boolean => field.ccd.length > 0 && (field.ccdMatch === undefined || field.ccdMatch.chosenBy !== undefined);

export interface MatchOptions {
  /** Leave the ids a person set, typed or chose alone and only say whether they exist; ids the matcher proposed are matched again. */
  keepSet?: boolean;
  /** Map only the rows that carry an id, as a sheet's rows are: the others get no status and no proposal. */
  onlyMapped?: boolean;
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
  const prepared = prepare(top, prefixWords, lead);
  // The matcher's own earlier proposals are proposed again, so only ids that stay and the case type's own are taken.
  const taken = new Set<string>([...known, ...refs.flatMap((r) => (options.keepSet && isKept(r.field) ? r.field.ccd : []))]);
  /** `match` undefined clears the row's status: a row the case type leaves unmapped keeps nothing of an earlier case type's. */
  const out = new Map<number, { ccd: string[]; match: CcdMatch | undefined }>();

  const keptMembers = (subject: Subject): number[] => (options.keepSet ? subject.members.filter((m) => isKept((refs[m] as Ref).field)) : []);
  interface Decision {
    subject: Subject;
    kept: number[];
    ranked: Scored[];
    /** Tells apart the group of the rows decided afresh from that of the rows that kept their ids. */
    groupSuffix?: string;
  }
  const decisions = subjects.flatMap((subject): Decision[] => {
    const kept = keptMembers(subject);
    const rest = subject.members.filter((m) => !kept.includes(m));
    // Only rows that carry an id are mapped: a sheet leaves the others unmapped on purpose, and keeps nothing of an earlier match on them.
    if (options.onlyMapped) {
      for (const m of rest) {
        out.set(m, { ccd: (refs[m] as Ref).field.ccd, match: undefined });
      }
      return kept.length > 0 ? [{ subject, kept, ranked: [] }] : [];
    }
    if (kept.length === 0) {
      return [{ subject, kept, ranked: rank(subject, prepared) }];
    }
    // The rows of the group that no person set are decided again against this case type, not left with the last one's.
    const decided: Decision[] = [{ subject, kept, ranked: [] }];
    if (rest.length > 0) {
      const restSubject = { ...subject, members: rest };
      decided.push({ subject: restSubject, kept: [], ranked: rank(restSubject, prepared), groupSuffix: "r" });
    }
    return decided;
  });

  const claimed = new Map<string, number>();
  decisions.forEach((d, i) => {
    const best = d.ranked[0];
    if (best?.fits && best.score >= EXISTING && best.score - (d.ranked.find((r) => r.fits && r !== best)?.score ?? 0) >= MARGIN) {
      const rival = claimed.get(best.field.id);
      if (rival === undefined || (decisions[rival]?.ranked[0]?.score ?? 0) < best.score) {
        claimed.set(best.field.id, i);
      }
    }
  });

  /** A row that keeps its own ids: whether the case type has them, and the field to add when it lacks one. */
  const ownDecision = (subject: Subject, member: number, group: string | undefined): { ccd: string[]; match: CcdMatch } => {
    const { field } = refs[member] as Ref;
    const ccd = field.ccd;
    const [missing, ...more] = ccd.filter((id) => !known.has(id));
    const chosen = { chosenBy: field.ccdMatch?.chosenBy === "person" ? ("person" as const) : ("form" as const), ...(group ? { group } : {}) };
    return {
      ccd,
      match:
        missing === undefined
          ? { status: "existing", ...chosen }
          : {
              status: "new",
              newField: { id: missing, type: field.ccdMatch?.newField?.type ?? proposedType(subject, types) },
              ...(more.length > 0 ? { extraNewFields: more.map((id) => ({ id, type: proposedType(subject, types) })) } : {}),
              reason: "this id is not a field of the case type",
              ...chosen
            }
    };
  };

  decisions.forEach((d, i) => {
    const { subject, kept, ranked } = d;
    const group = subject.members.length > 1 ? `g${subject.members[0]}${d.groupSuffix ?? ""}` : undefined;
    if (kept.length > 0) {
      // A row of the group with no id of its own is left as it is: the ids and who set them belong to the rows that have them.
      for (const m of kept) {
        out.set(m, ownDecision(subject, m, group));
      }
      return;
    }
    const best = ranked[0];
    const newField = (): { id: string; type: string } => {
      const id = proposedId(subject, lead, taken);
      taken.add(id);
      return { id, type: proposedType(subject, types) };
    };
    let ccd: string[];
    let match: CcdMatch;
    if (best?.fits && claimed.get(best.field.id) === i) {
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
      out.set(m, { ccd, match: group ? { ...match, group } : match });
    }
  });

  let at = 0;
  return {
    ...spec,
    sections: spec.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        const decided = out.get(at++);
        if (!decided) {
          return field;
        }
        if (decided.match === undefined) {
          const { ccdMatch: _match, ...rest } = field;
          return { ...rest, ccd: decided.ccd };
        }
        return { ...field, ccd: decided.ccd, ccdMatch: decided.match };
      })
    }))
  };
}

/** The new fields a form needs added to its case type, once each, in form order. */
export function newCcdFields(spec: FormSpec): { id: string; type: string; label: string }[] {
  const seen = new Map<string, { id: string; type: string; label: string }>();
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const match = field.ccdMatch?.status === "new" ? field.ccdMatch : undefined;
      for (const add of [match?.newField, ...(match?.extraNewFields ?? [])]) {
        if (add && !seen.has(add.id)) {
          seen.set(add.id, { id: add.id, type: add.type, label: firstLine(field.label) });
        }
      }
    }
  }
  return [...seen.values()];
}
