import { describe, expect, it } from "vitest";
import {
  feedbackCookieName,
  feedbackPrefix,
  isFeedbackPath,
  LAST_PORT_COOKIE,
  landingPath,
  lastFeedbackCookie,
  lastPortCookie,
  lastPortTarget,
  parseViewerPath,
  portOf,
  refererTarget,
  reviewPath,
  signInPathOf,
  signInPrefix,
  ticketPath,
  viewerCookieName,
  viewerPrefix,
  viewerUrl
} from "./paths.ts";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("portOf", () => {
  it.each([
    ["8080", 8080],
    ["1024", 1024],
    ["65535", 65535],
    ["1023", undefined],
    ["65536", undefined],
    ["08080", undefined],
    ["80a", undefined],
    ["", undefined]
  ])("should read %j as %j", (value, port) => {
    expect(portOf(value)).toBe(port);
  });
});

describe("parseViewerPath", () => {
  it("should read the ticket exchange when the path is /_auth", () => {
    expect(parseViewerPath("/_auth?ticket=abc")).toEqual({ kind: "auth", ticket: "abc" });
    expect(parseViewerPath("/_auth")).toEqual({ kind: "auth", ticket: null });
  });

  it("should split a port's path into the agent, the port, the rest and the query when it is under a prefix", () => {
    expect(parseViewerPath(`/${ID}/8080/docs/?page=2`)).toEqual({ kind: "port", virtualAgentId: ID, port: 8080, rest: "/docs/", search: "?page=2" });
    expect(parseViewerPath(`/${ID}/8080/`)).toEqual({ kind: "port", virtualAgentId: ID, port: 8080, rest: "/", search: "" });
  });

  it("should say the prefix is bare when nothing follows the port, not even a slash", () => {
    expect(parseViewerPath(`/${ID}/8080?x=1`)).toEqual({ kind: "bare-port", virtualAgentId: ID, port: 8080, search: "?x=1" });
  });

  it.each(["/", "/favicon.ico", `/${ID}`, `/not-a-uuid/8080/`, `/${ID.toUpperCase()}/8080/`, `/${ID}/80/`, `/${ID}/08080/`, "/_auth/extra"])(
    "should match nothing when the path is %s",
    (path) => {
      expect(parseViewerPath(path)).toEqual({ kind: "none" });
    }
  );
});

describe("the names a port is known by", () => {
  it("should give its prefix, URL, cookie and the hub's ticket page", () => {
    expect(viewerPrefix(ID, 8080)).toBe(`/${ID}/8080`);
    expect(viewerUrl("viewer.example", ID, 8080)).toBe(`https://viewer.example/${ID}/8080/`);
    expect(viewerCookieName(ID, 8080)).toBe(`ahv-${ID}-8080`);
    expect(ticketPath(ID, 8080, "/docs?page=2")).toBe(`/assistant/ports/${ID}/8080?path=%2Fdocs%3Fpage%3D2`);
  });
});

describe("landingPath", () => {
  it.each([
    ["/docs?page=2", "/docs?page=2"],
    [null, "/"],
    ["", "/"],
    ["docs", "/"],
    ["//evil.example/", "/"],
    ["/\\evil.example/", "/"],
    ["/docs\nSet-Cookie: x=1", "/"]
  ])("should land %j at %j", (value, path) => {
    expect(landingPath(value)).toBe(path);
  });
});

describe("refererTarget", () => {
  const HOST = "agent-hub-viewer.example";
  const ORIGIN = `https://${HOST}`;
  const PAGE = `https://${HOST}/${ID}/8080/dashboard?tab=1`;

  it("should move a root-relative path, query and all, under the prefix of the page that asked for it", () => {
    expect(refererTarget(PAGE, ORIGIN, "/style.css")).toBe(`/${ID}/8080/style.css`);
    expect(refererTarget(PAGE, ORIGIN, "/api?x=1")).toBe(`/${ID}/8080/api?x=1`);
    expect(refererTarget(`https://${HOST}/${ID}/8080`, ORIGIN, "/")).toBe(`/${ID}/8080/`);
    expect(refererTarget(`http://${HOST}:3000/${ID}/8080/`, `http://${HOST}:3000`, "/app.js")).toBe(`/${ID}/8080/app.js`);
  });

  it.each<[string, string | null, string]>([
    ["no Referer", null, "/style.css"],
    ["a Referer that is not a URL", "not a url", "/style.css"],
    ["a page on another host", `https://agent-hub.example/${ID}/8080/`, "/style.css"],
    ["a page on another port", `https://${HOST}:8443/${ID}/8080/`, "/style.css"],
    ["a page over http", `http://${HOST}/${ID}/8080/`, "/style.css"],
    ["a page outside every prefix", `https://${HOST}/`, "/style.css"],
    ["the viewer's own ticket exchange", PAGE, "/_auth?ticket=x"],
    ["a scheme-relative path", PAGE, "//evil.example/"]
  ])("should leave nothing to redirect for %s", (_case, referer, path) => {
    expect(refererTarget(referer, ORIGIN, path)).toBeUndefined();
  });
});

describe("the last port's cookie", () => {
  it("should name the port across the viewer's whole host, for as long as asked", () => {
    expect(lastPortCookie(ID, 8080, 60)).toBe(`${LAST_PORT_COOKIE}=${ID}/8080; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`);
  });

  it("should send a root-relative path under the port it names", () => {
    expect(lastPortTarget(`${ID}/8080`, "/aggregated/caseworkers/:uid/jurisdictions?access=read")).toBe(
      `/${ID}/8080/aggregated/caseworkers/:uid/jurisdictions?access=read`
    );
  });

  it.each<[string, string | undefined, string]>([
    ["no cookie", undefined, "/cases"],
    ["a value that names no port", "nonsense", "/cases"],
    ["an id that is not a uuid", "abc/8080", "/cases"],
    ["a port below 1024", `${ID}/80`, "/cases"],
    ["the viewer's own ticket exchange", `${ID}/8080`, "/_auth?ticket=x"],
    ["a scheme-relative path", `${ID}/8080`, "//evil.example/"]
  ])("should leave nothing to redirect for %s", (_case, value, path) => {
    expect(lastPortTarget(value, path)).toBeUndefined();
  });
});

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const HOST = "agent-hub-viewer.example";
const ORIGIN = `https://${HOST}`;

describe("feedback paths", () => {
  it("should read the widget's own path outside every prefix", () => {
    expect(parseViewerPath("/_feedback/widget.js?v=1")).toEqual({ kind: "widget" });
  });

  it("should split a feedback link's path into its token, the rest and the query", () => {
    expect(parseViewerPath(`/f/${TOKEN}/start/page?x=1`)).toEqual({ kind: "feedback", token: TOKEN, rest: "/start/page", search: "?x=1" });
    expect(parseViewerPath(`/f/${TOKEN}?x=1`)).toEqual({ kind: "bare-feedback", token: TOKEN, search: "?x=1" });
  });

  it.each(["/f/short/", "/f/", "/f", `/F/${TOKEN}/`, `/f/${TOKEN}!/`, "/_feedback/widget.js/x"])("should match nothing when the path is %s", (path) => {
    expect(parseViewerPath(path)).toEqual({ kind: "none" });
  });

  it("should give a link's prefix, cookie and the hub's review page", () => {
    expect(feedbackPrefix(TOKEN)).toBe(`/f/${TOKEN}`);
    expect(feedbackCookieName(TOKEN)).toBe(`ahv-f-${TOKEN}`);
    expect(reviewPath(TOKEN, "/start?x=1")).toBe(`/review/${TOKEN}?path=%2Fstart%3Fx%3D1`);
  });

  it.each<[string, boolean]>([
    [`/f/${TOKEN}/`, true],
    ["/f", true],
    ["/f/", true],
    ["/favicon.ico", false],
    ["/fx/", false],
    [`/${ID}/8080/`, false]
  ])("should say whether %s is a feedback path", (path, expected) => {
    expect(isFeedbackPath(path)).toBe(expected);
  });

  it("should move a root-relative path from a feedback link's page under its prefix", () => {
    expect(refererTarget(`https://${HOST}/f/${TOKEN}/start`, ORIGIN, "/assets/app.css")).toBe(`/f/${TOKEN}/assets/app.css`);
    expect(refererTarget(`https://${HOST}/f/${TOKEN}`, ORIGIN, "/next?x=1")).toBe(`/f/${TOKEN}/next?x=1`);
  });

  it.each(["/_feedback/widget.js", "/_feedback/widget.js?v=2", "/_auth?ticket=x"])("should never treat the viewer's own %s as a page's", (path) => {
    expect(refererTarget(`https://${HOST}/f/${TOKEN}/start`, ORIGIN, path)).toBeUndefined();
    expect(refererTarget(`https://${HOST}/${ID}/8080/`, ORIGIN, path)).toBeUndefined();
    expect(lastPortTarget(`f/${TOKEN}`, path)).toBeUndefined();
  });

  it("should name a feedback link in the last page's cookie and send root-relative paths under it", () => {
    expect(lastFeedbackCookie(TOKEN, 60)).toBe(`${LAST_PORT_COOKIE}=f/${TOKEN}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`);
    expect(lastPortTarget(`f/${TOKEN}`, "/cases")).toBe(`/f/${TOKEN}/cases`);
    expect(lastPortTarget("f/short", "/cases")).toBeUndefined();
  });
});

describe("sign-in paths", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";

  it("should name a sign-in service by its host, with its port when it has one", () => {
    expect(signInPrefix(TOKEN, "idam.example")).toBe(`/f/${TOKEN}/_sign-in/idam.example`);
    expect(signInPathOf("/_sign-in/localhost:5062/o/authorize?x=1")).toEqual({ host: "localhost:5062", rest: "/o/authorize?x=1" });
    expect(signInPathOf("/_sign-in/idam.example")).toEqual({ host: "idam.example", rest: "/" });
  });

  it("should not read a sign-in service from any other path", () => {
    expect(signInPathOf("/start")).toBeUndefined();
    expect(signInPathOf("/_sign-in/")).toBeUndefined();
    expect(signInPathOf("/x/_sign-in/idam.example/")).toBeUndefined();
  });

  it("should send a root-relative request from a sign-in page under the sign-in prefix", () => {
    const viewer = "https://agent-hub-viewer.example";
    expect(refererTarget(`${viewer}/f/${TOKEN}/_sign-in/idam.example/login`, viewer, "/assets/app.css", ["idam.example"])).toBe(
      `/f/${TOKEN}/_sign-in/idam.example/assets/app.css`
    );
  });

  it("should send a root-relative request from a sign-in path under the link's prefix when its host is not a sign-in service", () => {
    const viewer = "https://agent-hub-viewer.example";
    expect(refererTarget(`${viewer}/f/${TOKEN}/_sign-in/other.example/page`, viewer, "/assets/app.css", ["idam.example"])).toBe(`/f/${TOKEN}/assets/app.css`);
  });
});
