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

  /**
   * **Every name, spelled out, and the duplication is the point.**
   *
   * `CLIENT_FEATURES` and the `ClientFeature` union it is typed by are each a single line, and every change that adds
   * a feature edits those same two lines. Two branches doing that conflict, and a resolution that takes either side
   * drops the other side's name — which nothing else catches: a shorter array of the same type still typechecks, and
   * the only symptom is the hub silently withholding a field, or gating a pod out of something it can do. This list
   * is a second copy that has to be edited deliberately, so a resolution that loses a name fails here.
   *
   * It is the one place in this file that is not an invariant, for that reason. Adding a feature means a line here as
   * well as the entry and the code that reads the field.
   */
  it.each(["attachments", "files", "memory", "memory-anon", "stop"])("should claim %s", (feature) => {
    expect(CLIENT_FEATURES).toContain(feature);
  });
});
