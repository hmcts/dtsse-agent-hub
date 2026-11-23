import { describe, expect, it } from "vitest";
import {
  balanced,
  fileText,
  fileText as ft2,
  fileText as ft9,
  fileText as ftR8,
  JAVA as J2,
  JAVA as J9,
  JAVA,
  JAVA as JR8,
  spec as sp2,
  spec as sp9,
  spec,
  spec as spP,
  spec as spR8
} from "../__fixtures__/helpers.ts";
import { probateFiles } from "../codegen/java.ts";
import { evaluateRules, keyModels } from "../codegen/model.ts";
import { fieldSchema as fsR8, formSpecSchema as fssR8 } from "../schema.ts";
import { nfdivFiles as nf2, nfdivFiles as nf9, nfdivFiles, nfdivFiles as nfP, nfdivFiles as nfR8 } from "./java.ts";
import { partitionRules as prR8 } from "./model.ts";
import { expectedFor as efR8, expectedFor, unsatisfiedSamples as usR8, validData } from "./scenarios.ts";
import { sscsSchema as sscs9 } from "./sscs.ts";

describe("generated Java chains", () => {
  const rules = [
    { ref: "1", when: { k1: "a" }, set: { c: "x" }, outcome: "warning" },
    { ref: "2", set: { d: "y" }, outcome: "success" },
    { ref: "3", otherwise: true, set: { c: "z" }, outcome: "warning" }
  ];
  const field = { id: "1.1", keys: ["k1"], ccd: ["c", "d"], rules };

  it("should keep braces balanced when an unconditional rule sits between a condition and its ELSE", () => {
    const files = nfdivFiles(spec([field]), JAVA);
    expect(balanced(fileText(files, "nfdiv/validation/OcrValidator.java"))).toBe(true);
    expect(balanced(fileText(files, "nfdiv/transformation/TFormToCaseTransformer.java"))).toBe(true);
    expect(fileText(files, "nfdiv/transformation/TFormToCaseTransformer.java")).toContain('caseData.put("d", "y");');
  });

  it("should emit independent branches as separate ifs when no ELSE joins them, not else-ifs", () => {
    const independent = {
      id: "2.1",
      keys: ["k1", "k2"],
      ccd: ["c"],
      rules: [
        { ref: "1a", when: { k1: "a" }, set: { c: "x" } },
        { ref: "1b", independent: true, when: { k2: "b" }, set: { c: "y" } }
      ]
    };
    const text = fileText(nfdivFiles(spec([independent]), JAVA), "nfdiv/transformation/TFormToCaseTransformer.java");
    expect(text).toContain('if (matches(ocr.getK2(), "b")) {');
    expect(text).not.toContain("else if");
    expect(balanced(text)).toBe(true);
  });

  it("should test a null operand with the empty check when a condition compares with null, rather than the string 'null'", () => {
    const conditional = { id: "3.1", keys: ["k1", "k2"], mandatory: "conditional", required: { label: "x", when: { k1: { not: null } } } };
    const text = fileText(nfdivFiles(spec([conditional]), JAVA), "nfdiv/validation/OcrValidator.java");
    expect(text).toContain("!matches(data.getK1(), null)");
    expect(text).not.toContain('"null"');
  });

  it("should negate a sheet id as one NOT over all of its keys when it resolves to several keys", () => {
    const group = {
      id: "1.2",
      keys: ["aSole", "aJoint"],
      group: { kind: "xor", size: 2, options: [{ key: "aSole" }, { key: "aJoint" }] },
      rules: [{ ref: "1", when: { aJoint: true, aSole: { not: true } }, set: { type: "joint" }, outcome: "success" }],
      ccd: ["type"]
    };
    const other = { id: "3.4", keys: ["k"], ccd: ["kk"], rules: [{ ref: "1", when: { "1.2": { not: "joint" } }, set: { kk: "q" }, outcome: "success" }] };
    const s = spec([group, other]);
    const text = fileText(nfdivFiles(s, JAVA), "nfdiv/transformation/TFormToCaseTransformer.java");
    expect(text).toContain(`if (!(matches(ocr.getJoint(), "true") && !matches(ocr.getSole(), "true"))) {`);
    const f = s.sections[0]?.fields[1];
    if (!f) {
      throw new Error("no field");
    }
    expect(evaluateRules(s, f, { aJoint: "true", aSole: "false" })).toBeUndefined();
    expect(evaluateRules(s, f, { aJoint: "false", aSole: "true" })).toMatchObject({ set: { kk: "q" } });
  });

  it("should give probate fields the same JSON aliases as nfdiv's when keys need explicit names", () => {
    const text = fileText(
      probateFiles(spec([{ keys: ["deceased_forenames", "aSoleApplication"], mandatory: "mandatory" }]), JAVA),
      "probate/ExceptionRecordOCRFields.java"
    );
    expect(text).toContain('@JsonProperty("deceased_forenames")');
    expect(text).toContain('@JsonProperty("aSoleApplication")');
    expect(text).toContain("import com.fasterxml.jackson.annotation.JsonProperty;");
  });
});

describe("generated validator and key models", () => {
  it("should define the matches helper once when several comparisons use it", () => {
    const s = spec([{ id: "1.1", keys: ["a"], rules: [{ ref: "1", when: { a: "x" }, outcome: "warning" }] }]);
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(java.match(/private static boolean matches/g)).toHaveLength(1);
  });

  it("should not carry a readable flag when nothing reads it", () => {
    const [first] = keyModels(spec([{ keys: ["a"] }]));
    expect(Object.keys(first ?? {})).not.toContain("readable");
  });
});

describe("generated Java: description-only keys, exceptions and formats", () => {
  it("should not call a getter and should say so in a TODO when a copied key is missing from the model", () => {
    const s = spec([
      {
        id: "1.1",
        keys: ["a"],
        ccd: ["c"],
        emits: [
          { key: "a", value: "" },
          { key: "descOnly", value: "" }
        ],
        rules: [{ ref: "1", when: { a: "x" }, set: { c: { from: "descOnly" } }, outcome: "success" }]
      }
    ]);
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/transformation/TFormToCaseTransformer.java");
    expect(java).not.toContain("getDescOnly");
    expect(java).toContain("TODO(sheet 1.1)");
  });

  it("should copy the key and note the outcome of the other branch when only some branches set a value", () => {
    const s = spec([
      {
        id: "1.1",
        keys: ["a"],
        ccd: ["c"],
        rules: [
          { ref: "1", when: { a: null }, outcome: "warning" },
          { ref: "2", otherwise: true, set: { c: { from: "a" } }, outcome: "success" }
        ]
      }
    ]);
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/transformation/TFormToCaseTransformer.java");
    expect(java).not.toContain("TODO(sheet 1.1)");
    expect(java).toContain('caseData.put("c", ocr.getA());');
    expect(java).toContain("// sheet: warning");
  });

  it("should warn in validate-ocr and refuse in the transformation when the outcome is an exception, and say so in the expectation", () => {
    const s = spec([
      {
        id: "1.1",
        keys: ["a"],
        rules: [
          { ref: "1", when: { a: "bad" }, outcome: "exception" },
          { ref: "2", when: { a: "meh" }, outcome: "warning" },
          { ref: "3", otherwise: true, outcome: "success" }
        ]
      }
    ]);
    const files = nfdivFiles(s, JAVA);
    const validator = fileText(files, "nfdiv/validation/OcrValidator.java");
    expect(validator).not.toContain("errors.add(");
    expect(validator).toContain('warnings.add("Row 1.1, branch 1: the transformation sheet gives case path exception");');
    const transformer = fileText(files, "nfdiv/transformation/TFormToCaseTransformer.java");
    expect(transformer).toContain("throw new InvalidDataException(");
    expect(transformer).toContain("transformationErrors.add(");
    expect(transformer).toContain("transformationWarnings.add(");
    expect(transformer).toContain('caseData.put("warnings"');
    const bad = expectedFor(s, { a: "bad" });
    expect(bad).toMatchObject({ validation: "exception", validateOcr: "WARNINGS", transformation: "exception-record" });
    expect(expectedFor(s, { a: "meh" })).toMatchObject({ validateOcr: "WARNINGS", transformation: "case-created-with-warnings" });
    expect(expectedFor(s, { a: "fine" })).toMatchObject({ validation: "success", validateOcr: "SUCCESS", transformation: "case-created" });
  });

  it("should check formats the same way the schema and the fis patterns do when a value is validated, and expect a warning when it fails", () => {
    const s = spec([{ keys: ["applicantEmail", "markDay"], inputType: "text" }]);
    const java = fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java");
    expect(java).toContain('FORMAT_PATTERNS.put("applicantEmail"');
    expect(java).toContain("FIELD_FORMAT_WARNING");
    expect(expectedFor(s, { applicantEmail: "not-an-email", markDay: "1" }).validation).toBe("warning");
    expect(expectedFor(s, { applicantEmail: "Test@Example.com", markDay: "31" }).validation).toBe("success");
    expect(expectedFor(s, { applicantEmail: "a@b.co", markDay: "99" }).validation).toBe("warning");
    expect(expectedFor(s, { applicantEmail: "", markDay: "" }).validation).toBe("success");
  });
});

describe("formats are not inferred for tick boxes", () => {
  it("should not apply a phone format when a tick box's name ends in Phone", () => {
    const s = spec([{ keys: ["cardPaymentPhone"], inputType: "checkbox" }]);
    expect(expectedFor(s, { cardPaymentPhone: "false" }).validation).toBe("success");
    expect(fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java")).not.toContain("FORMAT_PATTERNS.put");
  });
});

describe("generated allowed-value check", () => {
  it("should compare allowed values without regard to case when they are validated, as matches and ticked do", () => {
    const java = ft2(
      nf2(
        sp2([
          {
            keys: ["married"],
            emits: [
              { key: "married", value: "Yes" },
              { key: "married", value: "No" }
            ]
          }
        ]),
        J2
      ),
      "nfdiv/validation/OcrValidator.java"
    );
    expect(java).toContain("equalsIgnoreCase");
    expect(java).not.toContain("ALLOWED_VALUES.get(key).contains(value)");
  });
});

describe("anchored patterns in generated Java and the schema", () => {
  it("should emit the same whole-value pattern to the validator and to the SSCS schema when a key has a format", () => {
    const s = sp9([{ keys: ["code"], regex: "[A-Z]{3}" }]);
    expect(ft9(nf9(s, J9), "nfdiv/validation/OcrValidator.java")).toContain('Pattern.compile("^(?:[A-Z]{3})$")');
    const props = (sscs9(s) as { properties: Record<string, { pattern: string }> }).properties;
    expect(props.code?.pattern).toBe("^$|^(?:[A-Z]{3})$");
    expect(new RegExp(props.code?.pattern ?? "").test("ABCD")).toBe(false);
  });
});

describe("Java field names are unique", () => {
  it("should refuse two keys that become the same Java field when the form is generated", () => {
    const s = sp9([{ keys: ["aSoleApplication"] }, { keys: ["soleApplication"] }]);
    expect(() => nf9(s, J9)).toThrow(/both become the Java field "soleApplication"/);
  });
});

describe("class prefixes", () => {
  it("should capitalise the prefix in class names when the form type is lower case", () => {
    const files = nfP(spP([{ keys: ["a"], ccd: ["c"] }]), { basePackage: "uk.gov.example.bulkscan", classPrefix: "d8" });
    expect(files.some((f) => f.path === "nfdiv/transformation/D8FormToCaseTransformer.java")).toBe(true);
  });

  it.each(["Form A", "PIP-1", "1st"])("should refuse the prefix %j when it is not a Java identifier", (prefix) => {
    expect(() => nfP(spP([{ keys: ["a"], ccd: ["c"] }]), { basePackage: "uk.gov.example.bulkscan", classPrefix: prefix })).toThrow(/class prefix/);
  });
});

describe("required-when conditions go through the same resolution as rule conditions", () => {
  const group = {
    id: "1.2",
    keys: ["aJoint", "aSole"],
    group: { kind: "xor", size: 2, options: [{ key: "aJoint" }, { key: "aSole" }] },
    rules: [{ ref: "1", when: { aJoint: { ticked: true } }, set: { type: "joint" }, outcome: "success" }],
    ccd: ["type"]
  };

  it("should write a TODO, not a getter, when the condition names a key the model lacks", () => {
    const s = spR8([{ id: "3.1", keys: ["sig"], mandatory: "conditional", required: { label: "x", when: { ghost: { ticked: true } } } }]);
    const java = ftR8(nfR8(s, JR8), "nfdiv/validation/OcrValidator.java");
    expect(java).not.toContain("getGhost");
    expect(java).toContain("TODO: sig is mandatory under a condition");
    expect(efR8(s, { sig: "" }).validation).toBe("success");
  });

  it("should resolve a sheet id in the condition when a required-when names one, in Java and in the expectation", () => {
    const s = spR8([group, { id: "3.1", keys: ["sig"], mandatory: "conditional", required: { label: "Joint app", when: { "1.2": "joint" } } }]);
    const java = ftR8(nfR8(s, JR8), "nfdiv/validation/OcrValidator.java");
    expect(java).toContain("isEmpty(data.getSig())");
    expect(java).toContain("ticked(data.getJoint()");
    expect(efR8(s, { aJoint: "true", aSole: "false", sig: "" }).validation).toBe("warning");
    expect(efR8(s, { aJoint: "false", aSole: "true", sig: "" }).validation).toBe("success");
  });
});

describe("empty conditions", () => {
  it("should be rejected by the schema when a condition is empty, and never written as an empty if", () => {
    expect(() => fsR8.parse({ keys: ["a"], rules: [{ when: {}, outcome: "warning" }] })).toThrow();
    expect(() => fsR8.parse({ keys: ["a"], rules: [{ whenAny: [], outcome: "warning" }] })).toThrow();
    expect(
      prR8([
        { when: {}, outcome: "warning" },
        { whenAny: [], outcome: "warning" }
      ]).unconditional
    ).toHaveLength(2);
    const s = fssR8.parse({ form: { formType: "T" }, sections: [{ id: "1", title: "", fields: [{ keys: ["a"] }] }] });
    const field = s.sections[0]?.fields[0];
    if (field) {
      field.rules = [
        { ref: "1", when: {}, outcome: "warning" },
        { ref: "2", whenAny: [], outcome: "warning" }
      ];
    }
    const java = ftR8(nfR8(s, JR8), "nfdiv/validation/OcrValidator.java");
    expect(java).not.toContain("if ()");
  });
});

describe("generated validator test and sample reporting", () => {
  it("should not claim the sample has no warnings when the sheet expects one, and report a regex it cannot satisfy", () => {
    const warn = spR8([{ id: "1.1", keys: ["a"], rules: [{ ref: "1", otherwise: true, outcome: "warning" }] }]);
    const test = ftR8(nfR8(warn, JR8), "nfdiv/test/OcrValidatorGeneratedTest.java");
    expect(test).not.toContain("shouldReturnNoWarningsWhenEverySampleValueIsValid");
    expect(test).toContain("shouldStillAcceptTheSampleSubmissionsKeysAndFormats");
    const hard = spR8([{ keys: ["odd"], regex: "^(?=a)b$" }, { keys: ["fine"] }]);
    expect(usR8(hard)).toEqual(["odd"]);
  });
});

describe("maximum length", () => {
  const limited = () => spec([{ id: "1.1", keys: ["code"], maxLength: 3 }]);

  it("should warn about a value over the limit when the validator, the expectation and the SSCS schema all enforce it", () => {
    const s = limited();
    expect(expectedFor(s, { code: "abcd" }).validation).toBe("warning");
    expect(expectedFor(s, { code: "abc" }).validation).toBe("success");
    expect(fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java")).toContain('LENGTH_LIMITS.put("code", 3)');
    expect(JSON.stringify(sscs9(s))).toContain('"maxLength":3');
  });
});

describe("minimum length", () => {
  const minimal = () => spec([{ id: "1.1", keys: ["code"], minLength: 3 }]);

  it("should warn about a value under the minimum when the validator, the expectation and the SSCS schema all enforce it", () => {
    const s = minimal();
    expect(expectedFor(s, { code: "ab" }).validation).toBe("warning");
    expect(expectedFor(s, { code: "abc" }).validation).toBe("success");
    expect(expectedFor(s, { code: "" }).validation).toBe("success");
    expect(fileText(nfdivFiles(s, JAVA), "nfdiv/validation/OcrValidator.java")).toContain('LENGTH_MINIMUMS.put("code", 3)');
    expect(JSON.stringify(sscs9(s))).toContain('"anyOf":[{"maxLength":0},{"minLength":3}]');
  });

  it("should pad a sample to the minimum when the format is open-ended, and report a key no value can satisfy", () => {
    const open = spec([{ id: "1.1", keys: ["ref"], regex: "^[XG].*", minLength: 9 }]);
    expect(validData(open).ref).toMatch(/^[XG].{8,}$/);
    expect(usR8(open)).toEqual([]);
    const fixed = spec([{ id: "1.1", keys: ["ref"], regex: "^[XG]\\d{2}$", minLength: 9 }]);
    expect(usR8(fixed)).toEqual(["ref"]);
  });

  it("should give a valid sample at least the minimum long when the key has a minimum length", () => {
    expect(validData(minimal()).code?.length).toBeGreaterThanOrEqual(3);
  });
});
