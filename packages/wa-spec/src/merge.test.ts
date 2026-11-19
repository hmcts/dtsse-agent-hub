import { describe, expect, it } from "vitest";
import { majority, mergeSequences } from "./merge.ts";

const ids = (m: Array<{ item: string; caseTypes: string[] }>) => m.map((x) => `${x.item}:${x.caseTypes.join("+")}`);

describe("mergeSequences", () => {
  it("should share items and keep each case type's order when sequences overlap", () => {
    let merged = mergeSequences([], "a", ["x", "y", "z"], (s) => s);
    merged = mergeSequences(merged, "b", ["x", "w", "z"], (s) => s);
    expect(ids(merged)).toEqual(["x:a+b", "y:a", "w:b", "z:a+b"]);
  });

  it("should keep repeated identical items apart when a case type repeats them", () => {
    let merged = mergeSequences([], "a", ["x", "x"], (s) => s);
    merged = mergeSequences(merged, "b", ["x"], (s) => s);
    expect(ids(merged)).toEqual(["x:a+b", "x:a"]);
  });
});

describe("majority", () => {
  it("should return the commonest value and the case types that differ when values disagree", () => {
    const result = majority([
      { caseType: "a", value: "p" },
      { caseType: "b", value: "q" },
      { caseType: "c", value: "q" }
    ]);
    expect(result.base).toBe("q");
    expect(result.differing).toEqual([{ caseType: "a", value: "p" }]);
  });
});
