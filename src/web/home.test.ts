import { describe, expect, it } from "vitest";
import { defaultUi, homeFor, movedHubPath } from "./home.ts";

describe("homeFor", () => {
  it.each(["/hub", "/hub/topics", "/hub/agents/0f8a", "/hub/nonsense"])("should send someone back into the hub from %s", (pathname) => {
    expect(homeFor(pathname)).toBe("/hub");
  });

  it.each(["/", "/nonsense", "/assistant", "/assistant/0f8a"])("should send someone to the front door from %s", (pathname) => {
    expect(homeFor(pathname)).toBe("/");
  });

  it("should match the whole segment, so a path merely starting with the prefix is not the hub", () => {
    expect(homeFor("/hubbub")).toBe("/");
    expect(homeFor("/hub-other")).toBe("/");
  });
});

describe("defaultUi", () => {
  it("should send / to the HMCTS Assistant when virtual agents are on", () => {
    expect(defaultUi(true)).toBe("/assistant");
  });

  it("should send / to the hub when virtual agents are off", () => {
    expect(defaultUi(false)).toBe("/hub");
  });
});

describe("movedHubPath", () => {
  it.each([
    ["/access", "/hub/access"],
    ["/agents/0f8a", "/hub/agents/0f8a"],
    ["/c", "/hub/c"],
    ["/channels/new", "/hub/channels/new"],
    ["/channels/0f8a", "/hub/channels/0f8a"],
    ["/m/42", "/hub/m/42"],
    ["/settings/credentials", "/hub/settings/credentials"],
    ["/topics", "/hub/topics"],
    ["/topics/pcs-api", "/hub/topics/pcs-api"],
    ["/virtual", "/hub/virtual"],
    ["/virtual/0f8a", "/hub/virtual/0f8a"]
  ])("should serve the bare address %s from %s", (bare, served) => {
    expect(movedHubPath(bare)).toBe(served);
  });

  it("should leave the front door and the Assistant alone", () => {
    expect(movedHubPath("/")).toBeUndefined();
    expect(movedHubPath("/assistant")).toBeUndefined();
    expect(movedHubPath("/assistant/0f8a")).toBeUndefined();
  });

  it("should leave the hub's own pages alone, or every one of them would redirect to itself", () => {
    expect(movedHubPath("/hub")).toBeUndefined();
    expect(movedHubPath("/hub/topics")).toBeUndefined();
    expect(movedHubPath("/hub/agents/0f8a")).toBeUndefined();
  });

  it.each(["/auth/login", "/auth/callback", "/api/ui/feed", "/api/agent/agents", "/health", "/health/liveness"])(
    "should leave %s alone, which is not a page the hub ever served",
    (path) => {
      expect(movedHubPath(path)).toBeUndefined();
    }
  );

  it("should match a whole segment only, so a path that merely starts with one is untouched", () => {
    expect(movedHubPath("/topicsfoo")).toBeUndefined();
    expect(movedHubPath("/accessible")).toBeUndefined();
    expect(movedHubPath("/cx")).toBeUndefined();
  });
});
