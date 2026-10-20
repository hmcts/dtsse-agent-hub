import { describe, expect, it } from "vitest";
import { landingPath, parseViewerPath, portOf, ticketPath, viewerCookieName, viewerPrefix, viewerUrl } from "./paths.ts";

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

  it.each([
    "/",
    "/favicon.ico",
    `/${ID}`,
    `/not-a-uuid/8080/`,
    `/${ID.toUpperCase()}/8080/`,
    `/${ID}/80/`,
    `/${ID}/08080/`,
    "/_auth/extra"
  ])("should match nothing when the path is %s", (path) => {
    expect(parseViewerPath(path)).toEqual({ kind: "none" });
  });
});

describe("the names a port is known by", () => {
  it("should give its prefix, URL, cookie and the hub's ticket page", () => {
    expect(viewerPrefix(ID, 8080)).toBe(`/${ID}/8080`);
    expect(viewerUrl("viewer.example", ID, 8080)).toBe(`https://viewer.example/${ID}/8080/`);
    expect(viewerCookieName(ID, 8080)).toBe(`ahv-${ID}-8080`);
    expect(ticketPath(ID, 8080, "/docs?page=2")).toBe(`/hub/virtual/${ID}/ports/8080?path=%2Fdocs%3Fpage%3D2`);
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
