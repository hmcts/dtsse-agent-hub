import { describe, expect, it } from "vitest";
import { CLIENT_FEATURES } from "./features.ts";

// Invariants first, and then — deliberately, for the reason given below — a second copy of the list. Adding a
// feature is an entry in `CLIENT_FEATURES`, the code that reads the field, and a name here.
describe("CLIENT_FEATURES", () => {
  it("should name each feature once in the form the hub accepts", () => {
    expect(new Set(CLIENT_FEATURES).size).toBe(CLIENT_FEATURES.length);
    for (const feature of CLIENT_FEATURES) {
      expect(feature, feature).toMatch(/^[a-z0-9][a-z0-9:_-]*$/);
      expect(feature.length, feature).toBeLessThanOrEqual(50);
    }
  });

  // **The count, which is what catches a name going missing whichever one it is.** This list and the hub's
  // `ClientFeature` union are each a single line, and every change that adds a feature edits those same two lines,
  // so two branches doing it conflict and a resolution that takes either side drops the other's name. Nothing else
  // would catch that: a shorter array of the same type still typechecks. A count also fails a name *added* without
  // an assertion below, which the per-name list cannot, and which is how this file came to claim a standard it did
  // not meet.
  it("should hold every feature this build claims, so a name dropped in a merge fails here", () => {
    expect(CLIENT_FEATURES).toHaveLength(7);
  });

  /**
   * **Every name, spelled out, and the duplication is the point.** The count above says a name went; this says which,
   * so whoever reads the failure is not left to work it out. Adding a feature means a line here as well as the entry
   * and the code that reads the field — the one place in this file that is deliberately not an invariant.
   *
   * What each loss costs, because they are not alike. `memory-anon` and `lookups` are *misdiagnosed* to the person
   * rather than merely withheld: without the first, the hub refuses a report with no `anon_bytes` and the Size
   * section says their assistant is an older version that cannot report its memory; without the second, the hub
   * answers a lookup with `unsupported` and the search says their assistant needs an update it will get on its next
   * restart — which it will not, the claim being missing from the published client. `stop`, `attachments`, `files`
   * and `memory` are quieter: the feature is withheld and nothing says so, which is why these two are worth the
   * words and those four are covered by being on the list at all.
   */
  it.each(["attachments", "files", "lookups", "memory", "memory-anon", "model", "stop"])("should claim %s", (feature) => {
    expect(CLIENT_FEATURES).toContain(feature);
  });
});
