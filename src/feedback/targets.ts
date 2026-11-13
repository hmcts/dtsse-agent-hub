import { promises as dns, type LookupOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from "undici";
import type { Environment } from "../auth/settings.ts";

/**
 * Which prototype addresses the hub may fetch on a reviewer's behalf. The viewer fetches from inside the cluster, so
 * an address that names the cluster, the node, the pod network or the cloud's metadata service would hand anyone who
 * can make a feedback link a way to read them. Checked when a link is saved and again before every fetch, since what
 * a name resolves to can change after it was saved, and every connection a fetch makes is to an address that passed,
 * since a name can resolve one way for the check and another for the connection.
 */

/** The addresses no prototype is on: everything that is not the public internet, as IANA's special-purpose registries list it. */
function privateRanges(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    // Carrier-grade NAT, which AKS uses for its pod and service networks.
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    // Link-local, which holds the instance metadata service at 169.254.169.254.
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  // Azure's wire server, which every VM can reach and which answers the platform's own agents.
  list.addAddress("168.63.129.16", "ipv4");
  for (const [network, prefix] of [
    ["::", 96],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

const PRIVATE = privateRanges();

/**
 * Whether an IP address is outside the public internet. An IPv4-mapped IPv6 address, `::ffff:a.b.c.d`, is checked as
 * the IPv4 address it carries, which is what a socket connecting to it reaches.
 */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (mapped !== null) {
    const v4 =
      mapped[1] ??
      [
        Number.parseInt(mapped[2]!, 16) >> 8,
        Number.parseInt(mapped[2]!, 16) & 255,
        Number.parseInt(mapped[3]!, 16) >> 8,
        Number.parseInt(mapped[3]!, 16) & 255
      ].join(".");
    return isPrivateAddress(v4);
  }
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  return PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Names that only ever mean something inside a network: a single label, which the pod's resolver completes with the
 * cluster's search domains, and the suffixes reserved for local and cluster names.
 */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".svc", ".cluster.local"];

function isPrivateName(hostname: string): boolean {
  return hostname === "localhost" || !hostname.includes(".") || PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/** A URL's hostname as a resolver or socket takes it: without IPv6 brackets or a trailing dot, in lower case. */
function bareHostname(url: URL): string {
  return url.hostname
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * `FEEDBACK_ALLOW_PRIVATE_TARGETS=true`, for trying a prototype running on the developer's own machine. Never in
 * production, whatever it is set to: there it would open the cluster to every link's owner.
 */
export function allowPrivateTargets(env: Environment = process.env): boolean {
  return env.FEEDBACK_ALLOW_PRIVATE_TARGETS === "true" && env.NODE_ENV !== "production";
}

export type TargetCheck = { ok: true; url: URL; origin: string; hostname: string } | { ok: false; reason: string };

/**
 * Whether `value` is an address a feedback link may point at, judged on the URL alone: `https` on its default port,
 * no user name or password, and a host that is neither a private IP address nor a local or cluster name. With
 * `allowPrivateTargets`, `http`, any port and private hosts are allowed too; credentials never are, since the hub
 * would send them on every reviewer's behalf.
 */
export function checkTargetUrl(value: string, env: Environment = process.env): TargetCheck {
  if (!URL.canParse(value)) {
    return { ok: false, reason: "not a URL" };
  }
  const url = new URL(value);
  const relaxed = allowPrivateTargets(env);
  if (url.protocol !== "https:" && !(relaxed && url.protocol === "http:")) {
    return { ok: false, reason: "must be https" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "must not carry a user name or password" };
  }
  // `URL` leaves the port empty when it is the scheme's default, so for https this is 443 whether written or not.
  if (url.port !== "" && !relaxed) {
    return { ok: false, reason: "must be on the default https port" };
  }
  const hostname = bareHostname(url);
  if (!relaxed && (isIP(hostname) === 0 ? isPrivateName(hostname) : isPrivateAddress(hostname))) {
    return { ok: false, reason: "must be on the public internet" };
  }
  return { ok: true, url, origin: url.origin, hostname };
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>;

/** The addresses a hostname may be connected to: none when it may not be connected to at all. */
export type Resolve = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/**
 * Every address `hostname` resolves to when each of them is public, which a name passing `checkTargetUrl` still has to
 * be, and otherwise none. One private address is enough to refuse the name: which of them a connection would use is
 * the resolver's choice. A name that does not resolve, or is a local or cluster name, is refused too. With
 * `allowPrivateTargets` the addresses are given unchecked.
 */
export async function publicAddresses(hostname: string, lookup: Lookup = dns.lookup, env: Environment = process.env): Promise<readonly ResolvedAddress[]> {
  const relaxed = allowPrivateTargets(env);
  const family = isIP(hostname);
  if (family !== 0) {
    return relaxed || !isPrivateAddress(hostname) ? [{ address: hostname, family }] : [];
  }
  if (!relaxed && isPrivateName(hostname)) {
    return [];
  }
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return relaxed || addresses.every(({ address }) => !isPrivateAddress(address)) ? addresses : [];
  } catch {
    return [];
  }
}

/** How long an answer is kept: a page's assets are fetched in a burst, each of which would otherwise resolve again. */
export const RESOLVE_CACHE_MS = 60_000;

/** Enough for every prototype in use at once; past it the cache starts again rather than grow. */
const RESOLVE_CACHE_ENTRIES = 1_000;

/** `publicAddresses`, remembering each answer for `RESOLVE_CACHE_MS`, refusals included. */
export function cachedPublicAddresses(resolve: Resolve = (hostname) => publicAddresses(hostname), now: () => number = Date.now): Resolve {
  const answers = new Map<string, { at: number; addresses: readonly ResolvedAddress[] }>();
  return async (hostname) => {
    const kept = answers.get(hostname);
    if (kept !== undefined && now() - kept.at < RESOLVE_CACHE_MS) {
      return kept.addresses;
    }
    const addresses = await resolve(hostname);
    if (answers.size >= RESOLVE_CACHE_ENTRIES) {
      answers.clear();
    }
    answers.set(hostname, { at: now(), addresses });
    return addresses;
  };
}

/** A connection refused because its host has no address the hub may reach, coded as a resolver failure is. */
export class UnreachableTarget extends Error {
  readonly code = "ENOTFOUND";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new UnreachableTarget(String(error));
}

function familyNumber(family: LookupOptions["family"]): number {
  if (family === "IPv4") {
    return 4;
  }
  if (family === "IPv6") {
    return 6;
  }
  return family ?? 0;
}

/**
 * A socket's `lookup` that answers only with addresses `resolve` passed and never asks the system resolver itself, so
 * a connection goes to the very addresses that were checked rather than to whatever a second lookup of the name says.
 */
export function pinnedLookup(resolve: Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname.replace(/\.$/, "").toLowerCase()).then(
      (addresses) => {
        const family = familyNumber(options.family);
        const allowed = addresses.filter((address) => family === 0 || address.family === family);
        const first = allowed[0];
        if (first === undefined) {
          callback(new UnreachableTarget(`${hostname} has no address the hub may connect to`), "", 0);
        } else if (options.all === true) {
          callback(null, [...allowed]);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => callback(asError(error), "", 0)
    );
  };
}

/**
 * An undici dispatcher whose every connection goes to an address `resolve` passed. The socket is still opened for the
 * URL's hostname, so TLS sends it as the server name and verifies the certificate against it. A socket skips `lookup`
 * for an IP literal, so one is checked before connecting instead.
 */
export function pinnedDispatcher(resolve: Resolve): Agent {
  const connector = buildConnector({ lookup: pinnedLookup(resolve) });
  return new Agent({
    connect: (options, callback) => {
      if (isIP(options.hostname) === 0) {
        connector(options, callback);
        return;
      }
      resolve(options.hostname).then(
        (addresses) =>
          addresses.length === 0
            ? callback(new UnreachableTarget(`${options.hostname} is not an address the hub may connect to`), null)
            : connector(options, callback),
        (error: unknown) => callback(asError(error), null)
      );
    }
  });
}

export type PinnedFetch = (input: string | URL, init?: RequestInit & { duplex?: "half" }) => Promise<Response>;

/**
 * undici's own `fetch` through `pinnedDispatcher`, rather than the global one: Node's `fetch` is the undici bundled
 * with its release, of whatever major that is, and is not built to drive a dispatcher from another.
 */
export function pinnedFetch(resolve: Resolve): PinnedFetch {
  const dispatcher = pinnedDispatcher(resolve);
  // The DOM's `RequestInit` and `Response` and undici's describe the same objects in types that do not line up.
  return async (input, init) => (await undiciFetch(input, { ...(init as UndiciRequestInit), dispatcher })) as unknown as Response;
}
