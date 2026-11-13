import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config.mjs";
import { pinnedFetch } from "../feedback/targets.ts";
import {
  BASE_REWRITE_LIMIT_BYTES,
  declaresTooLongBody,
  type Fetch,
  type ForwardTarget,
  forward,
  forwardedCookie,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  isRewritableHtml,
  PROXY_BODY_LIMIT_BYTES,
  rewriteBaseHref,
  rewriteCsp,
  rewriteLocation,
  rewriteSetCookie,
  signInCookie,
  transformHtml,
  UpstreamUnreachable
} from "./forward.ts";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const PREFIX = `/${ID}/8080`;
const TARGET: ForwardTarget = {
  upstreamOrigin: "https://va-abc-8080.preview.platform.hmcts.net",
  rest: "/docs",
  search: "?page=2",
  prefix: PREFIX,
  viewerHost: "agent-hub-viewer.example",
  viewerOrigin: "https://agent-hub-viewer.example"
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

  // A pod that reads the `X-Forwarded-Prefix` forwarding sends it — Spring Boot's `ForwardedHeaderFilter`, uvicorn's
  // `root_path` — builds its own links under the prefix already.
  it.each([
    [`${PREFIX}/login`, `${PREFIX}/login`],
    [PREFIX, PREFIX],
    [`https://va-abc-8080.preview.platform.hmcts.net${PREFIX}/login?next=%2F`, `${PREFIX}/login?next=%2F`],
    [`${PREFIX}foo/login`, `${PREFIX}${PREFIX}foo/login`]
  ])("should leave a redirect to %j that a prefix-aware pod has already put under the prefix", (location, rewritten) => {
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

  it("should leave a Path the pod has already put under the prefix, so the cookie is still sent back", () => {
    expect(rewriteSetCookie(`sid=1; Path=${PREFIX}/app`, PREFIX)).toBe(`sid=1; Path=${PREFIX}/app`);
    expect(rewriteSetCookie(`sid=1; Path=${PREFIX}`, PREFIX)).toBe(`sid=1; Path=${PREFIX}`);
  });

  // A browser refuses a `__Host-` cookie on any Path but `/`, and Auth.js names its CSRF cookie `__Host-` in
  // production: under the prefix the cookie would vanish and the sign-in fail with nothing said about a cookie.
  it("should keep Path=/ on a __Host- cookie, whatever Path the pod asked for", () => {
    expect(rewriteSetCookie("__Host-authjs.csrf-token=abc; Path=/app; Secure; HttpOnly", PREFIX)).toBe(
      "__Host-authjs.csrf-token=abc; Path=/; Secure; HttpOnly"
    );
    expect(rewriteSetCookie("__host-sid=1; Domain=preview.platform.hmcts.net; Path=/; Secure", PREFIX)).toBe("__host-sid=1; Path=/; Secure");
  });

  it("should give a __Host- cookie the Path=/ it needs when the pod sent none", () => {
    expect(rewriteSetCookie("__Host-sid=1; Secure", PREFIX)).toBe("__Host-sid=1; Secure; Path=/");
  });
});

describe("PROXY_BODY_LIMIT_BYTES", () => {
  // Drift either way is silent: raise the config alone and the viewer refuses what would now arrive whole; lower it
  // alone and the viewer forwards a truncated body again.
  it("should be the limit next.config.mjs sets on the proxy's body clone", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(`${PROXY_BODY_LIMIT_BYTES / (1024 * 1024)}mb`);
  });
});

describe("declaresTooLongBody", () => {
  it.each([
    [String(PROXY_BODY_LIMIT_BYTES + 1), true],
    ["25000000", true],
    [String(PROXY_BODY_LIMIT_BYTES), false],
    ["0", false],
    ["not a number", false]
  ])("should read Content-Length %j as declaring too long a body: %j", (declared, tooLong) => {
    expect(declaresTooLongBody(new Headers({ "content-length": declared }))).toBe(tooLong);
  });

  it("should let a request with no Content-Length through, there being nothing to compare", () => {
    expect(declaresTooLongBody(new Headers())).toBe(false);
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
      "referrer-policy": "no-referrer",
      location: "/next"
    });
    incoming.append("set-cookie", "a=1; Path=/");
    incoming.append("set-cookie", `ahv-${ID}-8080=forged`);

    const headers = forwardedResponseHeaders(incoming, TARGET);

    expect(headers.get("content-type")).toBe("text/html");
    expect(headers.get("location")).toBe(`${PREFIX}/next`);
    expect(headers.getSetCookie()).toEqual([`a=1; Path=${PREFIX}/`]);
    expect(headers.get("referrer-policy")).toBe("same-origin");
    for (const name of ["content-encoding", "content-length", "strict-transport-security", "transfer-encoding"]) {
      expect(headers.has(name)).toBe(false);
    }
  });
});

describe("rewriteBaseHref", () => {
  it("should move a base from `/` under the prefix, whatever its quotes, case or other attributes", () => {
    expect(rewriteBaseHref(`<head><base href="/"/></head>`, PREFIX)).toBe(`<head><base href="${PREFIX}/"/></head>`);
    expect(rewriteBaseHref(`<BASE target="_self" HREF='/app/'>`, PREFIX)).toBe(`<BASE target="_self" HREF='${PREFIX}/app/'>`);
  });

  it.each([
    `<base href="//elsewhere.example/">`,
    `<base href="/\\elsewhere.example/">`,
    `<base href="https://elsewhere.example/">`,
    `<base href="app/">`,
    "<p>/</p>"
  ])("should leave %s alone", (html) => {
    expect(rewriteBaseHref(html, PREFIX)).toBe(html);
  });

  it("should move the first base only", () => {
    expect(rewriteBaseHref(`<base href="/"><base href="/">`, PREFIX)).toBe(`<base href="${PREFIX}/"><base href="/">`);
  });
});

describe("isRewritableHtml", () => {
  it.each<[string, boolean]>([
    ["text/html", true],
    ["text/html; charset=utf-8", true],
    ['Text/HTML; Charset="UTF-8"', true],
    ["text/html; charset=iso-8859-1", false],
    ["application/json", false],
    ["", false]
  ])("should say %j is %s", (type, expected) => {
    expect(isRewritableHtml(new Headers(type === "" ? {} : { "content-type": type }))).toBe(expected);
  });
});

describe("forward", () => {
  it("should forward through a pinned fetch, streaming the body both ways and rewriting the page", async () => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=1; Path=/" });
        response.end(`<html><head><base href="/"></head><body>${request.headers.host} ${Buffer.concat(chunks).toString()}</body></html>`);
      });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as AddressInfo;
    const target = { ...TARGET, upstreamOrigin: `http://prototype.example:${port}`, rest: "/form", search: "" };
    const request = new Request("https://agent-hub-viewer.example/x", { method: "POST", body: "a=1", headers: { "content-type": "text/plain" } });

    const response = await forward(
      request,
      target,
      pinnedFetch(async () => [{ address: "127.0.0.1", family: 4 }])
    );

    expect(await response.text()).toBe(`<html><head><base href="${PREFIX}/"></head><body>prototype.example:${port} a=1</body></html>`);
    expect(response.headers.getSetCookie()).toEqual([`sid=1; Path=${PREFIX}/`]);
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  it("should move an HTML page's base under the prefix", async () => {
    const fetchImpl = vi.fn<Fetch>(
      async () => new Response(`<html><head><base href="/"></head></html>`, { headers: { "content-type": "text/html; charset=utf-8" } })
    );

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);

    expect(await response.text()).toBe(`<html><head><base href="${PREFIX}/"></head></html>`);
  });

  it("should leave a body that is not HTML as it came", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response(`{"html":"<base href=\\"/\\">"}`, { headers: { "content-type": "application/json" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);

    expect(await response.text()).toBe(`{"html":"<base href=\\"/\\">"}`);
  });

  it("should stream a page larger than the rewrite limit on whole and unchanged", async () => {
    const page = `<base href="/">${"x".repeat(BASE_REWRITE_LIMIT_BYTES)}`;
    const fetchImpl = vi.fn<Fetch>(async () => new Response(page, { headers: { "content-type": "text/html" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, fetchImpl);

    expect(await response.text()).toBe(page);
  });

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

const HUB = "https://agent-hub.example";
const VIEWER_ORIGIN = "https://agent-hub-viewer.example";
const REWRITE = { frameAncestors: HUB, scriptOrigin: VIEWER_ORIGIN, nonce: "n0nce" };
const FEEDBACK: ForwardTarget = {
  upstreamOrigin: "https://prototype.example",
  rest: "/start",
  search: "",
  prefix: "/f/token",
  viewerHost: "agent-hub-viewer.example",
  viewerOrigin: "https://agent-hub-viewer.example",
  frameAncestors: HUB,
  inject: '<script src="/_feedback/widget.js"></script>',
  scriptNonce: "n0nce",
  feedback: true
};

describe("rewriteCsp", () => {
  it.each<[string, string, string]>([
    ["no frame-ancestors", "default-src 'self'; img-src *", `default-src 'self'; img-src *; script-src 'self' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`],
    ["a frame-ancestors of its own", "frame-ancestors 'none'; img-src *", `img-src *; frame-ancestors ${HUB}`],
    ["frame-ancestors in capitals", "FRAME-ANCESTORS 'self'", `frame-ancestors ${HUB}`],
    ["a script-src", "script-src 'self' https://cdn.example", `script-src 'self' https://cdn.example ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`],
    [
      "script-src and script-src-elem both",
      "script-src 'self'; script-src-elem 'self'",
      `script-src 'self' ${VIEWER_ORIGIN}; script-src-elem 'self' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`
    ],
    [
      "a script-src beside default-src, which is left alone",
      "default-src 'none'; script-src 'self'",
      `default-src 'none'; script-src 'self' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`
    ],
    ["a script-src of 'none'", "script-src 'none'", `script-src ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`],
    ["only a default-src of 'none'", "default-src 'none'", `default-src 'none'; script-src ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`],
    ["a nonce without 'strict-dynamic'", "script-src 'nonce-theirs' 'self'", `script-src 'nonce-theirs' 'self' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`],
    [
      "'strict-dynamic', under which host sources are ignored",
      "script-src 'nonce-theirs' 'strict-dynamic'; object-src 'none'",
      `script-src 'nonce-theirs' 'strict-dynamic' ${VIEWER_ORIGIN} 'nonce-n0nce'; object-src 'none'; frame-ancestors ${HUB}`
    ],
    ["no script directive at all", "img-src 'self'", `img-src 'self'; frame-ancestors ${HUB}`],
    ["stray semicolons and spaces", " ;img-src  'self' ;; ", `img-src 'self'; frame-ancestors ${HUB}`],
    [
      "two policies, each enforced on its own",
      "script-src 'self', frame-ancestors 'self'; default-src https:",
      `script-src 'self' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}, default-src https:; script-src https: ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`
    ]
  ])("should rewrite a policy with %s", (_case, value, expected) => {
    expect(rewriteCsp(value, REWRITE)).toBe(expected);
  });

  it("should add no nonce under 'strict-dynamic' when it is given none", () => {
    expect(rewriteCsp("script-src 'strict-dynamic'", { frameAncestors: HUB, scriptOrigin: VIEWER_ORIGIN })).toBe(
      `script-src 'strict-dynamic' ${VIEWER_ORIGIN}; frame-ancestors ${HUB}`
    );
  });

  it("should keep upgrade-insecure-requests when the viewer is served over https", () => {
    expect(rewriteCsp("img-src 'self'; upgrade-insecure-requests", REWRITE)).toBe(`img-src 'self'; upgrade-insecure-requests; frame-ancestors ${HUB}`);
  });

  it("should drop upgrade-insecure-requests when the viewer is served over http", () => {
    expect(
      rewriteCsp("img-src 'self'; Upgrade-Insecure-Requests; script-src 'self'", {
        frameAncestors: "http://hub.localhost:3000",
        scriptOrigin: "http://viewer.hub.localhost:3000"
      })
    ).toBe("img-src 'self'; script-src 'self' http://viewer.hub.localhost:3000; frame-ancestors http://hub.localhost:3000");
  });
});

describe("transformHtml", () => {
  const SNIPPET = "<script></script>";

  it("should move the base and nothing else when there is nothing to inject", () => {
    expect(transformHtml('<head><base href="/"></head>', { prefix: PREFIX })).toBe(rewriteBaseHref('<head><base href="/"></head>', PREFIX));
  });

  it.each<[string, string, string]>([
    [
      "a head",
      '<!doctype html><html lang="en"><head data-x="1"><title>t</title>',
      `<!doctype html><html lang="en"><head data-x="1">${SNIPPET}<title>t</title>`
    ],
    ["a header but no head", "<html><body><header>h</header>", `<html>${SNIPPET}<body><header>h</header>`],
    ["only a doctype", "<!DOCTYPE html><title>t</title>", `<!DOCTYPE html>${SNIPPET}<title>t</title>`],
    ["no tags it knows", "<p>hi</p>", `${SNIPPET}<p>hi</p>`]
  ])("should put the snippet after the opening tag of a page with %s", (_case, html, expected) => {
    expect(transformHtml(html, { prefix: PREFIX, inject: SNIPPET })).toBe(expected);
  });

  it("should move the base and inject both", () => {
    expect(transformHtml('<head><base href="/app/">', { prefix: "/f/t", inject: SNIPPET })).toBe(`<head>${SNIPPET}<base href="/f/t/app/">`);
  });
});

describe("forwardedResponseHeaders for a feedback page", () => {
  it("should drop X-Frame-Options and let the hub alone frame the page when the prototype sets neither header", () => {
    const headers = forwardedResponseHeaders(new Headers({ "x-frame-options": "SAMEORIGIN" }), FEEDBACK);

    expect(headers.get("x-frame-options")).toBeNull();
    expect(headers.get("content-security-policy")).toBe(`frame-ancestors ${HUB}`);
    expect(headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("should rewrite the prototype's policy and its report-only twin", () => {
    const headers = forwardedResponseHeaders(
      new Headers({
        "content-security-policy": "frame-ancestors 'none'; script-src 'strict-dynamic' 'nonce-x'",
        "content-security-policy-report-only": "frame-ancestors 'self'"
      }),
      FEEDBACK
    );

    expect(headers.get("content-security-policy")).toBe(`script-src 'strict-dynamic' 'nonce-x' ${VIEWER_ORIGIN} 'nonce-n0nce'; frame-ancestors ${HUB}`);
    expect(headers.get("content-security-policy-report-only")).toBe(`frame-ancestors ${HUB}`);
  });

  it("should leave a port's framing headers as the pod sent them, for the viewer to replace", () => {
    const headers = forwardedResponseHeaders(new Headers({ "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" }), TARGET);

    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});

describe("forward for a feedback page", () => {
  it("should put the widget into an HTML page and say nothing of it", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response('<html><head><base href="/"></head></html>', { headers: { "content-type": "text/html" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), FEEDBACK, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://prototype.example/start", expect.anything());
    expect(await response.text()).toBe(`<html><head>${FEEDBACK.inject}<base href="/f/token/"></head></html>`);
    expect(response.headers.get("x-feedback-widget")).toBeNull();
  });

  it("should pass a page over the rewrite limit on unchanged and say the widget is absent", async () => {
    const page = `<head>${"x".repeat(BASE_REWRITE_LIMIT_BYTES)}`;
    const fetchImpl = vi.fn<Fetch>(async () => new Response(page, { headers: { "content-type": "text/html" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), FEEDBACK, fetchImpl);

    expect(await response.text()).toBe(page);
    expect(response.headers.get("x-feedback-widget")).toBe("absent");
  });

  it("should say the widget is absent from an HTML page in a charset it cannot rewrite", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => new Response("<head>", { headers: { "content-type": "text/html; charset=iso-8859-1" } }));

    const response = await forward(new Request("https://agent-hub-viewer.example/x"), FEEDBACK, fetchImpl);

    expect(await response.text()).toBe("<head>");
    expect(response.headers.get("x-feedback-widget")).toBe("absent");
  });

  it("should say nothing of the widget for an answer that is not a page, or a port's page over the limit", async () => {
    const json = vi.fn<Fetch>(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const big = vi.fn<Fetch>(async () => new Response("x".repeat(BASE_REWRITE_LIMIT_BYTES + 1), { headers: { "content-type": "text/html" } }));

    expect((await forward(new Request("https://agent-hub-viewer.example/x"), FEEDBACK, json)).headers.get("x-feedback-widget")).toBeNull();
    expect((await forward(new Request("https://agent-hub-viewer.example/x"), TARGET, big)).headers.get("x-feedback-widget")).toBeNull();
  });
});

describe("forwardedRequestHeaders for a feedback page", () => {
  const browser = {
    accept: "text/html",
    "accept-language": "en-GB",
    "user-agent": "Mozilla/5.0",
    "if-none-match": '"v1"',
    range: "bytes=0-99",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": "12",
    host: "agent-hub-viewer.example",
    authorization: "Bearer hub",
    origin: VIEWER_ORIGIN,
    referer: `${VIEWER_ORIGIN}/f/token/check?x=1`,
    forwarded: "for=203.0.113.9",
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-host": "agent-hub-viewer.example",
    "x-real-ip": "203.0.113.9",
    "x-azure-clientip": "203.0.113.9",
    "x-original-url": "/f/token/check",
    "x-agent-hub-viewer-url": "/f/token/check",
    "sec-fetch-site": "same-origin",
    cookie: "ahv-f-token=sealed; sid=1"
  };

  it("should send only the allowlisted headers, with the Referer moved onto the prototype", () => {
    expect(Object.fromEntries(forwardedRequestHeaders(new Headers(browser), FEEDBACK, "POST"))).toEqual({
      accept: "text/html",
      "accept-language": "en-GB",
      "user-agent": "Mozilla/5.0",
      "if-none-match": '"v1"',
      range: "bytes=0-99",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": "12",
      cookie: "sid=1",
      referer: "https://prototype.example/check?x=1",
      "x-forwarded-proto": "https",
      "x-forwarded-prefix": "/f/token"
    });
  });

  it("should send no Content-Length when the method carries no body", () => {
    expect(forwardedRequestHeaders(new Headers(browser), FEEDBACK, "GET").get("content-length")).toBeNull();
  });

  it.each([
    ["another page on the viewer", `${VIEWER_ORIGIN}/${ID}/8080/`],
    ["the hub", `${HUB}/hub`],
    ["a page that is not a URL", "not a url"]
  ])("should drop a Referer from %s", (_name, referer) => {
    expect(forwardedRequestHeaders(new Headers({ referer }), FEEDBACK).get("referer")).toBeNull();
  });

  it("should send the prototype's root as the Referer when it was the prefix itself", () => {
    expect(forwardedRequestHeaders(new Headers({ referer: `${VIEWER_ORIGIN}/f/token` }), FEEDBACK).get("referer")).toBe("https://prototype.example/");
  });

  it("should leave out __Host- and __Secure- cookies, which may be an agent's app's", () => {
    const headers = forwardedRequestHeaders(new Headers({ cookie: "__Host-sid=agent; __secure-csrf=agent; sid=1" }), FEEDBACK);

    expect(headers.get("cookie")).toBe("sid=1");
  });

  it("should still send a port its __Host- and __Secure- cookies", () => {
    expect(forwardedRequestHeaders(new Headers({ cookie: "__Host-sid=1; __Secure-csrf=2" }), TARGET).get("cookie")).toBe("__Host-sid=1; __Secure-csrf=2");
  });
});

describe("forwardedResponseHeaders cookies for a feedback page", () => {
  it("should drop a __Host- cookie the prototype sets and scope its others to the prefix", () => {
    const headers = forwardedResponseHeaders(
      new Headers([
        ["set-cookie", "__Host-sid=1; Path=/; Secure"],
        ["set-cookie", "__host-csrf=2; Secure"],
        ["set-cookie", "sid=3; Path=/"]
      ]),
      FEEDBACK
    );

    expect(headers.getSetCookie()).toEqual(["sid=3; Path=/f/token/"]);
  });

  it("should refuse a __Host- cookie from rewriteSetCookie only for a feedback page", () => {
    expect(rewriteSetCookie("__Host-sid=1; Secure", "/f/token", { feedback: true })).toBeUndefined();
    expect(rewriteSetCookie("__Host-sid=1; Secure", PREFIX)).toBe("__Host-sid=1; Secure; Path=/");
  });
});

describe("signInCookie", () => {
  it("should send a sign-in service only the cookies it set, under their own names", () => {
    expect(signInCookie("ahv-f-tok=grant; connect.sid=prototype; ahv-si-XSRF-TOKEN=t; ahv-si-Idam.UI=classic")).toBe("XSRF-TOKEN=t; Idam.UI=classic");
  });

  it("should send nothing when it has set nothing", () => {
    expect(signInCookie("connect.sid=prototype")).toBeUndefined();
    expect(signInCookie(null)).toBeUndefined();
  });
});

describe("rewriteLocation between a prototype and its sign-in service", () => {
  const routes = [{ origin: "https://idam.example", prefix: "/f/tok/_sign-in/idam.example" }];

  it("should move a redirect to a routed origin under that route's prefix, keeping its query", () => {
    expect(
      rewriteLocation("https://idam.example/o/authorize?redirect_uri=https%3A%2F%2Fproto.example%2Fcb", {
        upstreamOrigin: "https://proto.example",
        prefix: "/f/tok",
        routes
      })
    ).toBe("/f/tok/_sign-in/idam.example/o/authorize?redirect_uri=https%3A%2F%2Fproto.example%2Fcb");
  });

  it("should leave a redirect to an origin on another scheme or port than the route's alone", () => {
    expect(rewriteLocation("http://idam.example/login", { upstreamOrigin: "https://proto.example", prefix: "/f/tok", routes })).toBe(
      "http://idam.example/login"
    );
  });
});

describe("forwardedResponseHeaders for a sign-in service", () => {
  it("should keep the cookies it sets under the sign-in prefix and name", () => {
    const headers = forwardedResponseHeaders(new Headers([["set-cookie", "Idam.Session=s; Path=/; Secure; HttpOnly"]]), {
      upstreamOrigin: "https://idam.example",
      prefix: "/f/tok/_sign-in/idam.example",
      viewerOrigin: "https://agent-hub-viewer.example",
      feedback: true,
      signIn: true
    });
    expect(headers.getSetCookie()).toEqual(["ahv-si-Idam.Session=s; Path=/f/tok/_sign-in/idam.example/; Secure; HttpOnly"]);
  });
});

describe("a sign-in service's redirect back to the prototype", () => {
  const SIGN_IN = { upstreamOrigin: "https://idam.example", prefix: "/f/tok/_sign-in/idam.example" };
  const routes = [{ origin: "https://proto.example", prefix: "/f/tok", byHostname: true }];

  it.each(["http://proto.example/callback?code=c", "https://proto.example:8443/callback?code=c"])(
    "should move it under the link's prefix by hostname when it is %s",
    (location) => {
      expect(rewriteLocation(location, { ...SIGN_IN, routes })).toBe("/f/tok/callback?code=c");
    }
  );

  it("should leave a redirect to another host alone", () => {
    expect(rewriteLocation("http://elsewhere.example/callback", { ...SIGN_IN, routes })).toBe("http://elsewhere.example/callback");
  });
});

describe("a sign-in service's __Host- cookies", () => {
  const SIGN_IN = {
    upstreamOrigin: "https://idam.example",
    prefix: "/f/tok/_sign-in/idam.example",
    viewerOrigin: VIEWER_ORIGIN,
    feedback: true,
    signIn: true
  };

  it("should keep them under the sign-in prefix and name when a sign-in service sets them", () => {
    const headers = forwardedResponseHeaders(new Headers([["set-cookie", "__Host-Idam.Session=s; Path=/; Secure; HttpOnly"]]), SIGN_IN);

    expect(headers.getSetCookie()).toEqual(["ahv-si-__Host-Idam.Session=s; Path=/f/tok/_sign-in/idam.example/; Secure; HttpOnly"]);
  });

  it("should send them back under their own names when the sign-in service is asked", () => {
    expect(signInCookie("ahv-si-__Host-Idam.Session=s; __Host-sid=agent")).toBe("__Host-Idam.Session=s");
  });
});

describe("the Referer a feedback link's upstreams are sent from a sign-in page", () => {
  const SIGN_IN_PAGE = `${VIEWER_ORIGIN}/f/token/_sign-in/idam.example/login?client_id=c&state=s`;
  const SIGN_IN_ROUTE = { origin: "https://idam.example", prefix: "/f/token/_sign-in/idam.example" };

  it("should send the prototype no Referer when it comes from a sign-in page", () => {
    const headers = forwardedRequestHeaders(new Headers({ referer: SIGN_IN_PAGE }), { ...FEEDBACK, routes: [SIGN_IN_ROUTE] });

    expect(headers.get("referer")).toBeNull();
  });

  it("should send the prototype no Referer when it comes from a detected sign-in service's page, which is in no route", () => {
    const detected = `${VIEWER_ORIGIN}/f/token/_sign-in/sim.example/o/authorize?client_id=c&state=s`;

    expect(forwardedRequestHeaders(new Headers({ referer: detected }), FEEDBACK).get("referer")).toBeNull();
  });

  it("should send the sign-in service its own page as the Referer when it comes from that page", () => {
    const target: ForwardTarget = {
      ...FEEDBACK,
      upstreamOrigin: "https://idam.example",
      prefix: SIGN_IN_ROUTE.prefix,
      signIn: true,
      routes: [{ origin: "https://prototype.example", prefix: "/f/token", byHostname: true }]
    };

    expect(forwardedRequestHeaders(new Headers({ referer: SIGN_IN_PAGE }), target).get("referer")).toBe("https://idam.example/login?client_id=c&state=s");
  });
});
