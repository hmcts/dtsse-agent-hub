import { describe, expect, it } from "vitest";
import { MAX_SKILLS } from "../agents/skills.ts";
import { heartbeatBody, registerBody } from "./schemas.ts";

/** Enough skills that one issue each would be unmistakable next to the single issue the cap is meant to give. */
const OVERSIZED = Array.from({ length: 5000 }, () => ({ name: 1 }));

describe("registerBody", () => {
  it("should raise one issue rather than one per skill when the list is over the cap", () => {
    const result = registerBody.safeParse({ session_id: "s", name: "n", skills: OVERSIZED });

    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe(`at most ${MAX_SKILLS} skills`);
  });
});

describe("heartbeatBody", () => {
  it("should raise one issue rather than one per skill when the list is over the cap", () => {
    const result = heartbeatBody.safeParse({ status: "idle", skills: OVERSIZED });

    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe(`at most ${MAX_SKILLS} skills`);
  });
});
