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

  // **The one assertion that catches any name a merge drops.** This list and the hub's `ClientFeature` union are each
  // a single line that two branches add to at once, and a resolution of such a line keeps one side's name and loses
  // the other's — while still typechecking, because what is left is a shorter array of the same type. A count is the
  // whole-list form of that check: it fails whichever name went, and it fails a name added without one, which is the
  // same mistake in the other direction. The named assertions below are not this check repeated; they are for the
  // two names whose loss is actively *misdiagnosed* to the person rather than merely silent.
  it("should hold every feature this build claims, so a name dropped in a merge fails here", () => {
    expect(CLIENT_FEATURES).toHaveLength(6);
  });

  // The hub refuses to stop an answer on a session that did not claim this, and its UI offers no stop control at
  // all, so dropping the claim would take the feature away silently rather than break anything that says so.
  it("should claim stop, since the supervisor acts on the sessions stream's interrupt", () => {
    expect(CLIENT_FEATURES).toContain("stop");
  });

  // Named, where `attachments`, `files` and `memory` are not, because losing this one is *misdiagnosed* rather than
  // merely silent: the hub refuses a report without `anon_bytes`, and the Size section then tells the person their
  // assistant is running an older version that cannot report its memory. The count above is what catches the loss;
  // this says which loss it was, so whoever reads the failure is not left to work out which name went.
  it("should claim memory-anon, since the hub requires anon_bytes in the memory report", () => {
    expect(CLIENT_FEATURES).toContain("memory-anon");
  });

  // The other of the pair, and the one that proves the hazard is symmetric: `memory-anon` and `lookups` were added by
  // separate branches to the same line, so whichever side a resolution of it takes, the other name goes. Misdiagnosed
  // the same way — the hub answers a lookup from a pod that did not claim it with `unsupported`, and the search tells
  // the person their assistant needs an update it will get on its next restart. It will not: the claim is missing
  // from the published client, so restarting changes nothing.
  it("should claim lookups, since the supervisor answers the sessions stream's lookup frame", () => {
    expect(CLIENT_FEATURES).toContain("lookups");
  });
});
