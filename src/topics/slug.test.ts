import { describe, expect, it } from "vitest";
import { InvalidTopics, normaliseSlug, normaliseSlugs, postTopics } from "./slug.ts";

describe("normaliseSlug", () => {
  it.each([
    ["pcs-api", "pcs-api"],
    ["PCS-API", "pcs-api"],
    ["  database ", "database"],
    ["hdpi-1234", "hdpi-1234"],
    ["0day", "0day"],
    ["a", "a"],
    ["a".repeat(64), "a".repeat(64)]
  ])("should accept %j as %j", (input, expected) => {
    expect(normaliseSlug(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a leading hyphen", "-api"],
    ["a space inside", "pcs api"],
    ["an underscore", "pcs_api"],
    ["a hash", "#pcs"],
    ["a dot", "pcs.api"],
    ["a slash", "pcs/api"],
    ["a non-ASCII letter", "café"],
    ["65 characters", "a".repeat(65)]
  ])("should refuse %s rather than rewrite it", (_label, input) => {
    expect(() => normaliseSlug(input)).toThrow(InvalidTopics);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { slug: "pcs" }]
  ])("should refuse %s when a topic is not a string", (_label, input) => {
    expect(() => normaliseSlug(input)).toThrow(InvalidTopics);
  });
});

describe("normaliseSlugs", () => {
  it("should drop duplicates that only differ in case, keeping first-seen order", () => {
    expect(normaliseSlugs(["Database", "pcs-api", "database"])).toEqual(["database", "pcs-api"]);
  });

  it("should accept an empty list when no count is required", () => {
    expect(normaliseSlugs([])).toEqual([]);
  });

  it("should refuse a value that is not an array", () => {
    expect(() => normaliseSlugs("pcs-api")).toThrow(InvalidTopics);
  });
});

describe("postTopics", () => {
  it("should accept one topic", () => {
    expect(postTopics(["pcs-api"])).toEqual(["pcs-api"]);
  });

  it("should accept five topics", () => {
    expect(postTopics(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("should refuse a post with no topics", () => {
    expect(() => postTopics([])).toThrow(/between 1 and 5/);
  });

  it("should refuse a post with six distinct topics", () => {
    expect(() => postTopics(["a", "b", "c", "d", "e", "f"])).toThrow(/has 6/);
  });

  it("should count topics after duplicates are dropped when six entries name five topics", () => {
    expect(postTopics(["a", "b", "c", "d", "e", "A"])).toHaveLength(5);
  });
});
