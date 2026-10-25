import { describe, expect, it } from "vitest";
import { clientSupports, MAX_CLIENT_FEATURE_NAME, MAX_CLIENT_FEATURES, normaliseClientFeatures, storedClientFeatures } from "./client-features.ts";

describe("normaliseClientFeatures", () => {
  it("should sort and de-duplicate the names when a client reports a list", () => {
    expect(normaliseClientFeatures(["attachments", "voice", "attachments"])).toEqual(["attachments", "voice"]);
  });

  it("should keep a name this hub does not know when a newer client reports one", () => {
    expect(normaliseClientFeatures(["some-later-field"])).toEqual(["some-later-field"]);
  });

  it("should drop an entry that is not a valid name rather than refuse the list, so one bad name costs only itself", () => {
    expect(normaliseClientFeatures(["Attachments", "-leading", "has space", "", 7, null, undefined, {}, ["attachments"], "attachments"])).toEqual([
      "attachments"
    ]);
    expect(normaliseClientFeatures(["a".repeat(MAX_CLIENT_FEATURE_NAME)])).toEqual(["a".repeat(MAX_CLIENT_FEATURE_NAME)]);
    expect(normaliseClientFeatures(["a".repeat(MAX_CLIENT_FEATURE_NAME + 1)])).toEqual([]);
  });
});

describe("storedClientFeatures", () => {
  it("should give null when the column holds no array, which is a client that reported nothing", () => {
    expect(storedClientFeatures(null)).toBeNull();
    expect(storedClientFeatures(undefined)).toBeNull();
    expect(storedClientFeatures("attachments")).toBeNull();
    expect(storedClientFeatures({ attachments: true })).toBeNull();
  });

  it("should give an empty list when a current client reported no features, which is not the same as reporting nothing", () => {
    expect(storedClientFeatures([])).toEqual([]);
  });

  it("should narrow the stored array when the column holds one", () => {
    expect(storedClientFeatures(["voice", "attachments", 3])).toEqual(["attachments", "voice"]);
  });

  it("should read no further than the cap when the column somehow holds more", () => {
    const stored = [...Array(MAX_CLIENT_FEATURES + 10).keys()].map((index) => `f${String(index).padStart(3, "0")}`);

    expect(storedClientFeatures(stored)).toHaveLength(MAX_CLIENT_FEATURES);
  });
});

describe("clientSupports", () => {
  it("should be true only for a feature the stored list names", () => {
    expect(clientSupports(["attachments"], "attachments")).toBe(true);
    expect(clientSupports(["voice"], "attachments")).toBe(false);
    expect(clientSupports([], "attachments")).toBe(false);
  });

  it("should be false for a client that reported nothing, so an old client needs no case of its own", () => {
    expect(clientSupports(null, "attachments")).toBe(false);
    expect(clientSupports(undefined, "attachments")).toBe(false);
    expect(clientSupports("attachments", "attachments")).toBe(false);
  });
});
