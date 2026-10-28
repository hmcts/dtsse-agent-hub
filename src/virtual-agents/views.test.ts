import { describe, expect, it } from "vitest";
import { claudeTokenUsable, neededCredentials, OPTIONAL_CREDENTIALS } from "./views.ts";

describe("neededCredentials", () => {
  it.each([
    ["own-licence", ["github", "claude"]],
    ["bedrock", ["github", "bedrock"]]
  ] as const)("should need GitHub and the model key, and nothing optional, when the agent is on the %s route", (route, expected) => {
    expect(neededCredentials(route)).toEqual(expected);
    expect(neededCredentials(route).some((kind) => OPTIONAL_CREDENTIALS.includes(kind))).toBe(false);
  });
});

describe("claudeTokenUsable", () => {
  it("should want one when the person is on their own licence and their agents agree", () => {
    expect(claudeTokenUsable("own-licence", ["own-licence"])).toBe(true);
  });

  it("should want none when the person is on Bedrock and their agents agree", () => {
    expect(claudeTokenUsable("bedrock", ["bedrock"])).toBe(false);
  });

  it("should want one when the person is on Bedrock but an agent of theirs is on their own licence", () => {
    expect(claudeTokenUsable("bedrock", ["bedrock", "own-licence"])).toBe(true);
  });

  it("should want one when the person is on their own licence but every agent of theirs is on Bedrock", () => {
    expect(claudeTokenUsable("own-licence", ["bedrock"])).toBe(true);
  });

  it.each([
    ["own-licence", true],
    ["bedrock", false]
  ] as const)("should answer from the person's own route when they have no agents yet and are on the %s route", (route, expected) => {
    expect(claudeTokenUsable(route, [])).toBe(expected);
  });
});

describe("OPTIONAL_CREDENTIALS", () => {
  it("should offer Azure, Jenkins and Atlassian when an agent can start without any of them", () => {
    expect(OPTIONAL_CREDENTIALS).toEqual(["azure", "jenkins", "atlassian"]);
  });

  it.each(["own-licence", "bedrock"] as const)("should not need Azure when the agent is on the %s route", (route) => {
    expect(neededCredentials(route)).not.toContain("azure");
  });
});
