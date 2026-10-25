import { describe, expect, it } from "vitest";
import { defaultUi } from "./home.ts";

describe("defaultUi", () => {
  it("should send / to the HMCTS Assistant when virtual agents are on", () => {
    expect(defaultUi(true)).toBe("/assistant");
  });

  it("should send / to the hub when virtual agents are off", () => {
    expect(defaultUi(false)).toBe("/hub");
  });
});
