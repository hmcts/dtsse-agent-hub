import { describe, expect, it, vi } from "vitest";
import { allowPrivateTargets, cachedResolvesPublic, checkTargetUrl, isPrivateAddress, type Lookup, RESOLVE_CACHE_MS, resolvesPublic } from "./targets.ts";

const PRODUCTION = { NODE_ENV: "production" };
const RELAXED = { NODE_ENV: "development", FEEDBACK_ALLOW_PRIVATE_TARGETS: "true" };

function lookupGiving(...addresses: string[]): Lookup {
  return vi.fn<Lookup>(async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "168.63.129.16",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "not an address"
  ])("should call %s private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "20.26.1.1", "100.128.0.1", "172.32.0.1", "::ffff:8.8.8.8", "::ffff:808:808", "2606:4700:4700::1111", "2a01:111:f400::1"])(
    "should call %s public",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );
});

describe("allowPrivateTargets", () => {
  it("should allow private targets only when asked and not in production", () => {
    expect(allowPrivateTargets(RELAXED)).toBe(true);
    expect(allowPrivateTargets({ ...RELAXED, NODE_ENV: "production" })).toBe(false);
    expect(allowPrivateTargets({ NODE_ENV: "development", FEEDBACK_ALLOW_PRIVATE_TARGETS: "1" })).toBe(false);
    expect(allowPrivateTargets({})).toBe(false);
  });
});

describe("checkTargetUrl", () => {
  it("should accept an https URL on the default port and give its origin and bare hostname", () => {
    const check = checkTargetUrl("https://Prototype.HerokuApp.com:443/start?x=1", PRODUCTION);

    expect(check).toMatchObject({ ok: true, origin: "https://prototype.herokuapp.com", hostname: "prototype.herokuapp.com" });
  });

  it("should accept a public IP literal", () => {
    expect(checkTargetUrl("https://8.8.8.8/", PRODUCTION).ok).toBe(true);
  });

  it.each([
    ["not a URL", "prototype.example"],
    ["plain http", "http://prototype.example/"],
    ["another scheme", "ftp://prototype.example/"],
    ["a user name", "https://user@prototype.example/"],
    ["a password", "https://user:pass@prototype.example/"],
    ["a port of its own", "https://prototype.example:8443/"],
    ["localhost", "https://localhost/"],
    ["localhost with a trailing dot", "https://localhost./"],
    ["a name under localhost", "https://app.localhost/"],
    ["a single-label name the cluster's search domains complete", "https://dtsse-agent-hub/"],
    ["an mDNS name", "https://printer.local/"],
    ["an internal name", "https://metadata.google.internal/"],
    ["a cluster service", "https://api.default.svc.cluster.local/"],
    ["a short cluster service", "https://api.default.svc/"],
    ["loopback", "https://127.0.0.1/"],
    ["loopback spelt in hex", "https://0x7f.1/"],
    ["the metadata service", "https://169.254.169.254/"],
    ["a private network", "https://10.0.0.1/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["a unique local IPv6 address", "https://[fd00::1]/"]
  ])("should refuse %s", (_case, value) => {
    expect(checkTargetUrl(value, PRODUCTION).ok).toBe(false);
  });

  it("should allow http, any port and private hosts when private targets are allowed, but never credentials", () => {
    expect(checkTargetUrl("http://localhost:3000/", RELAXED)).toMatchObject({ ok: true, origin: "http://localhost:3000", hostname: "localhost" });
    expect(checkTargetUrl("https://10.0.0.1:8443/", RELAXED).ok).toBe(true);
    expect(checkTargetUrl("http://user:pass@localhost:3000/", RELAXED).ok).toBe(false);
    expect(checkTargetUrl("ftp://localhost/", RELAXED).ok).toBe(false);
  });

  it("should say why it refused", () => {
    expect(checkTargetUrl("http://prototype.example/", PRODUCTION)).toEqual({ ok: false, reason: "must be https" });
  });
});

describe("resolvesPublic", () => {
  it("should accept a name whose every address is public", async () => {
    const lookup = lookupGiving("8.8.8.8", "2606:4700:4700::1111");

    expect(await resolvesPublic("prototype.example", lookup, PRODUCTION)).toBe(true);
    expect(lookup).toHaveBeenCalledWith("prototype.example", { all: true, verbatim: true });
  });

  it("should refuse a name when any one of its addresses is private", async () => {
    expect(await resolvesPublic("rebound.example", lookupGiving("8.8.8.8", "169.254.169.254"), PRODUCTION)).toBe(false);
    expect(await resolvesPublic("rebound.example", lookupGiving("::ffff:10.0.0.1"), PRODUCTION)).toBe(false);
  });

  it("should refuse a name that resolves to nothing or does not resolve", async () => {
    const failing = vi.fn<Lookup>(async () => {
      throw new Error("ENOTFOUND");
    });

    expect(await resolvesPublic("nowhere.example", lookupGiving(), PRODUCTION)).toBe(false);
    expect(await resolvesPublic("nowhere.example", failing, PRODUCTION)).toBe(false);
  });

  it("should judge an IP literal without resolving it", async () => {
    const lookup = lookupGiving("8.8.8.8");

    expect(await resolvesPublic("127.0.0.1", lookup, PRODUCTION)).toBe(false);
    expect(await resolvesPublic("8.8.8.8", lookup, PRODUCTION)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("should accept anything without resolving it when private targets are allowed", async () => {
    const lookup = lookupGiving("127.0.0.1");

    expect(await resolvesPublic("localhost", lookup, RELAXED)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("cachedResolvesPublic", () => {
  it("should resolve a name once within the cache's lifetime and again after it", async () => {
    let clock = 0;
    const resolve = vi.fn(async (hostname: string) => hostname === "public.example");
    const check = cachedResolvesPublic(resolve, () => clock);

    expect(await check("public.example")).toBe(true);
    expect(await check("public.example")).toBe(true);
    expect(await check("private.example")).toBe(false);
    expect(await check("private.example")).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);

    clock = RESOLVE_CACHE_MS;

    expect(await check("public.example")).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("should start again rather than grow without bound when it holds many names", async () => {
    const resolve = vi.fn(async () => true);
    const check = cachedResolvesPublic(resolve, () => 0);

    for (let i = 0; i <= 1_000; i++) {
      await check(`host-${i}.example`);
    }
    await check("host-0.example");

    expect(resolve).toHaveBeenCalledTimes(1_002);
  });

  it("should resolve through resolvesPublic by default", async () => {
    vi.stubEnv("FEEDBACK_ALLOW_PRIVATE_TARGETS", "");

    expect(await cachedResolvesPublic()("127.0.0.1")).toBe(false);

    vi.unstubAllEnvs();
  });
});
