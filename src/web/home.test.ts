import { describe, expect, it } from "vitest";
import { assistantSettingsPath, defaultUi, homeFor, movedHubPath, NO_AGENT, retiredAgentPath, retiredHubPath } from "./home.ts";

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
    expect(movedHubPath("/cx")).toBeUndefined();
  });

  it("should leave the retired access page to `retiredHubPath`, which answers for both of its addresses", () => {
    expect(movedHubPath("/access")).toBeUndefined();
    expect(movedHubPath("/hub/access")).toBeUndefined();
  });
});

describe("retiredHubPath", () => {
  it.each([
    ["/virtual", "/assistant?settings=assistant"],
    ["/hub/virtual", "/assistant?settings=assistant"],
    ["/hub/virtual/0f8a", "/assistant?settings=assistant"],
    ["/settings/credentials", "/assistant?settings=credentials"],
    ["/hub/settings/credentials", "/assistant?settings=credentials"]
  ])("should send %s to %s when virtual agents are on", (pathname, to) => {
    expect(retiredHubPath(pathname, true)).toBe(to);
  });

  it.each(["/hub/virtual", "/hub/virtual/0f8a", "/hub/settings/credentials"])("should send %s to the hub when virtual agents are off", (pathname) => {
    expect(retiredHubPath(pathname, false)).toBe("/hub");
  });

  it.each(["/hub/virtual/0f8a/ports/3000", "/virtual/0f8a/ports/3000", "/hub/settings", "/hub/virtualfoo"])(
    "should leave %s alone when it is not a retired page, the viewer's ticket route among them",
    (pathname) => {
      expect(retiredHubPath(pathname, true)).toBeUndefined();
    }
  );

  it.each(["/access", "/hub/access"])("should send %s to the shared chats", (pathname) => {
    expect(retiredHubPath(pathname, true)).toBe("/assistant/shared");
  });

  // There are no conversations to share with virtual agents off, and the Assistant's pages are not found at all.
  it.each(["/access", "/hub/access"])("should send %s to the hub instead when virtual agents are off", (pathname) => {
    expect(retiredHubPath(pathname, false)).toBe("/hub");
  });

  it.each(["/", "/hub", "/accessible", "/hub/accessible", "/hub/topics", "/assistant/shared"])(
    "should leave %s alone, which is not the page that went",
    (pathname) => {
      expect(retiredHubPath(pathname, true)).toBeUndefined();
    }
  );
});

describe("retiredAgentPath", () => {
  const CONVERSATION = "22222222-2222-2222-2222-222222222222";

  it("should send a chat's agent to that chat in the Assistant when virtual agents are on", () => {
    expect(retiredAgentPath({ kind: "chat", conversationId: CONVERSATION }, true)).toBe(`/assistant/${CONVERSATION}`);
  });

  it("should send a virtual agent to the Assistant section of the Assistant's settings when virtual agents are on", () => {
    expect(retiredAgentPath({ kind: "virtual" }, true)).toBe("/assistant?settings=assistant");
  });

  it("should send anything else to the hub's home when virtual agents are on", () => {
    expect(retiredAgentPath(NO_AGENT, true)).toBe("/hub");
  });

  // The Assistant's pages are not found with virtual agents off, so no address may be sent there.
  it.each([{ kind: "chat", conversationId: CONVERSATION } as const, { kind: "virtual" } as const, NO_AGENT])(
    "should send every agent's address to the hub's home when virtual agents are off",
    (address) => {
      expect(retiredAgentPath(address, false)).toBe("/hub");
    }
  );

  it("should encode a conversation id when it would reach past its own path segment", () => {
    expect(retiredAgentPath({ kind: "chat", conversationId: "../shared" }, true)).toBe("/assistant/..%2Fshared");
  });
});

describe("assistantSettingsPath", () => {
  it("should name the section in the query the settings dialog reads when given one", () => {
    expect(assistantSettingsPath("connections")).toBe("/assistant?settings=connections");
  });
});
