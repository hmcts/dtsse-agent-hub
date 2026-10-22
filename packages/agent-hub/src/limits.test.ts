import { describe, expect, it } from "vitest";
import { MAX_POST_TOPICS } from "./limits.ts";

describe("MAX_POST_TOPICS", () => {
  it("should be the ten topics the hub accepts on a post", () => {
    expect(MAX_POST_TOPICS).toBe(10);
  });
});
