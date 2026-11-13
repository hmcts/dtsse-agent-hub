import { describe, expect, it, vi } from "vitest";
import { probeTarget } from "./probe.ts";

const PUBLIC = async () => true;
const ENV = { NODE_ENV: "test" };

function answering(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response);
  }
  return fetch;
}

const probe = (url: string, fetch: typeof globalThis.fetch, resolves = PUBLIC) =>
  probeTarget(url, { fetch, resolvesPublic: resolves, env: ENV, timeoutMs: 50 });

describe("probeTarget", () => {
  it("should pass a prototype that answers its address, asking with HEAD and never following a redirect", async () => {
    const fetch = answering(new Response(null, { status: 200 }));

    expect(await probe("https://proto.example.com/start", fetch)).toEqual({ result: "pass", status: 200, reason: "it answered 200" });
    expect(fetch).toHaveBeenCalledWith(new URL("https://proto.example.com/start"), expect.objectContaining({ method: "HEAD", redirect: "manual" }));
  });

  it("should ask again with GET when the prototype refuses HEAD", async () => {
    const fetch = answering(new Response(null, { status: 405 }), new Response("page", { status: 200 }));

    expect((await probe("https://proto.example.com/", fetch)).result).toBe("pass");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("should refuse an address no link may point at without asking it anything", async () => {
    const fetch = answering();

    expect(await probe("http://proto.example.com/", fetch)).toEqual({ result: "refused", reason: "the address must be https" });
    expect(await probe("https://localhost/", fetch)).toEqual({ result: "refused", reason: "the address must be on the public internet" });
    expect(await probe("https://proto.example.com/", fetch, async () => false)).toEqual({
      result: "refused",
      reason: "the address does not resolve to the public internet"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should pass a redirect on the prototype's own site, and warn of one to another", async () => {
    expect(await probe("https://proto.example.com/", answering(new Response(null, { status: 302, headers: { location: "/start" } })))).toEqual({
      result: "pass",
      status: 302,
      reason: "it redirects to /start, which reviewers will follow"
    });
    const away = await probe("https://proto.example.com/", answering(new Response(null, { status: 301, headers: { location: "https://login.example.org/" } })));
    expect(away).toMatchObject({ result: "warn", status: 301 });
    expect(away.reason).toContain("https://login.example.org");
    expect(await probe("https://proto.example.com/", answering(new Response(null, { status: 307 })))).toMatchObject({ result: "warn", status: 307 });
  });

  it.each([
    [401, "asks for a sign-in"],
    [404, "answered 404"],
    [503, "answered 503"]
  ])("should warn of a %d without stopping the wizard", async (status, words) => {
    const outcome = await probe("https://proto.example.com/", answering(new Response(null, { status })));

    expect(outcome).toMatchObject({ result: "warn", status });
    expect(outcome.reason).toContain(words);
  });

  it("should warn of a prototype that cannot be reached or does not answer in time", async () => {
    const down = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const slow = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Object.assign(new Error("timed out"), { name: "TimeoutError" }));

    expect(await probe("https://proto.example.com/", down)).toEqual({ result: "warn", status: null, reason: "it could not be reached from the hub" });
    expect(await probe("https://proto.example.com/", slow)).toEqual({ result: "warn", status: null, reason: "it did not answer within 0.05 seconds" });
  });

  it("should use the real resolver and fetch when given nothing", async () => {
    expect(await probeTarget("not a url")).toEqual({ result: "refused", reason: "that is not a web address" });
  });
});
