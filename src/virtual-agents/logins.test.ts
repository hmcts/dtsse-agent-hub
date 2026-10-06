import { describe, expect, it } from "vitest";
import { isSignInKind } from "./logins.ts";

describe("isSignInKind", () => {
  it.each([
    ["github", true],
    ["azure", true],
    ["atlassian", true],
    ["claude", false],
    ["bedrock", false],
    ["jenkins", false],
    ["claude_md", false],
    ["git_identity", false],
    ["Atlassian", false],
    ["", false]
  ])("should answer %j → %s when the owner asks to sign in again", (kind, expected) => {
    expect(isSignInKind(kind)).toBe(expected);
  });
});
