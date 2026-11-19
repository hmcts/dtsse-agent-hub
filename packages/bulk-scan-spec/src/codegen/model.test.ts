import { describe, expect, it } from "vitest";
import { fileText, JAVA, spec as sp6, spec as sp9, spec } from "../__fixtures__/helpers.ts";
import { nfdivFiles } from "../codegen/java.ts";
import { evaluateRules, FORMAT_REGEXES, partitionRules } from "../codegen/model.ts";
import { expectedFor, validData } from "../codegen/scenarios.ts";
import {
  anchoredPattern,
  directMappings,
  directMappings as dm6,
  keyModels as km2,
  resolveRef as rr6,
  sampleFromRegex as sfr7,
  violatesFormat as vf
} from "./model.ts";

describe("one order for rules", () => {
  const rules = [
    { ref: "1", when: { a: "x" }, set: { c1: "1" }, outcome: "success" },
    { ref: "2", when: { a: "y" }, set: { c1: "2" }, outcome: "success" },
    { ref: "3", set: { e: "always" }, outcome: "success" },
    { ref: "4", independent: true, when: { b: "z" }, set: { d: "1" }, outcome: "success" }
  ];
  const s = spec([{ id: "1.1", keys: ["a", "b"], ccd: ["c1", "d", "e"], rules }]);
  const field = s.sections[0]?.fields[0];

  it("should partition rules into else-chains when an independent branch starts one, with unconditional rules apart", () => {
    const { chains, unconditional } = partitionRules(field?.rules ?? []);
    expect(chains.map((c) => c.map((r) => r.ref))).toEqual([["1", "2"], ["4"]]);
    expect(unconditional.map((r) => r.ref)).toEqual(["3"]);
  });

  it("should apply every chain and every unconditional rule when the rules are evaluated, so the engine and the generated Java do the same work in the same order", () => {
    if (!field) {
      throw new Error("no field");
    }
    const verdict = evaluateRules(s, field, { a: "y", b: "z" });
    expect(Object.keys(verdict?.set ?? {})).toEqual(["c1", "d", "e"]);
    expect(verdict?.set).toEqual({ c1: "2", d: "1", e: "always" });
    expect(evaluateRules(s, field, { a: "q", b: "q" })?.set).toEqual({ e: "always" });
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/transformation/TFormToCaseTransformer.java");
    const order = [...java.matchAll(/caseData\.put\("(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["c1", "c1", "d", "e"]);
    expect(java.match(/\bif \(matches/g)).toHaveLength(3);
  });

  it("should give the same answer through expectedFor and validData as through evaluateRules when the same data is checked", () => {
    const warned = spec([
      {
        id: "1.1",
        keys: ["a", "b"],
        rules: [
          { ref: "1", when: { a: "x" }, outcome: "success" },
          { ref: "2", independent: true, when: { b: "bad" }, outcome: "warning" }
        ]
      }
    ]);
    expect(expectedFor(warned, { a: "x", b: "bad" }).validation).toBe("warning");
    expect(expectedFor(warned, { a: "x", b: "fine" }).validation).toBe("success");
    expect(Object.keys(validData(warned))).toEqual(["a", "b"]);
  });
});

describe("directMappings", () => {
  it("should treat a rule as a pass-through only when it copies the row's own key", () => {
    const rows = [
      { keys: ["a"], ccd: ["ca"], rules: [{ set: { ca: { from: "a" } } }] },
      { keys: ["b"], ccd: ["cb"], rules: [{ set: { cb: "Yes" } }] },
      { keys: ["c"], ccd: ["cc"], rules: [{ set: { cc: { from: "other" } } }] },
      { keys: ["d"], ccd: ["cd"] }
    ];
    expect([...directMappings(spec(rows)).entries()]).toEqual([
      ["ca", "a"],
      ["cd", "d"]
    ]);
  });
});

describe("format patterns match the whole value", () => {
  it("should anchor a pattern the same way for every generator when it is emitted, and test whole values in JS", () => {
    expect(anchoredPattern("[A-Z]{3}")).toBe("^(?:[A-Z]{3})$");
    expect(anchoredPattern("^[A-Z]{3}$")).toBe("^(?:[A-Z]{3})$");
    expect(anchoredPattern("^a|b$")).toBe("^(?:a|b)$");
    const [model] = km2(sp9([{ keys: ["code"], regex: "[A-Z]{3}" }]));
    if (!model) {
      throw new Error("no model");
    }
    expect(vf(model, "ABC")).toBe(false);
    expect(vf(model, "ABCD")).toBe(true);
    expect(vf(model, "xABC")).toBe(true);
  });
});

describe("resolveRef matches whole words", () => {
  it("should not match a value against part of a word when resolving a reference, and refuse an ambiguous match", () => {
    const s = sp6([
      { id: "1.1", keys: ["applicantKnowsAddress"], group: undefined },
      {
        id: "1.2",
        keys: ["aJointApplication", "aSoleApplication"],
        group: { kind: "xor", size: 2, options: [{ key: "aJointApplication" }, { key: "aSoleApplication" }] }
      },
      { id: "1.3", keys: ["jointOne", "jointTwo"], group: { kind: "xor", size: 2, options: [{ key: "jointOne" }, { key: "jointTwo" }] } },
      { id: "1.4", keys: ["noticeGiven", "no"], group: { kind: "xor", size: 2, options: [{ key: "noticeGiven" }, { key: "no" }] } }
    ]);
    expect(rr6(s, "1.2", "jointApplication")).toEqual({ aJointApplication: { ticked: true } });
    expect(rr6(s, "1.3", "joint")).toBeUndefined();
    expect(rr6(s, "1.4", "no")).toEqual({ no: { ticked: true } });
    const two = sp6([
      { id: "2.1", keys: ["applicantKnowsAddress", "other"], group: { kind: "xor", size: 2, options: [{ key: "applicantKnowsAddress" }, { key: "other" }] } }
    ]);
    expect(rr6(two, "2.1", "no")).toBeUndefined();
  });
});

describe("directMappings ignores fields with logic text", () => {
  it("should not call a field a plain copy when it only carries a preamble, text or a TODO", () => {
    const s = sp6([
      { keys: ["a"], ccd: ["ca"], logicPreamble: "Map multiple to fields" },
      { keys: ["b"], ccd: ["cb"], logicText: "odd" },
      { keys: ["c"], ccd: ["cc"], todo: ["TODO: something"] },
      { keys: ["d"], ccd: ["cd"] }
    ]);
    expect([...dm6(s).keys()]).toEqual(["cd"]);
  });
});

describe("the engine answers only for rules the generated Java can test", () => {
  it("should leave a field undecided when any branch carries English, even if an earlier branch holds", () => {
    const s = spec([
      {
        id: "1.1",
        keys: ["a"],
        rules: [
          { ref: "1", when: { a: "x" }, outcome: "warning" },
          { ref: "2", when: { a: "y" }, action: "something in English", outcome: "success" }
        ]
      }
    ]);
    const field = s.sections[0]?.fields[0];
    if (!field) {
      throw new Error("no field");
    }
    expect(evaluateRules(s, field, { a: "x" })).toBeUndefined();
    expect(fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java")).not.toContain("Row 1.1, branch");
  });
});

describe("sampleFromRegex on malformed patterns", () => {
  it("should treat an unclosed brace as a literal and never hang when a pattern is sampled", () => {
    expect(sfr7("^[A-Z]{2,$")).toBe("A{2,");
    expect(sfr7("^a{$")).toBe("a{");
    expect(sfr7("^(((((")).toBeUndefined();
    expect(sfr7("^a|{|")).toBe("a");
  });
});

describe("inferred format patterns", () => {
  const matches = (format: keyof typeof FORMAT_REGEXES, value: string) => new RegExp(FORMAT_REGEXES[format]).test(value);

  it.each([
    ["email", "x@y.digital"],
    ["email", "test.user+tag@example.co.uk"],
    ["postcode", "SW1A1AA"],
    ["postcode", "SW1A 1AA"],
    ["postcode", "m1 1ae"],
    ["phone", "+44 7700 900123"],
    ["phone", "+44 (0)7700 900123"],
    ["phone", "+447700900123"],
    ["phone", "01234567890"],
    ["phone", "0161 496 0000"]
  ] as const)("should accept the %s value %s when it is a real captured shape", (format, value) => {
    expect(matches(format, value)).toBe(true);
  });

  it.each([
    ["email", "not-an-email"],
    ["email", "a@b.c"],
    ["email", "a@b"],
    ["postcode", "ABCDEF"],
    ["postcode", "12345"],
    ["phone", "12345"],
    ["phone", "+44 77"],
    ["phone", "abcdefghijk"]
  ] as const)("should reject the %s value %s when it is not that shape", (format, value) => {
    expect(matches(format, value)).toBe(false);
  });
});

describe("key models", () => {
  it("should give a key listed on two rows the mandatory flag of either and the allowed values of both", () => {
    const models = km2(
      spec([
        { id: "1.1", keys: ["a"], mandatory: "mandatory", emits: [{ key: "a", value: "x" }] },
        { id: "1.2", keys: ["a"], mandatory: "optional", emits: [{ key: "a", value: "y" }] }
      ])
    );
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ key: "a", mandatory: true, allowed: ["x", "y"] });
  });

  it("should leave out a key the form does not read when the models are built", () => {
    const models = km2(spec([{ id: "2.1", keys: ["fullName"], mandatory: "not-read", inputType: "none" }, { keys: ["b"] }]));
    expect(models.map((m) => m.key)).toEqual(["b"]);
  });
});
