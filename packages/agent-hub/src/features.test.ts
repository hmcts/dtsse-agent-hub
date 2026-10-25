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
});
