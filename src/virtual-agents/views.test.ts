import { describe, expect, it } from "vitest";
import { neededCredentials, OPTIONAL_CREDENTIALS } from "./views.ts";

describe("neededCredentials", () => {
  it.each([
    ["own-licence", ["github", "azure", "claude"]],
    ["bedrock", ["github", "azure", "bedrock"]]
  ] as const)("should need GitHub, Azure and the model key, and nothing optional, when the agent is on the %s route", (route, expected) => {
    expect(neededCredentials(route)).toEqual(expected);
    expect(neededCredentials(route).some((kind) => OPTIONAL_CREDENTIALS.includes(kind))).toBe(false);
  });
});

describe("OPTIONAL_CREDENTIALS", () => {
  it("should offer Jenkins and Atlassian when an agent can start without either", () => {
    expect(OPTIONAL_CREDENTIALS).toEqual(["jenkins", "atlassian"]);
  });
});
