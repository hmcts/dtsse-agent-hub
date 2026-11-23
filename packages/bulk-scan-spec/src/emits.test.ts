import { describe, expect, it } from "vitest";
import { YES_NO } from "./__fixtures__/helpers.ts";
import { defaultEmits, keyConflicts, parseEmits, renderEmits, valueSets } from "./emits.ts";
import { parseLogic } from "./logic.ts";
import { fieldSchema } from "./schema.ts";

describe("emits and logic edge cases", () => {
  it("should read a name and value when they are written on one line", () => {
    expect(parseEmits('if ticked\n{"metadata_field_name": "a", "metadata_field_value": "b"}\n"metadata_field_name": "c"\n"metadata_field_value": ""')).toEqual([
      { when: "if ticked", key: "a", value: "b" },
      { key: "c", value: "" }
    ]);
  });

  it("should never produce an empty alternative when an OR is not followed by a condition", () => {
    const result = parseLogic("1) If a = null OR see the form, success", "1) = success", { keys: ["a"], ccd: [] });
    expect(result.parsed).toBe(true);
    if (result.parsed) {
      for (const rule of result.rules) {
        expect(rule.whenAny?.some((g) => Object.keys(g).length === 0) ?? false).toBe(false);
      }
      expect(result.rules[0]?.action ?? "").not.toBe(undefined);
    }
  });
});

describe("value sets", () => {
  it("should read the exact strings a key may carry when the sheet words the blank in its own way", () => {
    const field = fieldSchema.parse({ keys: ["married", "reason"], emits: parseEmits(YES_NO) });
    expect(valueSets(field)).toEqual([
      { key: "married", allowed: ["Yes", "No", "Both"], blankAllowed: true, blankMeans: "else empty" },
      { key: "reason", allowed: [], blankAllowed: true, blankMeans: undefined }
    ]);
  });

  it("should write the emits back as the sheet words them when the spec is rendered", () => {
    expect(renderEmits(parseEmits(YES_NO)).replace(/\n+/g, "\n")).toBe(YES_NO);
  });

  it("should take a value line as the sheet's typo for a name when it lacks a name, and tolerate a missing quote", () => {
    expect(parseEmits('if ticked\n"metadata_field_value": "aJoint"\n"metadata_field_value": "true"')).toEqual([
      { when: "if ticked", key: "aJoint", value: "true" }
    ]);
    expect(parseEmits('"metadata_field_name": last"\n"metadata_field_value": ""')).toEqual([{ key: "last", value: "" }]);
  });

  it("should offer true and false when the author has not enumerated a tick box", () => {
    expect(valueSets(fieldSchema.parse({ inputType: "checkbox", keys: ["a"] }))).toEqual([{ key: "a", allowed: ["true", "false"], blankAllowed: false }]);
  });

  it("should list keys the Description emits that the Tag Name column lacks, and the reverse, when the two columns disagree", () => {
    const field = fieldSchema.parse({ keys: ["tagKey"], emits: [{ key: "descKey", value: "" }] });
    expect(keyConflicts(field)).toEqual({ descriptionOnly: ["descKey"], tagOnly: ["tagKey"] });
  });
});

describe("parseEmits with a name and no value", () => {
  it("should keep a name line with an empty value when the next line names another key or the text ends", () => {
    expect(parseEmits('"metadata_field_name": "a"\n"metadata_field_name": "b"\n"metadata_field_value": "x"\n"metadata_field_name": "c"')).toEqual([
      { key: "a", value: "" },
      { key: "b", value: "x" },
      { key: "c", value: "" }
    ]);
  });
});

describe("defaultEmits for a Yes and No pair", () => {
  it("should list Yes, No and blank for a one-key tick box in a group of two, and true and false for any other tick box", () => {
    const base = { role: "field", label: "", inputType: "checkbox", mandatory: "mandatory", ccd: [], rules: [], todo: [] } as const;
    const pair = fieldSchema.parse({ ...base, keys: ["q"], group: { kind: "xor", size: 2, options: [{ key: "q" }] } });
    expect(defaultEmits(pair)).toEqual([
      { when: "if yes", key: "q", value: "Yes" },
      { when: "if no", key: "q", value: "No" },
      { when: "if empty", key: "q", value: "" }
    ]);
    expect(defaultEmits(fieldSchema.parse({ ...base, keys: ["t"] })).map((e) => e.value)).toEqual(["true", "false"]);
  });
});
