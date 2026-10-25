import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundedArray } from "./bounded-array.ts";

const element = z.object({ name: z.string() });

/** Enough elements that one issue each would be unmistakable next to the single issue the cap is meant to give. */
const OVERSIZED = 5000;

describe("boundedArray", () => {
  it("should raise one issue rather than one per element when the array is over the cap", () => {
    const result = boundedArray(element, 10, { message: "at most 10" }).safeParse(Array.from({ length: OVERSIZED }, () => 0));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe("at most 10");
  });

  it("should parse the elements when the array is within the cap", () => {
    expect(boundedArray(element, 10).parse([{ name: "a" }, { name: "b" }])).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("should keep the failing element's index in its issue path when the array is within the cap", () => {
    const result = boundedArray(element, 10).safeParse([{ name: "a" }, { name: 1 }]);

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[1, "name"]]);
  });

  it("should refuse an array below the minimum when one is given", () => {
    expect(boundedArray(element, 10, { min: 1 }).safeParse([]).success).toBe(false);
    expect(boundedArray(element, 10, { min: 1 }).safeParse([{ name: "a" }]).success).toBe(true);
  });

  it("should refuse a value that is not an array", () => {
    expect(boundedArray(element, 10).safeParse("not an array").success).toBe(false);
  });
});
