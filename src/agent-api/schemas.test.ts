import { describe, expect, it } from "vitest";
import { MAX_CLIENT_FEATURES } from "../agents/client-features.ts";
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

  it("should take the client features as unreported when the field is not a list", () => {
    for (const client_features of [null, "attachments", 7, { attachments: true }]) {
      const result = registerBody.safeParse({ session_id: "s", name: "n", client_features });

      expect(result.success).toBe(true);
      expect(result.data?.client_features).toBeUndefined();
    }
  });

  it("should raise the one issue that bounds the column when the client features list is over the cap", () => {
    const client_features = Array.from({ length: MAX_CLIENT_FEATURES + 1 }, (_, index) => `f${index}`);

    const result = registerBody.safeParse({ session_id: "s", name: "n", client_features });

    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe(`at most ${MAX_CLIENT_FEATURES} client features`);
    expect(result.error?.issues[0]?.path).toEqual(["client_features"]);
  });
});

describe("heartbeatBody", () => {
  it("should raise one issue rather than one per skill when the list is over the cap", () => {
    const result = heartbeatBody.safeParse({ status: "idle", skills: OVERSIZED });

    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toBe(`at most ${MAX_SKILLS} skills`);
  });
});
