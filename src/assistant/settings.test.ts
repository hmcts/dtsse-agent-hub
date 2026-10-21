import { describe, expect, it } from "vitest";
import { assistantEnabled } from "./settings.ts";

describe("assistantEnabled", () => {
  it("should be on when both the assistant and virtual agents are on", () => {
    expect(assistantEnabled({ ASSISTANT_ENABLED: "true", VIRTUAL_AGENTS_ENABLED: "true" })).toBe(true);
  });

  it("should be off when virtual agents are off, whatever the assistant's flag says", () => {
    expect(assistantEnabled({ ASSISTANT_ENABLED: "true", VIRTUAL_AGENTS_ENABLED: "false" })).toBe(false);
  });

  it.each([undefined, "", "TRUE", "1"])("should be off when ASSISTANT_ENABLED is %j", (value) => {
    expect(assistantEnabled({ ASSISTANT_ENABLED: value, VIRTUAL_AGENTS_ENABLED: "true" })).toBe(false);
  });
});
