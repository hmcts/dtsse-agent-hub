import { describe, expect, it } from "vitest";
import { partitionRules } from "./codegen/model.ts";
import {
  parseLogic,
  parseNeverExceeds,
  parseOutcomes,
  parseLogic as pl7,
  parseLogic as pl9,
  parseLogic as pl11,
  renderCasePath,
  renderLogic,
  renderLogic as rl11
} from "./logic.ts";
import type { Rule } from "./schema.ts";

const CTX = {
  keys: ["applicationForDivorce", "applicationForDissolution", "name"],
  ccd: ["divorceOrDissolution", "applicant1Name"],
  knowsId: (id: string) => id === "1.2"
};

describe("parseLogic", () => {
  it("should read an ELSE IF chain into rules with the outcome of each branch when the logic has one", () => {
    const result = parseLogic(
      "1) If applicationForDivorce = true, divorceOrDissolution = divorce\n\nELSE IF\n\n2) If applicationForDissolution = true, divorceOrDissolution = dissolution\n\nELSE\n\n3) divorceOrDissolution = divorce (WITH WARNING) ↓\n\nNote: As per CCD limitations",
      "1) = success\n\n2) = success\n\n3) = warning\n\nRecord cannot go into exception based on this attribute",
      CTX
    );
    expect(result).toMatchObject({
      parsed: true,
      neverExceeds: "warning",
      rules: [
        { ref: "1", when: { applicationForDivorce: true }, set: { divorceOrDissolution: "divorce" }, outcome: "success" },
        { ref: "2", when: { applicationForDissolution: true }, set: { divorceOrDissolution: "dissolution" }, outcome: "success" },
        { ref: "3", otherwise: true, set: { divorceOrDissolution: "divorce" }, outcome: "warning" }
      ]
    });
  });

  it("should read AND conditions and != as a negated operand when a branch uses them", () => {
    const result = parseLogic("1) If applicationForDivorce = true AND applicationForDissolution != true, divorceOrDissolution = divorce", "1) Success", CTX);
    expect(result).toMatchObject({ parsed: true, rules: [{ when: { applicationForDivorce: true, applicationForDissolution: { not: true } } }] });
  });

  it("should read a pass-through between a key and a CCD id when it is written in either direction", () => {
    expect(parseLogic("divorceOrDissolution = applicationForDivorce (just pass it through)", "Success", CTX)).toMatchObject({
      parsed: true,
      rules: [{ set: { divorceOrDissolution: { from: "applicationForDivorce" } } }]
    });
    expect(parseLogic("applicationForDivorce = divorceOrDissolution", "", CTX)).toMatchObject({
      parsed: true,
      rules: [{ set: { divorceOrDissolution: { from: "applicationForDivorce" } } }]
    });
  });

  it("should refuse a pass-through when it links two keys, naming the row's problem", () => {
    const result = parseLogic("applicant1Name = somethingElse (just pass it through)", "", CTX);
    expect(result).toMatchObject({ parsed: false });
  });

  it("should read 'Raise warning' as a warning on the branch and 'Always success' as a catch-all when they are written", () => {
    expect(
      parseLogic("1) If name != null\napplicant1Name = name\n\nELSE (i.e it's empty)\n\n2) Raise warning", "1) = success\n\n2) = warning", CTX)
    ).toMatchObject({
      parsed: true,
      rules: [
        { ref: "1", when: { name: { not: null } }, set: { applicant1Name: { from: "name" } } },
        { ref: "2", otherwise: true, outcome: "warning" }
      ]
    });
    expect(parseLogic("Always success", "Always success", CTX)).toMatchObject({ parsed: true, rules: [{ otherwise: true, outcome: "success" }] });
  });

  it("should give an unlabelled ELSE the case path label no other branch claims and write it back when the case path is rendered", () => {
    const logic = "1) If name = a, applicant1Name = a\n\nELSE IF\n\n2) If name = b, applicant1Name = b\n\nELSE\n\napplicant1Name = c";
    const casePath = "1) = success\n\n2) = success\n\n3) = warning";
    const { rules } = parseLogic(logic, casePath, CTX) as { rules: Rule[] };
    expect(rules[2]).toMatchObject({ otherwise: true, ref: "3", outcome: "warning" });
    expect(renderLogic(rules)).toContain("ELSE\n\n3) applicant1Name = c");
    expect(renderCasePath(rules, undefined)).toBe(casePath);
  });

  it("should keep the case path label of an 'Always success' branch when the case path numbers it", () => {
    const { rules } = parseLogic("Always success", "1) Success", CTX) as { rules: Rule[] };
    expect(rules).toEqual([{ otherwise: true, outcome: "success", ref: "1" }]);
    expect(renderCasePath(rules, undefined)).toBe("1) = success");
  });

  it("should accept a field id such as 1.2 when it is the subject of a condition", () => {
    const result = parseLogic("1) If 1.2 = jointApplication, success\n\nELSE:\n\n2) warning", "1) Success\n\n2) Warning", CTX);
    expect(result).toMatchObject({
      parsed: true,
      rules: [
        { when: { "1.2": "jointApplication" }, outcome: "success" },
        { otherwise: true, outcome: "warning" }
      ]
    });
  });

  it("should report why the logic is not parsed when it is prose it cannot read", () => {
    expect(parseLogic("Some free text with no branches", "", CTX)).toMatchObject({ parsed: false });
    expect(parseLogic("", "", CTX)).toEqual({ parsed: false, reason: "no logic", neverExceeds: undefined });
  });

  it("should not parse a branch when its case path entry is missing", () => {
    const result = parseLogic("1) If name = x, applicant1Name = y\n\nELSE IF\n\n2) If name = z, applicant1Name = w", "1) = success", CTX);
    expect(result).toMatchObject({ parsed: false, reason: "no case path for branch 2" });
  });
});

describe("case path", () => {
  it("should read indexed outcomes when the sheet spells them in any of its ways", () => {
    expect([...parseOutcomes("1a = Warning\n\n1b) = success\n\n2 Warning\n3) Success")]).toEqual([
      ["1a", "warning"],
      ["1b", "success"],
      ["2", "warning"],
      ["3", "success"]
    ]);
  });

  it("should read how far a record can go when the sheet says so", () => {
    expect(parseNeverExceeds("Success\n\nRecord cannot go into warning or exception based on this attribute")).toBe("success");
    expect(parseNeverExceeds("1) = success\n\nRecord cannot go into exception based on this attribute")).toBe("warning");
    expect(parseNeverExceeds("1) = success")).toBeUndefined();
  });
});

describe("renderLogic", () => {
  it("should write rules back in the sheet's phrasing when rendered, so that parsing the result gives the same rules", () => {
    const parsed = parseLogic(
      "1) If applicationForDivorce = true, divorceOrDissolution = divorce\n\nELSE IF\n\n2) If applicationForDissolution != true, divorceOrDissolution = null\n\nELSE\n\n3) divorceOrDissolution = divorce",
      "1) = success\n\n2) = warning\n\n3) = warning",
      CTX
    );
    if (!parsed.parsed) {
      throw new Error(parsed.reason);
    }
    const text = renderLogic(parsed.rules);
    expect(text).toContain("ELSE IF");
    expect(parseLogic(text, renderCasePath(parsed.rules, undefined), CTX)).toMatchObject({ parsed: true, rules: parsed.rules });
  });

  it("should write a pass-through and an unconditional outcome in their short forms when rendered", () => {
    expect(renderLogic([{ set: { applicant1Name: { from: "name" } }, note: "(just pass it through)" }])).toBe("applicant1Name = name (just pass it through)");
    expect(renderLogic([{ otherwise: true, outcome: "success" }])).toBe("Always success");
  });

  it("should write the case path with its trailing limit when the spec has one", () => {
    expect(
      renderCasePath(
        [
          { ref: "1", outcome: "success" },
          { ref: "2", outcome: "warning" }
        ],
        "success"
      )
    ).toBe("1) = success\n\n2) = warning\n\nRecord cannot go into warning or exception based on this attribute");
    expect(renderCasePath([], undefined)).toBe("");
  });
});

describe("logic", () => {
  it("should read 'ccdA = yes, ccdB = no' as two assignments when no condition precedes it, not a condition", () => {
    const result = parseLogic("1) ccdA = yes, ccdB = no", "1) = success", { keys: ["a"], ccd: ["ccdA", "ccdB"] });
    expect(result).toMatchObject({ parsed: true, rules: [{ ref: "1", set: { ccdA: "yes", ccdB: "no" } }] });
    expect(result.parsed && result.rules[0]?.when).toBeUndefined();
  });

  it("should read keys with underscores when they appear in conditions", () => {
    const result = parseLogic("1) If person1_first_name != null, success", "1) = success", { keys: ["person1_first_name"], ccd: [] });
    expect(result).toMatchObject({ parsed: true, rules: [{ when: { person1_first_name: { not: null } } }] });
  });
});

describe("logic with other rows and alternatives", () => {
  const ctx = { keys: ["a", "b", "c"], ccd: ["x"], knowsId: (id: string) => id === "2.4", allKeys: ["other"] };

  it("should read OR as alternatives and test keys of other rows when their case differs", () => {
    const result = parseLogic("1) If a = null OR Other = yes, x = no", "1) = warning", ctx);
    expect(result).toMatchObject({ parsed: true, fragments: 0, rules: [{ whenAny: [{ a: null }, { other: "yes" }], set: { x: "no" }, outcome: "warning" }] });
  });

  it("should test a CCD id when the row writes it, marking it as such", () => {
    expect(parseLogic("1) If x = true, warning", "1) = warning", ctx)).toMatchObject({ rules: [{ when: { "ccd:x": true } }] });
  });

  it("should keep English as an action and count it as a fragment when it cannot be read", () => {
    const result = parseLogic(
      "1) If a = null, pass through what is not null, WARNING\n\nELSE IF\n\n2) All populated, success",
      "1) = warning\n\n2) = success",
      ctx
    );
    expect(result).toMatchObject({
      parsed: true,
      fragments: 1,
      rules: [{ when: { a: null }, note: "Note: pass through what is not null, WARNING" }, { action: "All populated, success" }]
    });
  });

  it("should read branches as independent when no ELSE sits between them, and 'case path = x' as an outcome", () => {
    const result = parseLogic(
      "1a) IF 2.4 = YES and a = null, case path = warning\n\n1b) IF 2.4 = NO, case path = success",
      "1a = Warning\n\n1b = success",
      ctx
    );
    expect(result).toMatchObject({
      parsed: true,
      rules: [
        { ref: "1a", outcome: "warning" },
        { ref: "1b", independent: true }
      ]
    });
    if (result.parsed) {
      expect(renderLogic(result.rules)).toContain("--------\n\n1b) If");
    }
  });

  it("should keep a preamble when text precedes the branches, and treat a lone mapping description as documentation", () => {
    expect(parseLogic("Map multiple fields\n\n----\n\n1) If a = null, warning", "1) = warning", ctx)).toMatchObject({
      preamble: "Map multiple fields\n\n----"
    });
    expect(parseLogic("Map multiple to fields from the source", "", ctx)).toMatchObject({
      parsed: true,
      rules: [],
      preamble: "Map multiple to fields from the source"
    });
  });

  it("should read its own rendering back to the same rules when a branch keeps English after its condition", () => {
    const ctx = {
      keys: ["prayerMarriageDissolved", "prayerCivilPartnershipDissolved"],
      ccd: ["applicant1PrayerHasBeenGiven"],
      knowsId: (id: string) => id === "1.1"
    };
    const casePath = "1) Success\n\n2) Success\n\n3) Warning";
    const first = parseLogic(
      "1) If 1.1 = divorce and prayerMarriageDissolved = true,\napplicant1PrayerHasBeenGiven = yes\n\nELSE IF\n\n2) 1.1  = dissolution prayerMarriageDissolved = prayerCivilPartnershipDissolved = true,\napplicant1PrayerHasBeenGiven = yes\n\nELSE \n\n3) Warning",
      casePath,
      ctx
    );
    if (!first.parsed) {
      throw new Error(first.reason);
    }
    expect(first.rules[1]).toMatchObject({ when: { "1.1": "dissolution" }, action: expect.any(String) });
    expect(parseLogic(renderLogic(first.rules), casePath, ctx)).toMatchObject({ parsed: true, rules: first.rules });
  });

  it("should not parse a branch when it tests a sheet id no row has", () => {
    expect(parseLogic("1) If 9.9 = yes, x = no", "1) = success", ctx)).toMatchObject({ rules: [{ action: expect.any(String) }], fragments: 1 });
  });

  it("should write the trailer and a note back when the row has them", () => {
    expect(renderCasePath([], "success")).toBe("Record cannot go into warning or exception based on this attribute");
    expect(renderLogic([{ ref: "1", otherwise: true, set: { x: "y" }, note: "(WITH WARNING)" }])).toBe("ELSE\n\n1) x = y (WITH WARNING)");
  });
});

describe("branch boundaries", () => {
  const ctx = { keys: ["a", "b", "d"], ccd: ["c"] };

  it("should read an ELSE IF branch as the chain's final branch when it has no condition, and write it back as ELSE", () => {
    const result = parseLogic("1) If a = x, c = 1\n\nELSE IF\n\n2) c = 2", "1) = success\n\n2) = success", ctx);
    if (!result.parsed) {
      throw new Error(result.reason);
    }
    expect(result.rules[1]).toMatchObject({ otherwise: true, set: { c: "2" } });
    expect(partitionRules(result.rules).chains).toHaveLength(1);
    expect(partitionRules(result.rules).unconditional).toEqual([]);
    const text = renderLogic(result.rules);
    expect(text).toContain("ELSE\n\n2) c = 2");
    expect(text).not.toContain("--------");
  });

  it("should start a new chain when a dashed separator appears, and write the separator back", () => {
    const result = parseLogic(
      "1) If a = x, c = 1\n\nELSE IF\n\n2) If a = y, c = 2\n\n--------\n\n3) If b = z, c = 3",
      "1) = success\n\n2) = success\n\n3) = success",
      ctx
    );
    if (!result.parsed) {
      throw new Error(result.reason);
    }
    expect(result.rules[2]).toMatchObject({ independent: true });
    expect(partitionRules(result.rules).chains.map((c) => c.length)).toEqual([2, 1]);
    expect(renderLogic(result.rules)).toContain("--------");
  });
});

describe("pass-through with the same name on both sides", () => {
  it('should accept "x = x" when the name is both an OCR key and a CCD field', () => {
    const result = pl9("applicantName = applicantName (just pass it through)", "Success", { keys: ["applicantName"], ccd: ["applicantName"] });
    expect(result).toMatchObject({ parsed: true, rules: [{ set: { applicantName: { from: "applicantName" } } }] });
  });
});

describe("conditions are all or nothing", () => {
  const ctx = { keys: ["a", "c"], ccd: ["d"] };

  it("should read 'is not blank' and 'is blank' as atoms when they follow AND and OR", () => {
    const and = pl7("1) If a = yes AND c is not blank, d = yes", "1) = success", ctx);
    expect(and).toMatchObject({ parsed: true, fragments: 0, rules: [{ when: { a: "yes", c: { not: null } }, set: { d: "yes" } }] });
    const or = pl7("1) If a = yes OR c is blank, d = yes", "1) = success", ctx);
    expect(or).toMatchObject({ parsed: true, fragments: 0, rules: [{ whenAny: [{ a: "yes" }, { c: null }] }] });
  });

  it("should not drop a condition when it cannot be read after AND: the branch becomes English", () => {
    const result = pl7("1) If a = yes AND see the form, d = yes", "1) = success", ctx);
    expect(result).toMatchObject({ parsed: true, fragments: 1 });
    if (result.parsed) {
      expect(result.rules[0]?.when).toBeUndefined();
      expect(result.rules[0]?.action).toContain("see the form");
    }
  });
});

describe("constant assignments", () => {
  it("should read 'd = Divorce' as a literal assignment when d is an alias, and still reject a copy between the wrong rows' keys", () => {
    expect(pl7("d = Divorce", "Success", { keys: ["a"], ccd: ["d"], allKeys: ["a", "other"] })).toMatchObject({
      parsed: true,
      rules: [{ set: { d: "Divorce" } }]
    });
    expect(pl7("d = other (just pass it through)", "", { keys: ["a"], ccd: ["d"], allKeys: ["a", "other"] })).toMatchObject({
      parsed: false,
      reason: expect.stringContaining("sheet error")
    });
    expect(pl7("otherCcd = a", "", { keys: ["a"], ccd: ["d"], allKeys: ["a", "otherCcd"] })).toMatchObject({ parsed: false });
  });
});

describe("sheet phrases the parser now codes", () => {
  it("should read '(field above)' and '(this field)' and a comma between two tests when they name keys", () => {
    const ctx = { keys: ["access"], ccd: [], aboveKeys: ["email"], allKeys: ["access", "email"] };
    const result = pl11(
      "1) If (email address field above) = null, (this field) = null (SUCCESS)\n\nELSE IF\n\n2) (email address field above) = !null,  (this field) = null",
      "1) Success\n\n2) Warning",
      ctx
    );
    expect(result).toMatchObject({
      parsed: true,
      fragments: 0,
      rules: [
        { when: { email: null, access: null }, outcome: "success" },
        { when: { email: { not: null }, access: null }, outcome: "warning" }
      ]
    });
    if (result.parsed) {
      expect(rl11(result.rules)).toContain("email != null AND access = null");
    }
  });

  it("should read 'the field is empty/completed' and 'validation status = x' when a condition uses them", () => {
    const ctx = { keys: ["sig"], ccd: [] };
    const result = pl11("1) If field is empty validation status = warning\n\n2) If the field is completed status = success", "1) Warning\n2) Success", ctx);
    expect(result).toMatchObject({
      parsed: true,
      fragments: 0,
      rules: [
        { when: { sig: null }, outcome: "warning" },
        { when: { sig: { not: null } }, outcome: "success" }
      ]
    });
  });

  it("should read letters when the preamble defines them, in conditions and in 'a = b'", () => {
    const ctx = { keys: ["correct", "reason"], ccd: ["isCorrect", "details"], allKeys: [] };
    const text =
      "correct (a) = isCorrect (b)\n\nreason (c) = details (d)\n\n------\n\n1) If a = null, warning\n\nELSE IF\n\n2) a = no , AND c = null, warning\n\nELSE IF\n\n3) a != null, a = b, success";
    const result = pl11(text, "1) Warning\n2) Warning\n3) Success", ctx);
    expect(result).toMatchObject({
      parsed: true,
      fragments: 0,
      rules: [
        { when: { correct: null } },
        { when: { correct: "no", reason: null } },
        { when: { correct: { not: null } }, set: { isCorrect: { from: "correct" } }, outcome: "success" }
      ]
    });
  });

  it("should distribute a test over a list when it follows 'and:', and read an assignment followed by AND and alternatives", () => {
    const ctx = {
      keys: ["number", "summary"],
      ccd: ["details", "proceedings"],
      knowsId: (id: string) => id === "7.1",
      allKeys: ["number", "summary", "cases"]
    };
    const listed = pl11("1) If 7.1 = yes, and:\n\nnumber = null\n\nor\n\nsummary = null\n\nWarning", "1) Warning", ctx);
    expect(listed).toMatchObject({
      parsed: true,
      rules: [
        {
          whenAny: [
            { "7.1": "yes", number: null },
            { "7.1": "yes", summary: null }
          ],
          outcome: "warning"
        }
      ]
    });
    const crossed = pl11("1) If cases = Yes, proceedings = Yes AND number = a OR number = b OR OR number = c Success", "1) Success", ctx);
    expect(crossed).toMatchObject({
      parsed: true,
      fragments: 0,
      rules: [
        {
          whenAny: [
            { cases: "Yes", number: "a" },
            { cases: "Yes", number: "b" },
            { cases: "Yes", number: "c" }
          ],
          set: { proceedings: "Yes" }
        }
      ]
    });
  });

  it("should read 'ccdField = success' as the branch's case path when the case path column says it", () => {
    const result = pl11("1) If a = no, details = success", "1) Success", { keys: ["a"], ccd: ["details"] });
    expect(result).toMatchObject({ parsed: true, fragments: 0, rules: [{ when: { a: "no" }, outcome: "success" }] });
  });
});

describe("branches written on the ELSE IF line", () => {
  it("should keep the branch after ELSE IF on the same line when the chain is read", () => {
    const result = parseLogic("1) If name = x, applicant1Name = y\n\nELSE IF 2) If name = z, applicant1Name = w", "1) = success\n\n2) = warning", CTX);
    expect(result).toMatchObject({ parsed: true, rules: [{ ref: "1" }, { ref: "2", when: { name: "z" } }] });
  });

  it("should count a numbered branch the parser could not place as a fragment when it is missing from the rules", () => {
    const result = parseLogic("1) If name = x, applicant1Name = y\n\n2)", "1) = success\n\n2) = success", CTX);
    if (!result.parsed) {
      throw new Error(result.reason);
    }
    const refs = result.rules.map((r) => r.ref);
    expect(refs.includes("2") || result.fragments > 0).toBe(true);
  });
});

describe("is / is not blank, empty, completed, populated, null", () => {
  const cases: Array<[string, "null" | "populated"]> = [];
  for (const word of ["blank", "empty", "null"]) {
    cases.push([`is ${word}`, "null"], [`is not ${word}`, "populated"]);
  }
  for (const word of ["completed", "populated"]) {
    cases.push([`is ${word}`, "populated"], [`is not ${word}`, "null"]);
  }
  it.each(cases)("should read '%s' as %s when it is the condition of a branch", (phrase, expected) => {
    const result = parseLogic(`1) If name ${phrase}, applicant1Name = y`, "1) = success", CTX);
    const operand = expected === "null" ? null : { not: null };
    expect(result).toMatchObject({ parsed: true, rules: [{ when: { name: operand } }] });
  });
});

const PASS_THROUGH_CTX = { keys: ["marriageIsCorrect", "name"], ccd: ["marriageIsCorrect", "applicant1Name"] };

describe("logic rendering of pass-through rules", () => {
  it.each(["marriageIsCorrect = Yes", "applicant1Name = null", "marriageIsCorrect = true", "applicant1Name = name"])(
    "should render %s back unchanged when a pass-through or constant is written",
    (text) => {
      const first = parseLogic(text, "", PASS_THROUGH_CTX);
      if (!first.parsed) {
        throw new Error(first.reason);
      }
      const rendered = renderLogic(first.rules, first.preamble);
      expect(rendered.replace(/\s+/g, " ").toLowerCase()).toBe(text.toLowerCase());
      const second = parseLogic(rendered, "", PASS_THROUGH_CTX);
      expect(second).toMatchObject({ parsed: true, rules: first.rules });
    }
  );
});
