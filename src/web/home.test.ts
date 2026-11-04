import { describe, expect, it } from "vitest";
import {
  assistantSettingsPath,
  defaultUi,
  homeFor,
  movedHubPath,
  movedPortTicketPath,
  NO_AGENT,
  retiredAgentPath,
  retiredPath,
  SHARED_CHATS,
  withoutSettingsParameter
} from "./home.ts";

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
  it("should send / to the CFT Workspace when virtual agents are on", () => {
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

  it("should leave the access page to `retiredPath` when given either of its addresses", () => {
    expect(movedHubPath("/access")).toBeUndefined();
    expect(movedHubPath("/hub/access")).toBeUndefined();
  });
});

describe("retiredPath", () => {
  it.each([
    ["/virtual", "/assistant?settings=assistant"],
    ["/hub/virtual", "/assistant?settings=assistant"],
    ["/hub/virtual/0f8a", "/assistant?settings=assistant"],
    ["/settings/credentials", "/assistant?settings=connections"],
    ["/hub/settings/credentials", "/assistant?settings=connections"]
  ])("should send %s to %s when virtual agents are on", (pathname, to) => {
    expect(retiredPath(pathname, true)).toBe(to);
  });

  it.each(["/access", "/hub/access", "/assistant/shared"])("should send %s to the settings' Sharing section when virtual agents are on", (pathname) => {
    expect(retiredPath(pathname, true)).toBe("/assistant?settings=sharing");
  });

  it.each(["/hub/virtual/0f8a/ports/3000", "/virtual/0f8a/ports/3000", "/hub/settings", "/hub/virtualfoo"])(
    "should leave %s alone when it is not a retired page, the addresses movedPortTicketPath answers for among them",
    (pathname) => {
      expect(retiredPath(pathname, true)).toBeUndefined();
    }
  );

  it("should name the Sharing section when building the address shared chats are managed at", () => {
    expect(SHARED_CHATS).toBe("/assistant?settings=sharing");
  });

  // There are no conversations to share with virtual agents off, and the Assistant's pages are not found at all.
  it.each(["/access", "/hub/access", "/assistant/shared", "/hub/virtual", "/hub/virtual/0f8a", "/hub/settings/credentials"])(
    "should send %s to the hub instead when virtual agents are off",
    (pathname) => {
      expect(retiredPath(pathname, false)).toBe("/hub");
    }
  );

  it.each([
    "/",
    "/hub",
    "/accessible",
    "/hub/accessible",
    "/hub/topics",
    "/assistant",
    "/assistant/shared/abc",
    "/assistant/sharedfoo",
    "/hub/assistant/shared",
    "/hub/virtual/0f8a/ports/3000",
    "/virtual/0f8a/ports/3000",
    "/hub/settings",
    "/hub/virtualfoo"
  ])("should leave %s alone when it is not an address that went, the viewer's ticket route among them", (pathname) => {
    expect(retiredPath(pathname, true)).toBeUndefined();
  });
});

describe("movedPortTicketPath", () => {
  const ID = "0f8a6a1e-0000-4000-8000-000000000001";

  it.each([
    [`/hub/virtual/${ID}/ports/3000`, `/assistant/ports/${ID}/3000`],
    [`/virtual/${ID}/ports/3000`, `/assistant/ports/${ID}/3000`],
    [`/hub/virtual/${ID.toUpperCase()}/ports/65535`, `/assistant/ports/${ID}/65535`],
    [`/hub/virtual/${ID}/ports/1024`, `/assistant/ports/${ID}/1024`]
  ])("should send %s to %s when it names an agent's id and a port", (pathname, to) => {
    expect(movedPortTicketPath(pathname)).toEqual({ kind: "moved", to });
  });

  // The redirect is permanent, so anything put into its target unchecked would be cached as a way to anywhere.
  it.each([
    `/hub/virtual/../ports/3000`,
    `/hub/virtual/%2e%2e/ports/3000`,
    `/hub/virtual/0f8a/ports/3000`,
    `/hub/virtual/${ID}/ports/..`,
    `/hub/virtual/${ID}/ports/%2e%2e`,
    `/hub/virtual/${ID}/ports/03000`,
    `/hub/virtual/${ID}/ports/1023`,
    `/hub/virtual/${ID}/ports/65536`,
    `/hub/virtual/${ID}/ports/3000/docs`,
    `/hub/virtual/${ID}/ports/3000/../../../hub/topics`,
    `/hub/virtual/${ID}/ports`,
    `/virtual/${ID}/ports/`
  ])("should answer not found for %s when it does not name an agent's id and a port", (pathname) => {
    expect(movedPortTicketPath(pathname)).toEqual({ kind: "not-found" });
  });

  it.each([
    "/hub/virtual",
    "/hub/virtual/0f8a",
    `/hub/virtual/${ID}/portsfoo/3000`,
    `/hub/virtual/${ID}/x/ports/3000`,
    `/assistant/ports/${ID}/3000`,
    `/hubx/virtual/${ID}/ports/3000`
  ])("should leave %s alone when it is not under the old ticket route", (pathname) => {
    expect(movedPortTicketPath(pathname)).toBeUndefined();
  });
});

describe("retiredAgentPath", () => {
  const CONVERSATION = "22222222-2222-2222-2222-222222222222";

  it("should send a chat's agent to that chat in the Assistant when virtual agents are on", () => {
    expect(retiredAgentPath({ kind: "chat", conversationId: CONVERSATION }, true)).toBe(`/assistant/${CONVERSATION}`);
  });

  it("should send the Assistant's own virtual agent to the Assistant section of its settings when virtual agents are on", () => {
    expect(retiredAgentPath({ kind: "virtual", assistant: true }, true)).toBe("/assistant?settings=assistant");
  });

  // The settings show and restart the Assistant's agent alone, so another agent's address must not open them.
  it("should send any other virtual agent to the Assistant itself when it is not the one the Assistant runs on", () => {
    expect(retiredAgentPath({ kind: "virtual", assistant: false }, true)).toBe("/assistant");
  });

  it("should send anything else to the hub's home when virtual agents are on", () => {
    expect(retiredAgentPath(NO_AGENT, true)).toBe("/hub");
  });

  // The Assistant's pages are not found with virtual agents off, so no address may be sent there.
  it.each([{ kind: "chat", conversationId: CONVERSATION } as const, { kind: "virtual", assistant: true } as const, NO_AGENT])(
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

describe("withoutSettingsParameter", () => {
  it("should keep the rest of the query exactly as it was written when taking the settings pair out", () => {
    expect(withoutSettingsParameter("?view=a,b&settings=sharing&q=x%20y&r=1+2")).toBe("?view=a,b&q=x%20y&r=1+2");
  });

  it("should take out every settings pair when the query carries more than one", () => {
    expect(withoutSettingsParameter("?settings=sharing&share=1&settings=x")).toBe("?share=1");
  });

  it("should leave no question mark when the settings pair was all the query held", () => {
    expect(withoutSettingsParameter("?settings=sharing")).toBe("");
  });

  it("should keep a pair whose name only starts with settings when taking the settings pair out", () => {
    expect(withoutSettingsParameter("?settingsx=1&settings")).toBe("?settingsx=1");
  });
});
