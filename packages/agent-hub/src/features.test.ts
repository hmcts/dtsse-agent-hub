import { describe, expect, it } from "vitest";
import { CLIENT_FEATURES } from "./features.ts";

// Invariants rather than the list itself: adding a feature is meant to be one entry here plus the code that reads
// the field, not an entry plus a test to update.
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

  // Named here as well as in the list, unlike most features, because this one is only ever added to the same single
  // line of the same two tables that every other feature is added to: a merge that resolves that line in favour of
  // one side drops whichever name the other side added, and without this the result is a build whose reports the hub
  // refuses while its Size section calls every pod an older version. Nothing else would fail.
  it("should claim memory-anon, since the hub requires anon_bytes in the memory report", () => {
    expect(CLIENT_FEATURES).toContain("memory-anon");
  });
});
