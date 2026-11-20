import { describe, expect, it } from "vitest";
import { fileText, fileText as ft7, JAVA as J7, JAVA, spec as mkspec, spec as sp9, spec } from "../__fixtures__/helpers.ts";
import { nfdivFiles } from "../codegen/java.ts";
import { expectedFor } from "../codegen/scenarios.ts";
import { fieldSchema } from "../schema.ts";
import { nfdivFiles as nf7 } from "./java.ts";
import { keyModels, keyModels as km9, sampleFromRegex, violatesFormat as vf9, violatesFormat } from "./model.ts";
import { scenarios as sc9, scenarios, unsatisfiedRules, validData } from "./scenarios.ts";

describe("expected outcomes", () => {
  it("should expect a warning when any key of a mandatory multi-key field is blank, even if the field has rules, as the generated validator does", () => {
    const s = spec([{ id: "4.3", keys: ["day", "month"], mandatory: "mandatory", rules: [{ ref: "1", otherwise: true, outcome: "success" }] }]);
    const expected = expectedFor(s, { day: "1", month: "" });
    expect(expected.validation).toBe("warning");
    const validator = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(validator).toContain('mandatory.put("month", data.getMonth());');
    expect(expectedFor(s, { day: "1", month: "2" }).validation).toBe("success");
  });
});

describe("exclusive groups", () => {
  const group = {
    id: "1.1",
    keys: ["opt1", "opt2", "opt3"],
    inputType: "checkbox",
    mandatory: "mandatory",
    group: { kind: "xor", size: 3, options: [{ key: "opt1" }, { key: "opt2" }, { key: "opt3" }] },
    emits: [
      { key: "opt1", value: "Yes" },
      { key: "opt1", value: "No" },
      { key: "opt2", value: "true" },
      { key: "opt2", value: "false" },
      { key: "opt3", value: "true" },
      { key: "opt3", value: "false" }
    ]
  };
  const s = spec([group]);

  it("should warn when more than one option of the group is ticked, over all options, and not when none or one is", () => {
    expect(expectedFor(s, { opt1: "Yes", opt2: "false", opt3: "true" }).validation).toBe("warning");
    expect(expectedFor(s, { opt1: "No", opt2: "false", opt3: "false" }).validation).toBe("warning");
    expect(expectedFor(s, { opt1: "No", opt2: "false", opt3: "true" }).validation).toBe("success");
    expect(expectedFor(s, { opt1: "Yes", opt2: "false", opt3: "false" }).validation).toBe("success");
  });

  it("should write Java that counts the ticked options when each option has its own ticked values", () => {
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(java).toContain('ticked(data.getOpt1(), "Yes")');
    expect(java).toContain('ticked(data.getOpt3(), "true")');
    expect(java).toContain("> 1");
    expect(java).not.toContain('FIELDS_CANNOT_MATCH, "opt1", "opt2"');
  });
});

describe("samples satisfy the keys' own checks", () => {
  it("should give every key of the valid submission a value that passes its format when the key has one", () => {
    const s = mkspec([
      { keys: ["code"], regex: "^[A-Z]{3}$" },
      { keys: ["ref"], regex: "^[0-9]{2}/[0-9]{2}$" },
      { keys: ["title"], regex: "^(Mr|Mrs)$" },
      { keys: ["applicantEmail", "applicantPostcode", "contactPhone", "birthDay", "birthMonth", "birthYear"] }
    ]);
    const data = validData(s);
    for (const m of keyModels(s)) {
      expect(violatesFormat(m, data[m.key]), m.key).toBe(false);
      expect(data[m.key], m.key).not.toBe("");
    }
  });

  it("should generate a string when the regex uses common constructs", () => {
    for (const pattern of ["^[A-Z]{3}$", "^\\d{4}$", "^[a-z]+@[a-z]+\\.com$", "^(yes|no)$", "^AB?C*$"]) {
      expect(new RegExp(pattern).test(sampleFromRegex(pattern) ?? ""), pattern).toBe(true);
    }
  });
});

describe("ticked values come from the option's own value set", () => {
  const options = ["opt1", "opt2"];
  const s = mkspec([
    {
      id: "1.1",
      keys: options,
      inputType: "checkbox",
      group: { kind: "xor", size: 2, options: options.map((key) => ({ key })) },
      emits: options.flatMap((key) => [
        { when: "if not ticked", key, value: "false" },
        { when: "if ticked", key, value: "true" }
      ])
    }
  ]);

  it("should tick an option with its on value even when the off value is listed first", () => {
    expect(validData(s)).toMatchObject({ opt1: "true", opt2: "false" });
    const branch = scenarios(s).find((x) => x.name === "xor-1.1-opt2");
    expect(branch?.data).toMatchObject({ opt1: "false", opt2: "true" });
    expect(scenarios(s).find((x) => x.name === "xor-1.1-all")?.data).toMatchObject({ opt1: "true", opt2: "true" });
  });
});

describe("allowed values are compared without regard to case", () => {
  it("should accept a listed value when it is in another case, and warn when it is not listed", () => {
    const s = mkspec([
      {
        keys: ["married"],
        emits: [
          { key: "married", value: "Yes" },
          { key: "married", value: "No" }
        ]
      }
    ]);
    expect(expectedFor(s, { married: "YES" }).validation).toBe("success");
    expect(expectedFor(s, { married: "maybe" }).validation).toBe("warning");
  });
});

describe("invalid-format scenarios", () => {
  it("should break each key's own pattern and label it truthfully when the key has a pattern, and skip keys with none", () => {
    const s = sp9([
      { keys: ["birthDay"], regex: "^[0-9]{2}$" },
      { keys: ["tickPhone"], inputType: "checkbox" },
      { keys: ["free"] },
      { keys: ["applicantEmail"] }
    ]);
    const list = sc9(s).filter((x) => x.kind === "invalid-format");
    expect(list.map((x) => x.name)).toEqual(["invalid-birthDay", "invalid-applicantEmail"]);
    const models = new Map(km9(s).map((m) => [m.key, m]));
    for (const x of list) {
      const key = x.name.replace("invalid-", "");
      expect(vf9(models.get(key) as never, x.data[key]), key).toBe(true);
    }
  });
});

describe("scenario names", () => {
  it("should be distinct without regard to case when two keys differ only by case", () => {
    const s = spec([
      { id: "1.1", keys: ["legalRepSigning"], mandatory: "mandatory" },
      { id: "1.2", keys: ["LegalRepSigning"], mandatory: "mandatory" }
    ]);
    const names = scenarios(s).map((x) => x.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
});

const checkboxGroup = () =>
  spec([
    {
      id: "1.1",
      keys: ["optA", "optB"],
      mandatory: "mandatory",
      inputType: "checkbox",
      group: { kind: "xor", size: 2, options: [{ key: "optA" }, { key: "optB" }] },
      emits: [
        { key: "optA", value: "true" },
        { key: "optA", value: "false" },
        { key: "optB", value: "true" },
        { key: "optB", value: "false" }
      ]
    }
  ]);

describe("a mandatory group with no option ticked", () => {
  it("should warn when every box is unticked with its false value, in the expectation, the Java and the xor-none scenario", () => {
    const s = checkboxGroup();
    expect(expectedFor(s, { optA: "false", optB: "false" }).validation).toBe("warning");
    expect(expectedFor(s, { optA: "true", optB: "false" }).validation).toBe("success");
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(java).toMatch(/GROUP_EMPTY_WARNING[\s\S]*?ticked\(/);
    expect(java).not.toMatch(/if \(isEmpty\(data\.getOptA\(\)\) && isEmpty\(data\.getOptB\(\)\)\)/);
    const none = scenarios(s).filter((x) => x.name.startsWith("xor-1.1-none"));
    expect(none.map((x) => x.data.optA)).toContain("false");
    expect(none.map((x) => x.data.optA)).toContain("");
    expect(none.every((x) => x.expected.validation === "warning")).toBe(true);
  });
});

describe("validData and mandatory keys", () => {
  it("should not blank a mandatory key to clear a rule warning, and report the rule instead", () => {
    const s = spec([
      {
        id: "1.1",
        keys: ["must"],
        mandatory: "mandatory",
        emits: [
          { key: "must", value: "x" },
          { key: "must", value: "" }
        ],
        rules: [
          { ref: "1", when: { must: "x" }, outcome: "warning" },
          { ref: "2", otherwise: true, outcome: "success" }
        ]
      }
    ]);
    expect(validData(s).must).toBe("x");
    expect(unsatisfiedRules(s)).toEqual(["1.1"]);
  });
});

describe("a group option that is not a key of the field", () => {
  it("should be rejected by the schema when an option key is missing from the field's keys", () => {
    expect(() => fieldSchema.parse({ keys: ["a"], group: { kind: "xor", size: 2, options: [{ key: "a" }, { key: "b" }] } })).toThrow();
  });

  it("should not crash or emit an empty condition when the generators meet one", () => {
    const s = checkboxGroup();
    const field = s.sections[0]?.fields[0];
    if (field?.group) {
      field.group.options.push({ key: "ghost" });
    }
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(java).not.toContain("if ( > 1)");
    expect(java).not.toContain("Ghost");
    expect(() => scenarios(s)).not.toThrow();
  });
});

describe("a mandatory tick box that is really a Yes/No question", () => {
  const question = () =>
    spec([
      {
        id: "1.1",
        keys: ["withoutCertificate"],
        mandatory: "mandatory",
        inputType: "checkbox",
        emits: ["Yes", "No", "Both", ""].map((value) => ({ key: "withoutCertificate", value }))
      }
    ]);

  it("should count No as an answer when the sheet lists Yes and No, and warn only on a blank", () => {
    expect(expectedFor(question(), { withoutCertificate: "No" }).validation).toBe("success");
    expect(expectedFor(question(), { withoutCertificate: "" }).validation).toBe("warning");
    expect(ft7(nf7(question(), J7), "nfdiv/validation/OcrValidator.java")).toContain(`mandatory.put("withoutCertificate"`);
    expect(scenarios(question()).some((x) => x.name === "missing-withoutCertificate-unticked")).toBe(false);
  });
});

describe("validData and exclusive groups", () => {
  it("should not tick a second option of a group to clear a warning when another candidate clears it", () => {
    const options = ["opt1", "opt2"];
    const s = mkspec([
      {
        id: "8.1",
        keys: [...options, "c"],
        inputType: "checkbox",
        group: { kind: "xor", size: 2, options: options.map((key) => ({ key })) },
        emits: [
          ...options.flatMap((key) => [
            { key, value: "true" },
            { key, value: "false" }
          ]),
          { key: "c", value: "p" },
          { key: "c", value: "x" }
        ],
        rules: [
          { ref: "1", when: { opt2: { ticked: true }, c: "x" }, outcome: "success" },
          { ref: "2", otherwise: true, outcome: "warning" }
        ]
      }
    ]);
    const data = validData(s);
    expect([data.opt1, data.opt2].filter((v) => v === "true")).toHaveLength(1);
    expect(expectedFor(s, data).validation).toBe("success");
  });
});
