import type { Emit, Field } from "./schema.ts";

const NAME = /"?metadata_field_name"?\s*:\s*"?([^"\s,]*)"?/;
const VALUE = /"?metadata_field_value"?\s*:\s*"([^"]*)"/;

/** Reads the key/value pairs a Description cell lists, with the words that introduce each. A name with no value line is kept with an empty value. */
export function parseEmits(description: string): Emit[] {
  const emits: Emit[] = [];
  let pending: string[] = [];
  let key: string | undefined;
  for (const line of description.split("\n")) {
    const name = NAME.exec(line);
    const value = VALUE.exec(line);
    if (name?.[1] !== undefined && value) {
      const when = pending.join("\n").trim();
      emits.push({ ...(when ? { when } : {}), key: name[1], value: value[1] ?? "" });
      pending = [];
      key = undefined;
      continue;
    }
    if (name?.[1] !== undefined) {
      if (key !== undefined) {
        emits.push({ key, value: "" });
      }
      key = name[1];
      continue;
    }
    if (value) {
      // A value line with no name before it is the sheet's own typo for a name line.
      if (key === undefined) {
        key = value[1] ?? "";
        continue;
      }
      const when = pending.join("\n").trim();
      emits.push({ ...(when ? { when } : {}), key, value: value[1] ?? "" });
      pending = [];
      key = undefined;
      continue;
    }
    if (line.trim() !== "") {
      pending.push(line.trim());
    }
  }
  if (key !== undefined) {
    emits.push({ key, value: "" });
  }
  return emits;
}

/** What a Yes and No question emits, in the words the D8 sheet uses: Yes, No, or blank when it is left empty. */
export function yesNoEmits(key: string): Emit[] {
  return [
    { when: "if yes", key, value: "Yes" },
    { when: "if no", key, value: "No" },
    { when: "if empty", key, value: "" }
  ];
}

/** What a capture emits for a field the spec author has not enumerated: a tick box gives true or false, anything else free text. */
export function defaultEmits(field: Field): Emit[] {
  if (field.role !== "field") {
    return [];
  }
  return field.keys.flatMap((key): Emit[] =>
    field.inputType === "checkbox"
      ? [
          { when: "if ticked", key, value: "true" },
          { when: "if not ticked", key, value: "false" }
        ]
      : [{ key, value: "" }]
  );
}

export function emitsOf(field: Field): Emit[] {
  return field.emits ?? defaultEmits(field);
}

export interface ValueSet {
  key: string;
  /** Every non-empty string the capture may send, in the sheet's order. */
  allowed: string[];
  blankAllowed: boolean;
  /** The sheet's words for the blank case, e.g. "if empty". */
  blankMeans?: string;
}

/** The exact OCR strings each key of a field may carry. */
export function valueSets(field: Field): ValueSet[] {
  const sets = new Map<string, ValueSet>();
  for (const e of emitsOf(field)) {
    const set = sets.get(e.key) ?? { key: e.key, allowed: [], blankAllowed: false };
    if (e.value === "") {
      set.blankAllowed = true;
      set.blankMeans ??= e.when;
    } else if (!set.allowed.includes(e.value)) {
      set.allowed.push(e.value);
    }
    sets.set(e.key, set);
  }
  return [...sets.values()];
}

/** The value set a field lists for a key: under the key's own spelling, else under one that differs only in case. */
export function valueSetFor(field: Field, key: string): ValueSet | undefined {
  const sets = valueSets(field);
  return sets.find((s) => s.key === key) ?? sets.find((s) => s.key.toLowerCase() === key.toLowerCase());
}

export function renderEmits(emits: Emit[]): string {
  return emits.map((e) => `${e.when ? `${e.when}\n` : ""}"metadata_field_name": "${e.key}"\n"metadata_field_value": "${e.value}"`).join("\n");
}

/** Keys the Description lists that the Tag Name column does not, and the reverse. */
export function keyConflicts(field: Field): { descriptionOnly: string[]; tagOnly: string[] } {
  const described = [...new Set(emitsOf(field).map((e) => e.key))];
  return {
    descriptionOnly: field.emits ? described.filter((k) => !field.keys.includes(k)) : [],
    tagOnly: field.emits ? field.keys.filter((k) => !described.includes(k)) : []
  };
}
