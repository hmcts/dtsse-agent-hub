import { VIEWER_COOKIE_PREFIX } from "./paths.ts";
import { VIEWER_URL_HEADER } from "./settings.ts";

/**
 * Forwarding one viewer request to the pod's ingress and its answer back, with the headers that would misbehave on
 * the viewer's host rewritten or dropped. Pure apart from the `fetch` it is given.
 */

/** RFC 9110's hop-by-hop headers, plus the proxy-only ones; none of them describe the far side of a proxy. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/** Each says something about the browser's connection to the viewer, which forwarding replaces. */
const REPLACED_ON_REQUEST = new Set([
  "host",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-prefix",
  "x-real-ip",
  VIEWER_URL_HEADER
]);

/**
 * `fetch` decodes what it receives, so the encoding and length no longer describe the body it hands on. HSTS from a
 * pod is not the viewer's to set; the hub's own configuration sets the viewer's.
 */
const DROPPED_FROM_RESPONSE = new Set(["content-encoding", "content-length", "strict-transport-security", "set-cookie", "location"]);

/** A `Connection` header can name further hop-by-hop headers. */
function connectionTokens(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "")
  );
}

/** The `Cookie` header without the viewer's own cookies, which are the hub's and no business of the pod's. */
export function forwardedCookie(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const kept = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !pair.startsWith(VIEWER_COOKIE_PREFIX));
  return kept.length === 0 ? undefined : kept.join("; ");
}

export interface ForwardTarget {
  /** `https://<statefulset>-<port>.<domain>`. */
  upstreamOrigin: string;
  /** The path under the port's prefix, from `/`. */
  rest: string;
  search: string;
  /** `/<virtual agent id>/<port>`. */
  prefix: string;
  viewerHost: string;
}

export function forwardedRequestHeaders(incoming: Headers, target: ForwardTarget): Headers {
  const named = connectionTokens(incoming);
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (HOP_BY_HOP.has(name) || named.has(name) || REPLACED_ON_REQUEST.has(name) || name.startsWith("x-middleware-")) {
      continue;
    }
    headers.append(name, value);
  }
  const cookie = forwardedCookie(incoming.get("cookie"));
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  headers.set("x-forwarded-host", target.viewerHost);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-prefix", target.prefix);
  return headers;
}

/**
 * A path the pod built from the `X-Forwarded-Prefix` it was sent, which putting under the prefix again would leave
 * pointing at a port named `<virtual agent id>`.
 */
function alreadyPrefixed(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * A redirect the pod sends, moved under the port's prefix when it points back at the pod: an absolute URL on the
 * upstream origin, or a path from `/`. A relative path already resolves under the prefix, a path a prefix-aware pod
 * has put under it already is left as it is, and a redirect to anywhere else is left alone.
 */
export function rewriteLocation(location: string, target: Pick<ForwardTarget, "upstreamOrigin" | "prefix">): string {
  if (location.startsWith("/") && !location.startsWith("//")) {
    return alreadyPrefixed(location, target.prefix) ? location : `${target.prefix}${location}`;
  }
  if (!URL.canParse(location)) {
    return location;
  }
  const url = new URL(location);
  // By host alone: the pod may not know it is behind TLS and an ingress, so it can name itself over http or on the
  // port it listens on.
  if (url.hostname !== new URL(target.upstreamOrigin).hostname) {
    return location;
  }
  const prefix = alreadyPrefixed(url.pathname, target.prefix) ? "" : target.prefix;
  return `${prefix}${url.pathname}${url.search}${url.hash}`;
}

/**
 * A `__Host-` cookie, which a browser accepts only with `Path=/` and no `Domain`. Matched without case, as the
 * prefix is in RFC 6265bis and in the browsers.
 */
function hostPrefixedCookie(pair: string): boolean {
  return pair.toLowerCase().startsWith("__host-");
}

/**
 * A cookie the pod sets, kept on the viewer's host and under the port's prefix: `Domain` would reach past the viewer,
 * and a `Path` from `/` would be sent to every other agent's prefix too. Without `Path` the browser already scopes it
 * to the request's directory, which is under the prefix. A cookie named like the viewer's own is refused.
 *
 * A `__Host-` cookie is the exception, and keeps `Path=/`: under the prefix the browser would refuse it outright, so
 * an app that names its session or CSRF cookie that way could never sign anyone in. The cost is that it reaches every
 * other agent's prefix on the viewer's host, which `Path` only ever discouraged rather than enforced.
 */
export function rewriteSetCookie(value: string, prefix: string): string | undefined {
  const [pair, ...attributes] = value.split(";");
  if (pair === undefined || pair.trim().startsWith(VIEWER_COOKIE_PREFIX)) {
    return undefined;
  }
  const hostPrefixed = hostPrefixedCookie(pair.trim());
  const kept: string[] = [pair.trim()];
  let path = false;
  for (const attribute of attributes) {
    const trimmed = attribute.trim();
    const name = trimmed.split("=", 1)[0]!.trim().toLowerCase();
    if (name === "domain" || trimmed === "") {
      continue;
    }
    if (name === "path") {
      path = true;
      const asked = trimmed.slice(trimmed.indexOf("=") + 1).trim();
      if (hostPrefixed) {
        kept.push("Path=/");
      } else if (alreadyPrefixed(asked, prefix)) {
        kept.push(`Path=${asked}`);
      } else {
        kept.push(`Path=${prefix}${asked.startsWith("/") ? asked : "/"}`);
      }
      continue;
    }
    kept.push(trimmed);
  }
  if (hostPrefixed && !path) {
    kept.push("Path=/");
  }
  return kept.join("; ");
}

export function forwardedResponseHeaders(incoming: Headers, target: Pick<ForwardTarget, "upstreamOrigin" | "prefix">): Headers {
  const named = connectionTokens(incoming);
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (HOP_BY_HOP.has(name) || named.has(name) || DROPPED_FROM_RESPONSE.has(name)) {
      continue;
    }
    headers.append(name, value);
  }
  const location = incoming.get("location");
  if (location !== null) {
    headers.set("location", rewriteLocation(location, target));
  }
  for (const cookie of incoming.getSetCookie()) {
    const rewritten = rewriteSetCookie(cookie, target.prefix);
    if (rewritten !== undefined) {
      headers.append("set-cookie", rewritten);
    }
  }
  return headers;
}

/**
 * The most of a request body that reaches a route handler whole.
 *
 * Next clones every proxy-matched request's body through `getCloneableBody` in `next/dist/server/body-streams`, which
 * ends both streams at `experimental.proxyClientMaxBodySize` and only `console.warn`s: past it the handler reads a
 * short body and an ordinary end of stream, with `Content-Length` left as the client sent it. The hub's own routes
 * read theirs through `readJson`, which refuses what is left as too long anyway, but a forwarded body is sent to the
 * pod as it is, so the viewer refuses it instead of handing a pod half a request.
 *
 * **Kept the same as `experimental.proxyClientMaxBodySize` in next.config.mjs**, which `forward.test.ts` checks.
 */
export const PROXY_BODY_LIMIT_BYTES = 6 * 1024 * 1024;

/**
 * Whether a request declares a body longer than the proxy carries whole. A chunked body declares no length and so
 * cannot be caught here: it is truncated silently, as it was before this check, and only `next`'s warning says so.
 */
export function declaresTooLongBody(headers: Headers): boolean {
  const declared = Number(headers.get("content-length"));
  return Number.isFinite(declared) && declared > PROXY_BODY_LIMIT_BYTES;
}

/** A body is sent only for methods that may have one, since `fetch` refuses a body on `GET` or `HEAD`. */
function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** `Response` refuses a body with these. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export type Fetch = (input: string, init: RequestInit & { duplex?: "half" }) => Promise<Response>;

export class UpstreamUnreachable extends Error {}

/** Sends `request` on to the pod and hands back its answer as the viewer's, without following its redirects. */
export async function forward(request: Request, target: ForwardTarget, fetchImpl: Fetch): Promise<Response> {
  const url = `${target.upstreamOrigin}${target.rest}${target.search}`;
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers, target),
      ...(hasBody(request.method) && request.body !== null ? { body: request.body, duplex: "half" as const } : {}),
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    throw new UpstreamUnreachable(error instanceof Error ? error.message : String(error));
  }
  return new Response(request.method === "HEAD" || NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers, target)
  });
}
