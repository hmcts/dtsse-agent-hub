import { describe, expect, it } from "vitest";
import { hasPod } from "./pods.ts";

describe("hasPod", () => {
  it("should answer yes, and narrow the id to a string, when the conversation names a virtual agent", () => {
    const conversation = { id: "c1", virtualAgentId: "9ff4bd3e-6f2c-4f65-bd4f-1f0ba4b8a0f1" as string | null };

    expect(hasPod(conversation)).toBe(true);
    if (hasPod(conversation)) {
      // The point of the guard: `virtualAgentId` is a `string` here, with no assertion beside the check.
      expect(conversation.virtualAgentId.length).toBeGreaterThan(0);
    }
  });

  it("should answer no when the conversation names no virtual agent, which is a local session", () => {
    expect(hasPod({ id: "c2", virtualAgentId: null })).toBe(false);
  });
});
