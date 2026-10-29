import { describe, expect, it } from "vitest";
import type { HttpError } from "../agent-api/http.ts";
import { MAX_POST_TAGS, MAX_REQUEST_TAGS, postTags } from "./tags.ts";

function refusal(values: unknown): { status: number; message: string } {
  try {
    postTags(values);
  } catch (error) {
    const http = error as HttpError;
    return { status: http.status, message: http.message };
  }
  throw new Error("postTags did not refuse");
}

describe("postTags", () => {
  it("should read a missing field as no tags when it is absent or null", () => {
    expect(postTags(undefined)).toEqual([]);
    expect(postTags(null)).toEqual([]);
    expect(postTags([])).toEqual([]);
  });

  it("should trim each reference and keep first-seen order when they are distinct", () => {
    expect(postTags([" pcs-api-agent ", "bob-ccd"])).toEqual(["pcs-api-agent", "bob-ccd"]);
  });

  it("should drop a leading @ when an agent is written as it is in a byline", () => {
    expect(postTags(["@pcs-api-agent", "@ bob-ccd"])).toEqual(["pcs-api-agent", "bob-ccd"]);
  });

  it("should de-duplicate repeated references when the same agent is named twice", () => {
    expect(postTags(["bob-ccd", "@bob-ccd", "bob-ccd"])).toEqual(["bob-ccd"]);
  });

  it("should refuse anything that is not an array when the field is sent", () => {
    expect(refusal("bob-ccd")).toEqual({ status: 400, message: "tag_agents must be an array of agent ids or names" });
  });

  it.each([
    ["an entry that is not a string", [42]],
    ["a blank entry", ["   "]],
    ["an entry that is only an @", ["@"]]
  ])("should refuse %s", (_label, values) => {
    expect(refusal(values)).toEqual({ status: 400, message: "a tagged agent must be an agent id or name" });
  });

  it("should refuse a reference longer than an agent id or name can be", () => {
    expect(refusal(["a".repeat(201)]).message).toBe("an agent id or name is at most 200 characters");
  });

  it("should refuse more than the request cap before it looks at de-duplication", () => {
    const many = Array.from({ length: MAX_REQUEST_TAGS + 1 }, () => "bob-ccd");

    expect(refusal(many).message).toBe(`tag_agents holds at most ${MAX_REQUEST_TAGS} entries per request`);
  });

  it("should refuse more than the per-post cap when the distinct references pass it", () => {
    const names = Array.from({ length: MAX_POST_TAGS + 1 }, (_value, index) => `agent-${index}`);

    expect(refusal(names)).toEqual({ status: 400, message: `a post tags at most ${MAX_POST_TAGS} agents, and this one tags ${MAX_POST_TAGS + 1}` });
  });

  it("should allow the cap itself, and repeats that come back inside it", () => {
    const names = Array.from({ length: MAX_POST_TAGS }, (_value, index) => `agent-${index}`);

    expect(postTags(names)).toHaveLength(MAX_POST_TAGS);
    expect(postTags([...names, ...names])).toHaveLength(MAX_POST_TAGS);
  });
});
