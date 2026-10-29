import { describe, expect, it } from "vitest";
import { requestHost, viewerHost, viewerRouteHost, viewerSettings } from "./settings.ts";

const COMPLETE = {
  AGENT_HUB_VIEWER_HOST: "agent-hub-viewer.aat.platform.hmcts.net",
  ENTRA_REDIRECT_URI: "https://agent-hub.aat.platform.hmcts.net/auth/callback",
  SESSION_SECRET: "a-test-session-secret-long-enough-to-be-plausible\n"
};

describe("viewerHost", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["  ", undefined],
    ["https://agent-hub-viewer.example", undefined],
    ["agent-hub-viewer.example/path", undefined],
    ["localhost", undefined],
    [" Agent-Hub-Viewer.Example ", "agent-hub-viewer.example"]
  ])("should read AGENT_HUB_VIEWER_HOST=%j as %j", (value, host) => {
    expect(viewerHost({ AGENT_HUB_VIEWER_HOST: value })).toBe(host);
  });
});

describe("viewerRouteHost", () => {
  it("should route the viewer's own host to the viewer", () => {
    expect(viewerRouteHost(COMPLETE)).toBe("agent-hub-viewer.aat.platform.hmcts.net");
  });

  it("should leave the hub's host to the hub when the viewer is named as it, rather than 404 the hub and its probes", () => {
    expect(viewerRouteHost({ ...COMPLETE, AGENT_HUB_VIEWER_HOST: "agent-hub.aat.platform.hmcts.net" })).toBeUndefined();
  });

  it("should still route the viewer's host when the hub's own origin is unknown, so agents' paths never reach hub routes", () => {
    expect(viewerRouteHost({ ...COMPLETE, ENTRA_REDIRECT_URI: undefined })).toBe("agent-hub-viewer.aat.platform.hmcts.net");
  });

  it("should route nothing when no viewer host is set", () => {
    expect(viewerRouteHost({ ...COMPLETE, AGENT_HUB_VIEWER_HOST: undefined })).toBeUndefined();
  });
});

describe("viewerSettings", () => {
  it("should give the host, the hub's origin and the trimmed secret when all three are set", () => {
    expect(viewerSettings(COMPLETE)).toEqual({
      host: "agent-hub-viewer.aat.platform.hmcts.net",
      hubOrigin: "https://agent-hub.aat.platform.hmcts.net",
      secret: "a-test-session-secret-long-enough-to-be-plausible"
    });
  });

  it.each(["AGENT_HUB_VIEWER_HOST", "ENTRA_REDIRECT_URI", "SESSION_SECRET"])("should be off when %s is missing", (name) => {
    expect(viewerSettings({ ...COMPLETE, [name]: undefined })).toBeUndefined();
  });

  it.each(["not a url", "ftp://agent-hub.example/auth/callback"])("should be off when ENTRA_REDIRECT_URI is %j", (value) => {
    expect(viewerSettings({ ...COMPLETE, ENTRA_REDIRECT_URI: value })).toBeUndefined();
  });

  it("should be off when the viewer's host is the hub's own, which would put agents' pages on the hub's origin", () => {
    expect(viewerSettings({ ...COMPLETE, AGENT_HUB_VIEWER_HOST: "agent-hub.aat.platform.hmcts.net" })).toBeUndefined();
  });
});

describe("requestHost", () => {
  it("should read Host in lower case without its port when it is sent", () => {
    expect(requestHost(new Headers({ host: "Agent-Hub-Viewer.Example:443" }), "fallback.example")).toBe("agent-hub-viewer.example");
  });

  it("should fall back to the given host when no Host is sent", () => {
    expect(requestHost(new Headers(), "Fallback.Example")).toBe("fallback.example");
  });
});
