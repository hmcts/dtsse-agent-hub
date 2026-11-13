import type { LookupOptions } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowPrivateTargets,
  cachedPublicAddresses,
  checkTargetUrl,
  isPrivateAddress,
  type Lookup,
  pinnedFetch,
  pinnedLookup,
  publicAddresses,
  RESOLVE_CACHE_MS,
  type Resolve,
  UnreachableTarget
} from "./targets.ts";

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

describe("publicAddresses", () => {
  it("should give every address of a name whose every address is public", async () => {
    const lookup = lookupGiving("8.8.8.8", "2606:4700:4700::1111");

    expect(await publicAddresses("prototype.example", lookup, PRODUCTION)).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
    expect(lookup).toHaveBeenCalledWith("prototype.example", { all: true, verbatim: true });
  });

  it("should give none when any one of a name's addresses is private", async () => {
    expect(await publicAddresses("rebound.example", lookupGiving("8.8.8.8", "169.254.169.254"), PRODUCTION)).toEqual([]);
    expect(await publicAddresses("rebound.example", lookupGiving("::ffff:10.0.0.1"), PRODUCTION)).toEqual([]);
  });

  it("should give none for a name that resolves to nothing or does not resolve", async () => {
    const failing = vi.fn<Lookup>(async () => {
      throw new Error("ENOTFOUND");
    });

    expect(await publicAddresses("nowhere.example", lookupGiving(), PRODUCTION)).toEqual([]);
    expect(await publicAddresses("nowhere.example", failing, PRODUCTION)).toEqual([]);
  });

  it("should judge an IP literal without resolving it", async () => {
    const lookup = lookupGiving("8.8.8.8");

    expect(await publicAddresses("127.0.0.1", lookup, PRODUCTION)).toEqual([]);
    expect(await publicAddresses("8.8.8.8", lookup, PRODUCTION)).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("should give none for a local or cluster name without resolving it", async () => {
    const lookup = lookupGiving("8.8.8.8");

    expect(await publicAddresses("localhost", lookup, PRODUCTION)).toEqual([]);
    expect(await publicAddresses("api.default.svc.cluster.local", lookup, PRODUCTION)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("should give private addresses unchecked when private targets are allowed", async () => {
    expect(await publicAddresses("localhost", lookupGiving("127.0.0.1"), RELAXED)).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(await publicAddresses("10.0.0.1", lookupGiving(), RELAXED)).toEqual([{ address: "10.0.0.1", family: 4 }]);
  });
});

describe("cachedPublicAddresses", () => {
  const PUBLIC = [{ address: "8.8.8.8", family: 4 }];

  it("should resolve a name once within the cache's lifetime and again after it", async () => {
    let clock = 0;
    const resolve = vi.fn<Resolve>(async (hostname) => (hostname === "public.example" ? PUBLIC : []));
    const check = cachedPublicAddresses(resolve, () => clock);

    expect(await check("public.example")).toEqual(PUBLIC);
    expect(await check("public.example")).toEqual(PUBLIC);
    expect(await check("private.example")).toEqual([]);
    expect(await check("private.example")).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);

    clock = RESOLVE_CACHE_MS;

    expect(await check("public.example")).toEqual(PUBLIC);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("should start again rather than grow without bound when it holds many names", async () => {
    const resolve = vi.fn<Resolve>(async () => PUBLIC);
    const check = cachedPublicAddresses(resolve, () => 0);

    for (let i = 0; i <= 1_000; i++) {
      await check(`host-${i}.example`);
    }
    await check("host-0.example");

    expect(resolve).toHaveBeenCalledTimes(1_002);
  });

  it("should resolve through publicAddresses by default", async () => {
    vi.stubEnv("FEEDBACK_ALLOW_PRIVATE_TARGETS", "");

    expect(await cachedPublicAddresses()("127.0.0.1")).toEqual([]);

    vi.unstubAllEnvs();
  });
});

/** What a socket would connect to: the answer `pinnedLookup` gives for `hostname`. */
function lookedUp(lookup: LookupFunction, hostname: string, options: LookupOptions = { all: true }) {
  return new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((done) => {
    lookup(hostname, options, (error, address, family) => done({ error, address, family }));
  });
}

/** A resolver that answers with a public address the first time it is asked and the metadata service after. */
function rebinding(): Lookup {
  return vi
    .fn<Lookup>()
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
}

describe("pinnedLookup", () => {
  it("should connect only to the address the check passed when the name resolves privately the second time", async () => {
    const lookup = rebinding();
    const resolve = cachedPublicAddresses(
      (hostname) => publicAddresses(hostname, lookup, PRODUCTION),
      () => 0
    );

    expect(await resolve("rebind.example")).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(await lookedUp(pinnedLookup(resolve), "rebind.example")).toEqual({ error: null, address: [{ address: "8.8.8.8", family: 4 }], family: undefined });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("should check the name again and connect nowhere when its kept answer has expired and it now resolves privately", async () => {
    let clock = 0;
    const lookup = rebinding();
    const resolve = cachedPublicAddresses(
      (hostname) => publicAddresses(hostname, lookup, PRODUCTION),
      () => clock
    );
    await resolve("rebind.example");
    clock = RESOLVE_CACHE_MS;

    const answer = await lookedUp(pinnedLookup(resolve), "rebind.example");

    expect(answer.error).toBeInstanceOf(UnreachableTarget);
    expect(answer.error?.code).toBe("ENOTFOUND");
    expect(answer.address).toBe("");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("should connect nowhere when any one of the name's addresses is private", async () => {
    const resolve: Resolve = (hostname) => publicAddresses(hostname, lookupGiving("8.8.8.8", "10.0.0.1"), PRODUCTION);

    expect((await lookedUp(pinnedLookup(resolve), "mixed.example")).error).toBeInstanceOf(UnreachableTarget);
  });

  it("should give one address of the family asked for when not asked for all", async () => {
    const resolve: Resolve = async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 }
    ];
    const lookup = pinnedLookup(resolve);

    expect(await lookedUp(lookup, "both.example", { family: 4 })).toEqual({ error: null, address: "8.8.8.8", family: 4 });
    expect(await lookedUp(lookup, "both.example", { family: "IPv6" })).toEqual({ error: null, address: "2606:4700:4700::1111", family: 6 });
    expect(await lookedUp(lookup, "both.example", { family: "IPv4", all: true })).toMatchObject({ address: [{ address: "8.8.8.8", family: 4 }] });
    expect(await lookedUp(lookup, "both.example", {})).toEqual({ error: null, address: "2606:4700:4700::1111", family: 6 });
  });

  it("should resolve the name as checked, without a trailing dot and in lower case", async () => {
    const resolve = vi.fn<Resolve>(async () => [{ address: "8.8.8.8", family: 4 }]);

    await lookedUp(pinnedLookup(resolve), "Prototype.Example.");

    expect(resolve).toHaveBeenCalledWith("prototype.example");
  });

  it("should hand on a resolver's failure as the connection's error", async () => {
    const broken = new Error("resolver down");

    expect(
      (
        await lookedUp(
          pinnedLookup(async () => Promise.reject(broken)),
          "a.example"
        )
      ).error
    ).toBe(broken);
    expect(
      (
        await lookedUp(
          pinnedLookup(async () => Promise.reject("odd")),
          "a.example"
        )
      ).error
    ).toBeInstanceOf(UnreachableTarget);
  });
});

describe("pinnedFetch", () => {
  let server: Server;
  let port: number;
  let connections: number;

  beforeEach(async () => {
    connections = 0;
    server = createServer((request, response) => {
      if (request.url === "/moved") {
        response.writeHead(302, { location: "https://elsewhere.example/" }).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => response.end(`${request.method} ${request.headers.host} ${Buffer.concat(chunks).toString()}`));
    });
    server.on("connection", () => {
      connections++;
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });

  const LOOPBACK = [{ address: "127.0.0.1", family: 4 }];

  it("should connect to the address it was given for the name, keeping the name as the request's host", async () => {
    const resolve = vi.fn<Resolve>(async (hostname) => (hostname === "prototype.example" ? LOOPBACK : []));

    const response = await pinnedFetch(resolve)(`http://prototype.example:${port}/page`);

    expect(await response.text()).toBe(`GET prototype.example:${port} `);
    expect(resolve).toHaveBeenCalledWith("prototype.example");
  });

  it("should stream a request body and hand back a redirect without following it", async () => {
    const fetch = pinnedFetch(async () => LOOPBACK);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a=1"));
        controller.close();
      }
    });

    const posted = await fetch(`http://prototype.example:${port}/form`, { method: "POST", body, duplex: "half" });
    const moved = await fetch(new URL(`http://prototype.example:${port}/moved`), { redirect: "manual" });

    expect(await posted.text()).toBe(`POST prototype.example:${port} a=1`);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("https://elsewhere.example/");
  });

  it("should not connect at all when the name has no address it may connect to", async () => {
    await expect(pinnedFetch(async () => [])(`http://rebound.example:${port}/`)).rejects.toThrow();

    expect(connections).toBe(0);
  });

  it("should check an IP literal before connecting to it", async () => {
    const resolve = vi.fn<Resolve>(async () => []);

    await expect(pinnedFetch(resolve)(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(resolve).toHaveBeenCalledWith("127.0.0.1");
    expect(connections).toBe(0);

    const allowed = await pinnedFetch(async () => LOOPBACK)(`http://127.0.0.1:${port}/`);

    expect(await allowed.text()).toBe(`GET 127.0.0.1:${port} `);
  });

  it("should hand on a resolver's failure for an IP literal without connecting", async () => {
    await expect(pinnedFetch(async () => Promise.reject(new Error("resolver down")))(`http://127.0.0.1:${port}/`)).rejects.toThrow();

    expect(connections).toBe(0);
  });

  it("should reach a prototype on localhost when private targets are allowed, and refuse it in production", async () => {
    const lookup = lookupGiving("127.0.0.1");
    const relaxed = pinnedFetch((hostname) => publicAddresses(hostname, lookup, RELAXED));
    const production = pinnedFetch((hostname) => publicAddresses(hostname, lookup, PRODUCTION));

    expect((await relaxed(`http://localhost:${port}/`)).status).toBe(200);
    expect(connections).toBe(1);

    await expect(production(`http://localhost:${port}/`)).rejects.toThrow();
    expect(connections).toBe(1);
  });
});
