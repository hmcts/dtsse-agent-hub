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
  // refuses while its Size section calls every pod an older version. Nothing else would fail — dropping a name
  // leaves a shorter array of the same type, so it still typechecks.
  //
  // **Every name added in another branch wants a line here too**, and the hazard is symmetric: a resolution taking
  // one side drops the other's just as silently.
  it("should claim memory-anon, since the hub requires anon_bytes in the memory report", () => {
    expect(CLIENT_FEATURES).toContain("memory-anon");
  });

  // The other half of that pair, and the reason both are needed: `memory-anon` and `lookups` were added by separate
  // branches to the same line, so whichever side a resolution of it takes, the other name goes. The failure is the
  // same shape as the one above — the hub answers a lookup from a pod that did not claim it with `unsupported` and
  // sends it no frame, and the search tells the person their assistant needs an update it will get on its next
  // restart. It will not: the claim is missing from the published client, so restarting changes nothing.
  it("should claim lookups, since the supervisor answers the sessions stream's lookup frame", () => {
    expect(CLIENT_FEATURES).toContain("lookups");
  });
});
