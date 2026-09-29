import { describe, expect, it } from "vitest";
import { checkChannel, MAX_CHANNEL_NAME, MAX_VIEW_TOPICS, parseMatch, viewHref, viewTopics } from "./rules.ts";

const VALID = { name: "PCS database", topics: ["pcs-api", "database"], match: "all", shared: true };

describe("checkChannel", () => {
  it("should accept a named channel of one to ten topics, normalising the topics, when it is valid", () => {
    expect(checkChannel({ ...VALID, topics: [" PCS-API ", "database", "pcs-api"] })).toEqual({
      ok: true,
      channel: { name: "PCS database", topics: ["pcs-api", "database"], match: "all", shared: true }
    });
  });

  it("should accept ten topics when that is the most allowed", () => {
    expect(checkChannel({ ...VALID, topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }).ok).toBe(true);
  });

  it.each([
    ["no topics", [], "between 1 and 10 topics, and this one has 0"],
    ["eleven topics", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"], "this one has 11"],
    ["a topic with a space", ["pcs api"], "is not a topic"],
    ["a topic starting with a hyphen", ["-pcs"], "is not a topic"],
    ["a topic of 65 characters", ["a".repeat(65)], "is not a topic"],
    ["topics that are not a list", "pcs-api", "pick at least one topic"]
  ])("should refuse %s when saving", (_label, topics, error) => {
    const checked = checkChannel({ ...VALID, topics });

    expect(checked.ok).toBe(false);
    expect(checked.ok ? undefined : checked.errors.topics).toContain(error);
  });

  it.each([
    ["an empty name", "  ", "give the channel a name"],
    ["a name that is not text", 42, "give the channel a name"],
    ["a name that is too long", "x".repeat(MAX_CHANNEL_NAME + 1), `at most ${MAX_CHANNEL_NAME}`]
  ])("should refuse %s when saving", (_label, name, error) => {
    const checked = checkChannel({ ...VALID, name });

    expect(checked.ok ? undefined : checked.errors.name).toContain(error);
  });

  it("should report both problems when the name and the topics are wrong", () => {
    expect(checkChannel({ ...VALID, name: "", topics: [] })).toMatchObject({ ok: false, errors: { name: expect.any(String), topics: expect.any(String) } });
  });

  it("should default to any and unshared when those are missing or unrecognised", () => {
    expect(checkChannel({ name: "x", topics: ["a"], match: "most", shared: "yes" })).toEqual({
      ok: true,
      channel: { name: "x", topics: ["a"], match: "any", shared: false }
    });
  });

  it("should read a checked checkbox as shared when the value comes from a form", () => {
    expect(checkChannel({ name: "x", topics: ["a"], match: "any", shared: "on" })).toMatchObject({ channel: { shared: true } });
  });
});

describe("parseMatch", () => {
  it.each([
    ["all", "all"],
    ["any", "any"],
    [undefined, "any"],
    [["all"], "any"]
  ])("should read %j as %s", (value, expected) => {
    expect(parseMatch(value)).toBe(expected);
  });
});

describe("viewTopics", () => {
  it("should split, normalise and de-duplicate topics when they are comma-separated or repeated", () => {
    expect(viewTopics(["PCS-API, database", "pcs-api,,ccd"])).toEqual({ topics: ["pcs-api", "database", "ccd"], invalid: [] });
  });

  it("should report what is not a topic rather than drop it silently", () => {
    expect(viewTopics("pcs-api,not a topic")).toEqual({ topics: ["pcs-api"], invalid: ["not a topic"] });
  });

  it("should give nothing when no topics are asked for", () => {
    expect(viewTopics(undefined)).toEqual({ topics: [], invalid: [] });
  });

  it(`should keep at most ${MAX_VIEW_TOPICS} topics when more are asked for`, () => {
    expect(viewTopics(Array.from({ length: 30 }, (_, index) => `t${index}`).join(",")).topics).toHaveLength(MAX_VIEW_TOPICS);
  });
});

describe("viewHref", () => {
  it("should build a readable shareable link with commas when the view is any", () => {
    expect(viewHref(["pcs-api", "database"], "any")).toBe("/c?topics=pcs-api,database");
  });

  it("should carry the mode when the view is all", () => {
    expect(viewHref(["pcs-api", "database"], "all")).toBe("/c?topics=pcs-api,database&mode=all");
  });
});
