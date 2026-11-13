import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { feedbackRoute, noStore, reviewLanding, reviewRefusal, teamThreadQuery, threadQuery } from "./review-api.ts";

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

describe("feedbackRoute", () => {
  const VIEWER = "https://agent-hub-viewer.aat.platform.hmcts.net";

  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("AUTH_DEV_USER", "oid-1|Ann|ann@example.com");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");
    vi.stubEnv("ENTRA_REDIRECT_URI", `${HUB}/auth/callback`);
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", new URL(VIEWER).host);
    vi.stubEnv("FEEDBACK_ENABLED", "true");
    vi.stubEnv("FEEDBACK_STORAGE_CONNECTION_STRING", "UseDevelopmentStorage=true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function get(headers: Record<string, string>): NextRequest {
    return new NextRequest(`${HUB}/api/ui/feedback/review/t/threads`, { headers });
  }

  it("should run the handler as the viewer when the request is the hub's own page's", async () => {
    const response = await feedbackRoute(get({ "sec-fetch-site": "same-origin" }), "read", async (viewer) => Response.json({ oid: viewer.oid }));

    expect(await response.json()).toEqual({ oid: "oid-1" });
  });

  it("should answer 403 to a read from the viewer's host without running the handler", async () => {
    const work = vi.fn(async () => Response.json({}));

    const response = await feedbackRoute(get({ "sec-fetch-site": "same-site", origin: VIEWER }), "read", work);

    expect(response.status).toBe(403);
    expect(work).not.toHaveBeenCalled();
  });

  it("should answer 401 when nobody is signed in", async () => {
    vi.stubEnv("AUTH_DISABLED", "");

    expect((await feedbackRoute(get({ "sec-fetch-site": "same-origin" }), "read", async () => Response.json({}))).status).toBe(401);
  });

  it("should render a store's refusal as the contract's error", async () => {
    const response = await feedbackRoute(get({ "sec-fetch-site": "same-origin" }), "read", async () => {
      throw new HttpError(409, "that recording has stopped");
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "that recording has stopped" });
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

describe("teamThreadQuery", () => {
  it("should read every filter it is given", () => {
    expect(teamThreadQuery(new URLSearchParams({ link: "l", page: "/start", status: "resolved", author: "a" }))).toEqual({
      linkId: "l",
      pagePath: "/start",
      status: "resolved",
      authorOid: "a"
    });
  });

  it("should read an empty filter as none", () => {
    expect(teamThreadQuery(new URLSearchParams({ link: "", status: "" }))).toEqual({
      linkId: undefined,
      pagePath: undefined,
      status: undefined,
      authorOid: undefined
    });
  });

  it("should refuse a status that is not one a thread can have, as the shell's read does", () => {
    expect(() => teamThreadQuery(new URLSearchParams({ status: "closed" }))).toThrow(/^status:/);
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
