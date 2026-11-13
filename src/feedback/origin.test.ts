import { describe, expect, it } from "vitest";
import { sameOriginRequest } from "./origin.ts";

const HUB = "https://agent-hub.aat.platform.hmcts.net";

function request(headers: Record<string, string>): Request {
  return new Request(`${HUB}/api/ui/feedback/review/x/threads`, { method: "POST", headers });
}

describe("sameOriginRequest", () => {
  it("should accept a request whose Origin is the hub's", () => {
    expect(sameOriginRequest(request({ origin: HUB }), HUB)).toBe(true);
  });

  it("should refuse a request from the viewer's host when it sends its Origin", () => {
    expect(sameOriginRequest(request({ origin: "https://agent-hub-viewer.aat.platform.hmcts.net", "sec-fetch-site": "same-site" }), HUB)).toBe(false);
  });

  it("should refuse an Origin of null", () => {
    expect(sameOriginRequest(request({ origin: "null" }), HUB)).toBe(false);
  });

  it("should accept a same-origin GET that carries no Origin when the browser says it is same-origin", () => {
    expect(sameOriginRequest(request({ "sec-fetch-site": "same-origin" }), HUB)).toBe(true);
  });

  it("should refuse a request with no Origin when it is same-site rather than same-origin", () => {
    expect(sameOriginRequest(request({ "sec-fetch-site": "same-site" }), HUB)).toBe(false);
  });

  it("should refuse a request that carries neither header", () => {
    expect(sameOriginRequest(request({}), HUB)).toBe(false);
  });
});
