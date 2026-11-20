import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { describe, expect, it } from "vitest";
import {
  addField,
  addRule,
  addSection,
  allowedFor,
  assignmentsOf,
  blankField,
  casePathWords,
  clearLogicText,
  clearReview,
  clearTodo,
  conditionLabel,
  conditionsOf,
  formKeys,
  groupsOf,
  issuesByField,
  logicWords,
  mapRule,
  maxLengthOf,
  moveField,
  moveRule,
  moveSection,
  patchField,
  patchHeader,
  patchSection,
  removeField,
  removeRule,
  removeSection,
  reviewChecklist,
  whenOf,
  withAllowed,
  withAssignments,
  withElse,
  withGroup,
  withGroups,
  withRequired,
  wordsOf,
  writeAsRules
} from "./edit.ts";

const field = (over: object = {}) => ({ role: "field", label: "", inputType: "text", mandatory: "optional", keys: [], ccd: [], rules: [], todo: [], ...over });
const spec = {
  form: { name: "D8", formType: "D8", poBox: "PO 1" },
  sections: [
    { id: "1", title: "A", fields: [field({ id: "1.1", keys: ["a"], regex: "x", maxLength: 5 }), field({ id: "1.2", keys: ["b"] })] },
    { id: "2", title: "B", fields: [field({ id: "2.1", keys: ["c"], review: [{ about: "key", reason: "guess", confidence: "low" }] })] }
  ],
  composes: [],
  pageOrder: [],
  expectedDocuments: []
} as unknown as FormSpec;

describe("patching a spec", () => {
  it("should change one field and leave the others as they were", () => {
    const next = patchField(spec, 0, 1, { label: "Second" });
    expect(next.sections[0]?.fields[1]?.label).toBe("Second");
    expect(next.sections[0]?.fields[0]).toBe(spec.sections[0]?.fields[0]);
    expect(next.sections[1]).toBe(spec.sections[1]);
    expect(spec.sections[0]?.fields[1]?.label).toBe("");
  });

  it("should drop an id, regex or maximum length that is emptied", () => {
    const next = patchField(spec, 0, 0, { id: "", regex: "", maxLength: undefined });
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("id");
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("regex");
    expect(next.sections[0]?.fields[0]).not.toHaveProperty("maxLength");
  });

  it("should set the form's name and drop a PO box that is emptied", () => {
    const next = patchHeader(spec, { name: "D9", poBox: "" });
    expect(next.form.name).toBe("D9");
    expect(next.form).not.toHaveProperty("poBox");
    expect(patchHeader(spec, { formType: "" }).form.formType).toBe("");
  });
});

describe("reading what was typed", () => {
  it("should split keys on spaces, commas and new lines", () => {
    expect(wordsOf(" a, b\nc  d ")).toEqual(["a", "b", "c", "d"]);
  });

  it("should read a maximum length as a number, and an empty box as none", () => {
    expect(maxLengthOf("12")).toBe(12);
    expect(maxLengthOf("")).toBeUndefined();
  });
});

describe("issues", () => {
  it("should attach an issue to its field row and keep the rest for the form", () => {
    const { fields, form } = issuesByField([
      { path: "sections.0.fields.1.keys.0", message: "Too small" },
      { path: "sections.0.fields.1", message: "bad group" },
      { path: "sections", message: "the key is not a word" },
      { path: "", message: "Invalid input" }
    ]);
    expect(fields.get("0.1")).toEqual(["keys.0: Too small", "bad group"]);
    expect(form).toEqual(["sections: the key is not a word", "Invalid input"]);
  });
});

describe("review checklist", () => {
  it("should list every marked guess, lowest confidence first, naming its field", () => {
    expect(reviewChecklist(spec)).toEqual([{ at: "1.0", section: 1, field: 0, index: 0, where: "2.1", about: "key", reason: "guess", confidence: "low" }]);
    const first = spec.sections[0]?.fields[0];
    const mixed = {
      ...spec,
      sections: [{ ...(spec.sections[0] as object), fields: [{ ...first, review: [{ about: "ccd", reason: "r", confidence: "high" }] }] }, spec.sections[1]]
    } as unknown as FormSpec;
    expect(reviewChecklist(mixed).map((l) => l.confidence)).toEqual(["low", "high"]);
  });
});

const keysOf = (s: FormSpec, section: number) => s.sections[section]?.fields.map((f) => f.keys[0]);
const first = (s: FormSpec) => s.sections[0]?.fields[0] as FormSpec["sections"][number]["fields"][number];

describe("adding, removing and reordering", () => {
  it("should add a new field as an optional text field with an empty key at the end of its section", () => {
    const next = addField(spec, 0);
    expect(next.sections[0]?.fields).toHaveLength(3);
    expect(next.sections[0]?.fields[2]).toEqual(blankField());
    expect(blankField()).toMatchObject({ inputType: "text", mandatory: "optional", keys: [""] });
    expect(next.sections[1]).toBe(spec.sections[1]);
  });

  it("should remove a field, and move one a place up or down, but not off either end", () => {
    expect(keysOf(removeField(spec, 0, 0), 0)).toEqual(["b"]);
    expect(keysOf(moveField(spec, 0, 1, -1), 0)).toEqual(["b", "a"]);
    expect(keysOf(moveField(spec, 0, 0, 1), 0)).toEqual(["b", "a"]);
    expect(keysOf(moveField(spec, 0, 0, -1), 0)).toEqual(["a", "b"]);
    expect(keysOf(moveField(spec, 0, 1, 1), 0)).toEqual(["a", "b"]);
  });

  it("should add, rename, remove and move sections", () => {
    expect(addSection(spec).sections.map((s) => s.id)).toEqual(["1", "2", "3"]);
    expect(patchSection(spec, 1, { title: "Renamed" }).sections[1]?.title).toBe("Renamed");
    expect(removeSection(spec, 0).sections.map((s) => s.id)).toEqual(["2"]);
    expect(moveSection(spec, 1, -1).sections.map((s) => s.id)).toEqual(["2", "1"]);
    expect(moveSection(spec, 0, -1).sections.map((s) => s.id)).toEqual(["1", "2"]);
  });

  it("should list the keys a rule may name, leaving out empty keys and rows that are not read", () => {
    const next = addField(patchField(spec, 0, 1, { mandatory: "not-read" }), 1);
    expect(formKeys(next)).toEqual(["a", "c"]);
  });
});

describe("allowed values", () => {
  const kind = field({ keys: ["x", "y"], inputType: "checkbox" }) as unknown as ReturnType<typeof first>;

  it("should start from what a capture emits by default and replace one key's values only", () => {
    expect(allowedFor(kind, "x")).toEqual({ values: ["true", "false"], blankAllowed: false });
    const next = withAllowed(kind, "x", ["Yes", "No"], true);
    expect(allowedFor(next, "x")).toEqual({ values: ["Yes", "No"], blankAllowed: true });
    expect(allowedFor(next, "y")).toEqual({ values: ["true", "false"], blankAllowed: false });
    expect(next.emits?.map((e) => e.key)).toEqual(["x", "x", "x", "y", "y"]);
  });

  it("should keep the words that introduced a value that stays, and drop a value taken out", () => {
    const next = withAllowed(withAllowed(kind, "x", ["true", "false"], false), "x", ["true"], false);
    expect(next.emits?.find((e) => e.key === "x")).toEqual({ when: "if ticked", key: "x", value: "true" });
    expect(allowedFor(next, "x").values).toEqual(["true"]);
  });

  it("should treat no values as free text, and add a key the field has no values for", () => {
    const text = field({ keys: ["t"] }) as unknown as ReturnType<typeof first>;
    expect(allowedFor(text, "t")).toEqual({ values: [], blankAllowed: true });
    expect(allowedFor(withAllowed(text, "t", ["A"], false), "t")).toEqual({ values: ["A"], blankAllowed: false });
  });
});

describe("XoR groups", () => {
  const two = field({ keys: ["x", "y"] }) as unknown as ReturnType<typeof first>;

  it("should group a field's keys, and ungroup them", () => {
    const grouped = withGroup(two, true);
    expect(grouped.group).toEqual({ kind: "xor", size: 2, options: [{ key: "x" }, { key: "y" }] });
    expect(withGroup(grouped, false).group).toBeUndefined();
  });

  it("should not group one key", () => {
    expect(withGroup(field({ keys: ["x"] }) as never, true).group).toBeUndefined();
  });

  it("should keep the group's options to the keys when the keys change, and drop the group below two keys", () => {
    const grouped = withGroup(two, true);
    const s = { ...spec, sections: [{ id: "1", title: "", fields: [grouped] }] } as FormSpec;
    expect(patchField(s, 0, 0, { keys: ["x", "z"] }).sections[0]?.fields[0]?.group?.options).toEqual([{ key: "x" }, { key: "z" }]);
    expect(patchField(s, 0, 0, { keys: ["x"] }).sections[0]?.fields[0]?.group).toBeUndefined();
  });
});

describe("conditional mandatory", () => {
  const cond = (key: string, op: "=" | "ticked" | "filled", value = "") => ({ key, op, value }) as const;

  it("should set the condition and its wording for each kind of test", () => {
    expect(withRequired(first(spec), [cond("a", "ticked")]).required).toEqual({ label: "a is ticked", when: { a: { ticked: true } } });
    expect(withRequired(first(spec), [cond("a", "=", "Yes")]).required).toEqual({ label: "a = Yes", when: { a: "Yes" } });
    expect(withRequired(first(spec), [cond("a", "filled")]).required).toEqual({ label: "a is not blank", when: { a: { not: null } } });
  });

  it("should remove the condition when there are none, and when the field stops being conditional", () => {
    const conditional = withRequired(first(spec), [cond("a", "ticked")]);
    expect(withRequired(conditional, []).required).toBeUndefined();
    const s = { ...spec, sections: [{ id: "1", title: "", fields: [{ ...conditional, mandatory: "conditional" }] }] } as FormSpec;
    expect(patchField(s, 0, 0, { mandatory: "mandatory" }).sections[0]?.fields[0]?.required).toBeUndefined();
    expect(patchField(s, 0, 0, { label: "x" }).sections[0]?.fields[0]?.required).toBeDefined();
  });

  it("should read a condition back as the row that wrote it", () => {
    expect(conditionsOf({ a: { ticked: true }, b: { not: "x" }, c: null, d: { not: null }, e: true })).toEqual([
      { key: "a", op: "ticked", value: "" },
      { key: "b", op: "!=", value: "x" },
      { key: "c", op: "blank", value: "" },
      { key: "d", op: "filled", value: "" },
      { key: "e", op: "=", value: "true" }
    ]);
    expect(whenOf([])).toBeUndefined();
    expect(conditionLabel({ key: "k", op: "blank", value: "" })).toBe("k is blank");
  });
});

describe("rules", () => {
  const base = first(spec);

  it("should add, move and remove branches in order", () => {
    const two = mapRule(addRule(addRule(base)), 1, (r) => ({ ...r, note: "second" }));
    expect(moveRule(two, 1, -1).rules.map((r) => r.note)).toEqual(["second", undefined]);
    expect(moveRule(two, 0, -1).rules).toEqual(two.rules);
    expect(removeRule(two, 0).rules.map((r) => r.note)).toEqual(["second"]);
  });

  it("should write one condition as when, alternatives as whenAny, and none as neither", () => {
    const a = [{ key: "a", op: "=", value: "1" }] as const;
    const b = [{ key: "b", op: "ticked", value: "" }] as const;
    expect(withGroups({}, [[...a]])).toEqual({ when: { a: "1" } });
    expect(withGroups({}, [[...a], [...b]])).toEqual({ whenAny: [{ a: "1" }, { b: { ticked: true } }] });
    expect(withGroups({ when: { a: "1" } }, [])).toEqual({});
    expect(groupsOf({ whenAny: [{ a: "1" }, { b: null }] })).toHaveLength(2);
  });

  it("should make a branch ELSE by dropping its conditions, and back", () => {
    expect(withElse({ when: { a: "1" }, outcome: "warning" }, true)).toEqual({ otherwise: true, outcome: "warning" });
    expect(withElse({ otherwise: true }, false)).toEqual({});
  });

  it("should write assignments as literals or copies of a key", () => {
    const rule = withAssignments({}, [
      { target: "c1", copy: false, value: "Yes" },
      { target: "c2", copy: false, value: "true" },
      { target: "c3", copy: true, value: "a" }
    ]);
    expect(rule.set).toEqual({ c1: "Yes", c2: true, c3: { from: "a" } });
    expect(assignmentsOf(rule)).toEqual([
      { target: "c1", copy: false, value: "Yes" },
      { target: "c2", copy: false, value: "true" },
      { target: "c3", copy: true, value: "a" }
    ]);
    expect(withAssignments(rule, []).set).toBeUndefined();
  });

  it("should leave off an outcome, note or independent flag that is cleared", () => {
    const next = mapRule({ ...base, rules: [{ outcome: "warning", note: "n", independent: true }] }, 0, (r) => ({
      ...r,
      outcome: undefined,
      note: "",
      independent: false
    }));
    expect(next.rules[0]).toEqual({});
  });

  it("should word the rules as the sheet does, live, with the case path", () => {
    const rules = [
      { ref: "1", when: { a: "1" }, set: { c: { from: "a" } }, outcome: "warning" },
      { ref: "2", otherwise: true, outcome: "success" }
    ];
    const f = { ...base, rules } as typeof base;
    expect(logicWords(f)).toContain("If a = 1, c = a");
    expect(logicWords(f)).toContain("ELSE");
    expect(casePathWords(f)).toBe("1) = warning\n\n2) = success");
  });
});

describe("English logic and markers", () => {
  const stuck = {
    ...first(spec),
    logicText: "If x then y",
    todo: ["TODO: logic", "TODO: other"],
    review: [
      { about: "key", reason: "a", confidence: "low" },
      { about: "ccd", reason: "b", confidence: "low" }
    ]
  } as ReturnType<typeof first>;

  it("should start a rule list and keep the English until it is cleared", () => {
    const written = writeAsRules(stuck);
    expect(written.rules).toEqual([{}]);
    expect(logicWords({ ...stuck, rules: [] })).toBe("If x then y");
    expect(clearLogicText(written).logicText).toBeUndefined();
    expect(writeAsRules(written).rules).toHaveLength(1);
  });

  it("should clear one TODO or one review marker, and drop the review list when none is left", () => {
    const s = { ...spec, sections: [{ id: "1", title: "", fields: [stuck] }] } as FormSpec;
    expect(clearTodo(s, 0, 0, 0).sections[0]?.fields[0]?.todo).toEqual(["TODO: other"]);
    const one = clearReview(s, 0, 0, 0);
    expect(one.sections[0]?.fields[0]?.review).toEqual([{ about: "ccd", reason: "b", confidence: "low" }]);
    expect(clearReview(one, 0, 0, 0).sections[0]?.fields[0]).not.toHaveProperty("review");
  });
});
