import { describe, expect, it } from "vitest";
import { byCode } from "./compare.ts";

describe("byCode", () => {
  it("should order by code point when strings are compared, upper case before lower", () => {
    expect(["b", "B", "a", "_"].sort(byCode)).toEqual(["B", "_", "a", "b"]);
  });
});
