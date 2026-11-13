import { describe, expect, it } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { noStore, reviewLanding, reviewRefusal, threadQuery } from "./review-api.ts";

const HUB = "https://agent-hub.aat.platform.hmcts.net";

function request(origin?: string): Request {
  return new Request(`${HUB}/api/ui/feedback/review/t/threads`, { method: "POST", headers: origin === undefined ? {} : { origin } });
}

describe("reviewRefusal", () => {
  it("should let a request from the hub through when feedback is on", () => {
    expect(reviewRefusal(request(HUB), { hubOrigin: HUB, enabled: true })).toBeUndefined();
  });

  it("should answer 403 when the request came from another origin", async () => {
    const refusal = reviewRefusal(request("https://agent-hub-viewer.aat.platform.hmcts.net"), { hubOrigin: HUB, enabled: true });
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({ error: "that request did not come from the hub's own page" });
  });

  it("should answer 403 before saying feedback is off when the request came from another origin", () => {
    expect(reviewRefusal(request("https://elsewhere.example"), { hubOrigin: HUB, enabled: false })?.status).toBe(403);
  });

  it("should answer 404 when feedback is off", () => {
    expect(reviewRefusal(request(HUB), { hubOrigin: HUB, enabled: false })?.status).toBe(404);
  });

  it("should answer 404 when there is no hub origin to check against", () => {
    expect(reviewRefusal(request(HUB), { hubOrigin: undefined, enabled: true })?.status).toBe(404);
  });
});

describe("threadQuery", () => {
  it("should read a page and a status", () => {
    expect(threadQuery(new URLSearchParams({ page_path: "/start?x=1", status: "open" }))).toEqual({ pagePath: "/start?x=1", status: "open" });
  });

  it("should read nothing when neither is given", () => {
    expect(threadQuery(new URLSearchParams())).toEqual({});
  });

  it.each([
    ["page_path", { page_path: "//evil.example/" }],
    ["status", { status: "closed" }]
  ])("should refuse a malformed %s", (field, query) => {
    expect(() => threadQuery(new URLSearchParams(query))).toThrow(HttpError);
    expect(() => threadQuery(new URLSearchParams(query))).toThrow(new RegExp(`^${field}:`));
  });
});

describe("noStore", () => {
  it("should mark the answer as not to be cached", () => {
    expect(noStore(Response.json({})).headers.get("cache-control")).toBe("no-store");
  });
});

describe("reviewLanding", () => {
  it("should land on the page asked for", () => {
    expect(reviewLanding("https://proto.example/start", "/check?x=1")).toBe("/check?x=1");
  });

  it.each([undefined, "", ["/a", "/b"]])("should land on the link's own page when %o is asked for", (requested) => {
    expect(reviewLanding("https://proto.example/start?v=2", requested)).toBe("/start?v=2");
  });
});
