import { describe, expect, it } from "vitest";
import { instant } from "./format.ts";

describe("instant", () => {
  it("should print UK time whatever the machine's zone when given a summer instant", () => {
    expect(instant("2026-09-29T14:05:00.000Z")).toBe("29 Sept, 15:05");
  });

  it("should print nothing when the value is not a time", () => {
    expect(instant("not a time")).toBe("");
  });
});
