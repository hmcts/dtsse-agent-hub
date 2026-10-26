import { describe, expect, it } from "vitest";
import { CLIENT_FEATURES } from "./features.ts";

// Mostly invariants, so that adding a feature is one entry in the list plus the code that reads the field. The
// exceptions are the two names below, and they are named because of how their loss presents rather than to inventory
// the list: `CLIENT_FEATURES` and the `ClientFeature` union it is typed by are each a single line, every feature
// change edits those same two lines, and a merge resolved in favour of either side drops the other side's name with
// nothing to notice — a shorter array of the same type still typechecks.
describe("CLIENT_FEATURES", () => {
  it("should name each feature once in the form the hub accepts", () => {
    expect(new Set(CLIENT_FEATURES).size).toBe(CLIENT_FEATURES.length);
    for (const feature of CLIENT_FEATURES) {
      expect(feature, feature).toMatch(/^[a-z0-9][a-z0-9:_-]*$/);
      expect(feature.length, feature).toBeLessThanOrEqual(50);
    }
  });

  // The hub refuses to stop an answer on a session that did not claim this, and its UI offers no stop control at
  // all, so dropping the claim would take the feature away silently rather than break anything that says so.
  it("should claim stop, since the supervisor acts on the sessions stream's interrupt", () => {
    expect(CLIENT_FEATURES).toContain("stop");
  });

  // Worse than silent: the hub requires `anon_bytes` in the memory report and gates the Size section on this claim,
  // so losing it leaves a build whose reports are refused while the settings call every pod an older version. That
  // reads as a pod problem rather than a missing claim, which is why this one is worth a line of its own.
  it("should claim memory-anon, since the hub requires anon_bytes in the memory report", () => {
    expect(CLIENT_FEATURES).toContain("memory-anon");
  });
});
