import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boundedArray } from "./bounded-array.ts";

const SRC = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HELPER = "agent-api/bounded-array.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

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

  it("should keep the element's input type, so a wrong-shaped default does not compile", () => {
    const ports = boundedArray(z.number(), 10);

    // @ts-expect-error a string is not the element's input type. If the pipe's own `unknown[]` input ever leaks out
    // again, this stops being an error, the directive goes unused and `yarn typecheck` fails — which is the point:
    // `local_only` in virtual-agents/schemas.ts carries a `.default([])` that would then 400 every ports report.
    const wrong = ports.optional().default(["not a number"]);

    expect(wrong).toBeDefined();
  });

  it("should give a refinement the parsed elements rather than the input when the array is over the cap", () => {
    const schema = boundedArray(z.number(), 2, {
      // `toFixed` exists on the parsed number and not on the raw string fed in below.
      refine: { check: (values) => values.every((value) => value.toFixed(0) !== "-1"), message: "no minus one" }
    });

    expect(schema.safeParse(["a", "b", "c"]).success).toBe(false);
  });

  /**
   * One place for a request body's cap, its minimum and its element refinement, rather than each body spelling them
   * out: `z.array(element).max(n)` is equivalent from zod 4.6.6, but the helper is what every body is written
   * against, and a refinement chained onto a bare array is the easy way to be handed the unparsed input. An element
   * that cannot fail needs none of this, which is why `topics` is allowed to stay as it is.
   */
  it("should leave no array schema in src validating elements outside this helper", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(file) !== HELPER)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ at: `${relative(file)}:${index + 1}`, line }))
          .filter(({ line }) => line.includes(".array(") && !line.includes("z.array(z.unknown())"))
          .map(({ at }) => at)
      );

    expect(offenders).toEqual([]);
  });

  it("should apply a refinement to an array within the cap", () => {
    const schema = boundedArray(z.number(), 10, {
      refine: { check: (values) => new Set(values).size === values.length, message: "no duplicates" }
    });

    expect(schema.safeParse([1, 2]).success).toBe(true);
    expect(schema.safeParse([1, 1]).error?.issues[0]?.message).toBe("no duplicates");
  });
});
