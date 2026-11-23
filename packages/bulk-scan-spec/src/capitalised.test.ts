import { describe, expect, it } from "vitest";
import { capitalised } from "./capitalised.ts";

describe("capitalised", () => {
  it("should raise only the first letter when the text has several words", () => {
    expect(capitalised("branch 1")).toBe("Branch 1");
    expect(capitalised("")).toBe("");
  });
});
