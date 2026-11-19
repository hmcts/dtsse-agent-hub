import { describe, expect, it } from "vitest";
import { assign, confidenceOf, dice, tokens, words } from "./similarity.ts";

describe("tokens", () => {
  it("should split camelCase keys and merge a party with its number", () => {
    expect([...tokens("soleOrApplicant1TownOrCity")]).toEqual(["sole", "applicant1", "town", "city"]);
    expect([...tokens("the applicant 2 phone no.")]).toEqual(["applicant2", "phone", "number"]);
  });

  it("should fold plurals and possessives and drop bracketed asides", () => {
    expect(tokens("Solicitor’s names (if known)")).toEqual(tokens("solicitor name"));
  });

  it("should keep a word ending in ss as it is", () => {
    expect([...tokens("address")]).toEqual(["address"]);
    expect(words("Phone no.")).toEqual(["phone", "number"]);
  });
});

describe("dice", () => {
  it("should be 1 for equal sets, 0 for disjoint or empty ones", () => {
    expect(dice(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(dice(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(dice(new Set(), new Set(["b"]))).toBe(0);
  });
});

describe("confidenceOf", () => {
  it.each([
    [0.9, "high"],
    [0.6, "medium"],
    [0.59, "low"]
  ])("should rate %s as %s", (score, expected) => {
    expect(confidenceOf(score)).toBe(expected);
  });
});

describe("assign", () => {
  const candidates = [
    { id: "applicant1Email", words: tokens("applicant1Email") },
    { id: "applicant1Phone", words: tokens("applicant1Phone") }
  ];

  it("should give an exclusive candidate to the slot that scores highest and leave the other without", () => {
    const slots = [{ context: tokens("applicant 1 email address") }, { context: tokens("applicant 1 email") }];
    const result = assign(slots, candidates, 0.5, true);
    expect(result.get(1)?.candidate).toBe("applicant1Email");
    expect(result.has(0)).toBe(false);
  });

  it("should let slots share a candidate when not exclusive", () => {
    const slots = [{ context: tokens("applicant 1 email") }, { context: tokens("applicant 1 email") }];
    expect([...assign(slots, candidates, 0.5, false).values()].map((s) => s.candidate)).toEqual(["applicant1Email", "applicant1Email"]);
  });

  it("should require a slot's own words to appear in the candidate when it has them", () => {
    const slot = { context: tokens("applicant 1 phone email"), own: tokens("email") };
    expect(assign([slot], candidates, 0.5, true).get(0)?.candidate).toBe("applicant1Email");
  });
});
