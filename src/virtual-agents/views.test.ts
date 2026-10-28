import { describe, expect, it } from "vitest";
import type { ModelRoute } from "../viewer/identity.ts";
import { claudeTokenUsable, neededCredentials, OPTIONAL_CREDENTIALS, optionalCredentials } from "./views.ts";

const ROUTES: ModelRoute[] = ["bedrock", "gateway", "own-licence"];

describe("neededCredentials", () => {
  it.each([
    ["own-licence", ["github", "claude"]],
    ["bedrock", ["github", "bedrock"]],
    ["gateway", ["github", "azure"]]
  ] as const)("should need GitHub and the route's own model credential when the agent is on the %s route", (route, expected) => {
    expect(neededCredentials(route)).toEqual(expected);
  });

  // The gateway authorises the owner rather than a key of theirs, so there is nothing of theirs to store for it.
  it("should ask for no model credential at all when the agent is on the gateway route", () => {
    expect(neededCredentials("gateway")).not.toContain("bedrock");
    expect(neededCredentials("gateway")).not.toContain("claude");
  });

  it.each(ROUTES)("should answer with a list of its own that a caller cannot mutate when the route is %s", (route) => {
    neededCredentials(route).push("jenkins");

    expect(neededCredentials(route)).not.toContain("jenkins");
  });
});

describe("claudeTokenUsable", () => {
  it("should want one when the person is on their own licence and their agents agree", () => {
    expect(claudeTokenUsable("own-licence", ["own-licence"])).toBe(true);
  });

  it("should want none when the person is on the gateway and their agents agree", () => {
    expect(claudeTokenUsable("gateway", ["gateway"])).toBe(false);
  });

  it("should want none when the person is on the gateway and an agent of theirs is still on Bedrock", () => {
    expect(claudeTokenUsable("gateway", ["gateway", "bedrock"])).toBe(false);
  });

  it("should want one when the person is on the gateway but an agent of theirs is on their own licence", () => {
    expect(claudeTokenUsable("gateway", ["gateway", "own-licence"])).toBe(true);
  });

  it("should want one when the person is on their own licence but every agent of theirs is on the gateway", () => {
    expect(claudeTokenUsable("own-licence", ["gateway"])).toBe(true);
  });

  it.each([
    ["own-licence", true],
    ["bedrock", false],
    ["gateway", false]
  ] as const)("should answer from the person's own route when they have no agents yet and are on the %s route", (route, expected) => {
    expect(claudeTokenUsable(route, [])).toBe(expected);
  });
});

describe("optionalCredentials", () => {
  it("should offer Azure, Jenkins and Atlassian when an agent can start without any of them", () => {
    expect(OPTIONAL_CREDENTIALS).toEqual(["azure", "jenkins", "atlassian"]);
    expect(optionalCredentials("own-licence")).toEqual(["azure", "jenkins", "atlassian"]);
    expect(optionalCredentials("bedrock")).toEqual(["azure", "jenkins", "atlassian"]);
  });

  // Both lists are read one after the other, and a kind in both is a settings dialog with two rows for it.
  it("should leave Azure out when the agent is on the gateway route, where it is needed rather than optional", () => {
    expect(optionalCredentials("gateway")).toEqual(["jenkins", "atlassian"]);
  });

  it.each(ROUTES)("should name nothing the %s route already needs", (route) => {
    const needed = neededCredentials(route);

    expect(optionalCredentials(route).filter((kind) => needed.includes(kind))).toEqual([]);
  });
});
