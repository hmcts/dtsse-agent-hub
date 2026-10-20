import { describe, expect, it, vi } from "vitest";
import {
  type Fetch,
  type ForwardTarget,
  forward,
  forwardedCookie,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  rewriteLocation,
  rewriteSetCookie,
  UpstreamUnreachable
} from "./forward.ts";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const PREFIX = `/${ID}/8080`;
const TARGET: ForwardTarget = {
  upstreamOrigin: "https://va-abc-8080.preview.platform.hmcts.net",
  rest: "/docs",
  search: "?page=2",
  prefix: PREFIX,
  viewerHost: "agent-hub-viewer.example"
};

describe("forwardedCookie", () => {
  it("should keep the pod's own cookies and leave out the viewer's when the browser sends both", () => {
    expect(forwardedCookie(`theme=dark; ahv-${ID}-8080=sealed; sid=1`)).toBe("theme=dark; sid=1");
  });

  it("should send no Cookie at all when only the viewer's cookie, or none, was sent", () => {
    expect(forwardedCookie(`ahv-${ID}-8080=sealed`)).toBeUndefined();
    expect(forwardedCookie(null)).toBeUndefined();
  });
});

describe("forwardedRequestHeaders", () => {
  it("should pass the browser's headers on, replacing what describes its connection to the viewer", () => {
    const headers = forwardedRequestHeaders(
      new Headers({
        accept: "text/html",
        host: "agent-hub-viewer.example",
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "1",
        "keep-alive": "timeout=5",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-prefix": "/spoofed",
        "x-agent-hub-viewer-url": "/spoofed",
        "x-middleware-subrequest": "x",
        cookie: `ahv-${ID}-8080=sealed; sid=1`
      }),
      TARGET
    );

    expect(Object.fromEntries(headers)).toEqual({
      accept: "text/html",
      cookie: "sid=1",
      "x-forwarded-host": "agent-hub-viewer.example",
      "x-forwarded-proto": "https",
      "x-forwarded-prefix": PREFIX
    });
  });
});

describe("rewriteLocation", () => {
  it.each([
    ["/login", `${PREFIX}/login`],
    ["https://va-abc-8080.preview.platform.hmcts.net/login?next=%2F#top", `${PREFIX}/login?next=%2F#top`],
    ["http://va-abc-8080.preview.platform.hmcts.net:8080/", `${PREFIX}/`],
    ["login", "login"],
    ["//elsewhere.example/", "//elsewhere.example/"],
    ["https://login.microsoftonline.com/", "https://login.microsoftonline.com/"]
  ])("should send a redirect to %j on to %j", (location, rewritten) => {
    expect(rewriteLocation(location, TARGET)).toBe(rewritten);
  });
});

describe("rewriteSetCookie", () => {
  it("should put a cookie's Path under the prefix and drop its Domain, keeping its other attributes", () => {
    expect(rewriteSetCookie("sid=1; Domain=preview.platform.hmcts.net; Path=/app; HttpOnly; SameSite=Lax", PREFIX)).toBe(
      `sid=1; Path=${PREFIX}/app; HttpOnly; SameSite=Lax`
    );
  });

  it("should scope a Path that is not from / to the whole prefix, and leave a cookie with no Path to the browser", () => {
    expect(rewriteSetCookie("sid=1; path=odd", PREFIX)).toBe(`sid=1; Path=${PREFIX}/`);
    expect(rewriteSetCookie("sid=1; Secure;", PREFIX)).toBe("sid=1; Secure");
  });

  it("should refuse a cookie named like the viewer's own", () => {
    expect(rewriteSetCookie(`ahv-${ID}-8080=forged; Path=/`, PREFIX)).toBeUndefined();
  });
});

describe("forwardedResponseHeaders", () => {
  it("should drop what no longer describes the body or is not the pod's to set, and rewrite redirects and cookies", () => {
    const incoming = new Headers({
      "content-type": "text/html",
      "content-encoding": "gzip",
      "content-length": "10",
      "strict-transport-security": "max-age=1",
      "transfer-encoding": "chunked",
      location: "/next"
    });
    incoming.append("set-cookie", "a=1; Path=/");
    incoming.append("set-cookie", `ahv-${ID}-8080=forged`);

    const headers = forwardedResponseHeaders(incoming, TARGET);

    expect(headers.get("content-type")).toBe("text/html");
    expect(headers.get("location")).toBe(`${PREFIX}/next`);
    expect(headers.getSetCookie()).toEqual([`a=1; Path=${PREFIX}/`]);
    for (const name of ["content-encoding", "content-length", "strict-transport-security", "transfer-encoding"]) {
      expect(headers.has(name)).toBe(false);
    }
  });
});

describe("forward", () => {
  it("should fetch the rest of the path and the query from the upstream origin without following its redirects", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("hello", { status: 201, statusText: "Created", headers: { "content-type": "text/plain" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://va-abc-8080.preview.platform.hmcts.net/docs?page=2",
      expect.objectContaining({ method: "GET", redirect: "manual" })
    );
    expect(fetchImpl.mock.calls[0]![1]).not.toHaveProperty("body");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(await response.text()).toBe("hello");
  });

  it("should stream a request's body on when its method may have one", async () => {
    const fetchImpl = vi.fn<Fetch>(async (_url, init) => new Response(await new Response(init.body).text()));

    const response = await forward(new Request("https://agent-hub-viewer.example/x", { method: "POST", body: "form=1" }), TARGET, fetchImpl);

    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", duplex: "half" });
    expect(await response.text()).toBe("form=1");
  });

  it("should answer a HEAD, a 204 and a 304 without a body", async () => {
    const answers = [new Response("ignored"), new Response(null, { status: 204 }), new Response(null, { status: 304 })];
    const fetchImpl = vi.fn<Fetch>(async () => answers.shift()!);

    const head = await forward(new Request("https://agent-hub-viewer.example/x", { method: "HEAD" }), TARGET, fetchImpl);
    const empty = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);
    const unchanged = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);

    expect([head.body, empty.status, unchanged.status]).toEqual([null, 204, 304]);
  });

  it("should throw UpstreamUnreachable when the pod does not answer", async () => {
    const refused = vi.fn<Fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const odd = vi.fn<Fetch>(async () => {
      throw "not an error";
    });

    await expect(forward(new Request("https://agent-hub-viewer.example/x"), TARGET, refused)).rejects.toThrow(UpstreamUnreachable);
    await expect(forward(new Request("https://agent-hub-viewer.example/x"), TARGET, odd)).rejects.toThrow("not an error");
  });
});
