import { describe, expect, it } from "vitest";
import { type DraftKind, draftKey, KINDS } from "./useDraft.ts";

const VIEWER = "11111111-1111-1111-1111-111111111111";

describe("draftKey", () => {
  it("should namespace the key by kind, viewer and subject so no two boxes share a draft", () => {
    expect(draftKey("direct-draft", VIEWER, "agent-1")).toBe(`agent-hub:direct-draft:${VIEWER}:agent-1`);
    expect(draftKey("assistant-draft", VIEWER, "agent-1")).toBe(`agent-hub:assistant-draft:${VIEWER}:agent-1`);
  });

  it("should key the same subject differently for each kind", () => {
    expect(draftKey("direct-draft", VIEWER, "same")).not.toBe(draftKey("assistant-draft", VIEWER, "same"));
  });
});

describe("DraftKind", () => {
  /**
   * `forgetOtherViewers` finds the drafts to clear by walking `KINDS`, so a kind the type knows about and the array
   * does not is a draft it walks straight past — one person's unsent text left in the next person's tab. Deriving the
   * type from the array is what makes that impossible, and this is the check that the derivation is still there: both
   * directions hold by construction while it is, and spelling the union out again breaks whichever one the new union
   * disagrees with.
   */
  it("should be exactly the kinds KINDS lists, so every kind is one forgetOtherViewers clears", () => {
    const sameBothWays: (DraftKind extends (typeof KINDS)[number] ? true : never) & ((typeof KINDS)[number] extends DraftKind ? true : never) = true;

    expect(sameBothWays).toBe(true);
    expect([...KINDS]).toEqual(["direct-draft", "assistant-draft"]);
  });

  it("should reject a kind the array does not list", () => {
    // @ts-expect-error a kind no box keeps is not a DraftKind. If this stops being an error the directive goes unused
    // and `yarn typecheck` fails, which is the point: `kindPrefix` would be building keys nothing ever reads back.
    const unlisted: DraftKind = "topic-draft";

    expect(unlisted).toBe("topic-draft");
  });
});
