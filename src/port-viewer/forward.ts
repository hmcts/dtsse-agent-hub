import { VIEWER_COOKIE_PREFIX } from "./paths.ts";
import { VIEWER_URL_HEADER } from "./settings.ts";

/**
 * Forwarding one viewer request upstream, to a pod's ingress or a feedback link's prototype, and its answer back, with
 * the headers that would misbehave on the viewer's host rewritten or dropped. Pure apart from the `fetch` it is given.
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
const DROPPED_FROM_RESPONSE = new Set(["content-encoding", "content-length", "strict-transport-security", "set-cookie", "location", "referrer-policy"]);

/**
 * In place of whatever the pod asks for, as helmet's `no-referrer` default: the viewer finds the port a root-relative
 * request came from by its `Referer`, which `same-origin` still sends to the viewer and never to anywhere else.
 */
const VIEWER_REFERRER_POLICY = "same-origin";

/** A `Connection` header can name further hop-by-hop headers. */
function connectionTokens(headers: Headers): Set<string> {
  return new Set(
    (headers.get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== "")
  );
}

/**
 * A `__Host-` or `__Secure-` cookie. The browser sends a `__Host-` cookie an agent's app set to every prefix on the
 * viewer's host, since it is kept at `Path=/` (see `rewriteSetCookie`), and a `__Secure-` one may carry a `Path=/` of
 * its own. Matched without case, as the prefixes are in RFC 6265bis and in the browsers.
 */
function prefixedCookie(pair: string): boolean {
  const lower = pair.toLowerCase();
  return lower.startsWith("__host-") || lower.startsWith("__secure-");
}

/**
 * The `Cookie` header without the viewer's own cookies, which are the hub's and no business of the pod's. For a
 * feedback link's prototype, a site outside the hub, `__Host-` and `__Secure-` cookies are left out too: they can
 * belong to an agent's app rather than the prototype.
 */
export function forwardedCookie(header: string | null, options: { feedback?: boolean } = {}): string | undefined {
  if (header === null) {
    return undefined;
  }
  const kept = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !pair.startsWith(VIEWER_COOKIE_PREFIX) && !(options.feedback === true && prefixedCookie(pair)));
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * The only browser headers a feedback link's prototype is sent, besides `cookie` and `referer`, which are rewritten.
 * It is a site outside the cluster, so it gets what a browser fetching it directly would send, less anything that
 * names the hub, the viewer or the network in front of them.
 */
const FEEDBACK_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "range",
  "if-range",
  "pragma",
  "user-agent"
];

/**
 * A `Referer` from the prototype's own pages on the viewer, as the prototype would see it served directly: its origin
 * and the path under the prefix. Any other names a page that is not the prototype's, and is dropped.
 */
function feedbackReferer(referer: string | null, target: Pick<ForwardTarget, "upstreamOrigin" | "prefix" | "viewerOrigin">): string | undefined {
  if (referer === null || !URL.canParse(referer)) {
    return undefined;
  }
  const url = new URL(referer);
  if (url.origin !== target.viewerOrigin || !alreadyPrefixed(url.pathname, target.prefix)) {
    return undefined;
  }
  return `${target.upstreamOrigin}${url.pathname.slice(target.prefix.length) || "/"}${url.search}`;
}

function feedbackRequestHeaders(incoming: Headers, target: ForwardTarget, withBody: boolean): Headers {
  const headers = new Headers();
  for (const name of FEEDBACK_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  const length = incoming.get("content-length");
  if (withBody && length !== null) {
    headers.set("content-length", length);
  }
  const cookie = forwardedCookie(incoming.get("cookie"), { feedback: true });
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  const referer = feedbackReferer(incoming.get("referer"), target);
  if (referer !== undefined) {
    headers.set("referer", referer);
  }
  // No `X-Forwarded-Host`: `fetch` sends the prototype's own host as `Host`, and the viewer's is none of its business.
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-prefix", target.prefix);
  return headers;
}

export interface ForwardTarget {
  /** `https://<statefulset>-<port>.<domain>`, or a feedback link's prototype origin. */
  upstreamOrigin: string;
  /** The path under the prefix, from `/`. */
  rest: string;
  search: string;
  /** `/<virtual agent id>/<port>` or `/f/<token>`. */
  prefix: string;
  viewerHost: string;
  /** The viewer's origin, which a feedback page's policies let the widget's script load from. */
  viewerOrigin: string;
  /**
   * The origin allowed to frame the answer, the hub's, for a feedback link's pages. Its `X-Frame-Options` is dropped
   * and every `frame-ancestors` in its policies replaced with this, and the policies let the widget's script load.
   */
  frameAncestors?: string;
  /** HTML put at the start of every page's `<head>`: the feedback widget's `<script>`. */
  inject?: string;
  /** The nonce `inject`'s script carries, which a policy with `'strict-dynamic'` is given so it still runs. */
  scriptNonce?: string;
  /**
   * A feedback link's prototype, a site outside the cluster: it is sent an allowlist of the browser's headers rather
   * than all but a few, and no `__Host-` cookie either way.
   */
  feedback?: boolean;
}

export function forwardedRequestHeaders(incoming: Headers, target: ForwardTarget, method = "GET"): Headers {
  if (target.feedback === true) {
    return feedbackRequestHeaders(incoming, target, hasBody(method));
  }
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
 * other agent's prefix on the viewer's host, which `Path` only ever discouraged rather than enforced. A feedback
 * link's prototype is a site outside the hub, and its `__Host-` cookies are refused: no `Path` can keep one to its
 * prefix, and the prototype is never sent one back.
 */
export function rewriteSetCookie(value: string, prefix: string, options: { feedback?: boolean } = {}): string | undefined {
  const [pair, ...attributes] = value.split(";");
  if (pair === undefined || pair.trim().startsWith(VIEWER_COOKIE_PREFIX)) {
    return undefined;
  }
  const hostPrefixed = hostPrefixedCookie(pair.trim());
  if (hostPrefixed && options.feedback === true) {
    return undefined;
  }
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

/**
 * The directives a script's `src` is checked against, most specific first: `script-src-elem` and `script-src` where
 * the policy has them, and `default-src` only where it has neither.
 */
const SCRIPT_DIRECTIVES = ["script-src-elem", "script-src"];

export interface CspRewrite {
  frameAncestors: string;
  /** The viewer's own origin, which the widget's script is served from. */
  scriptOrigin: string;
  nonce?: string;
}

/**
 * A script directive's sources with the widget's script allowed. `'none'` cannot stand beside a source, so it goes.
 * Under `'strict-dynamic'` a browser ignores host sources, so the script is let in by its nonce as well.
 */
function allowingWidget(sources: string[], rewrite: CspRewrite): string[] {
  const kept = sources.filter((source) => source.toLowerCase() !== "'none'");
  const strict = kept.some((source) => source.toLowerCase() === "'strict-dynamic'");
  return [...kept, rewrite.scriptOrigin, ...(strict && rewrite.nonce !== undefined ? [`'nonce-${rewrite.nonce}'`] : [])];
}

function rewritePolicy(policy: string, rewrite: CspRewrite): string {
  const directives = policy
    .split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name !== "" && name!.toLowerCase() !== "frame-ancestors");
  const nameOf = (directive: string[]) => directive[0]!.toLowerCase();
  const scripts = directives.filter((directive) => SCRIPT_DIRECTIVES.includes(nameOf(directive)));
  const rewritten = directives.map((directive) => (scripts.includes(directive) ? [directive[0]!, ...allowingWidget(directive.slice(1), rewrite)] : directive));
  const fallback = directives.find((directive) => nameOf(directive) === "default-src");
  // A new `script-src` from `default-src`'s sources rather than `default-src` widened, which would let every other
  // kind of resource the viewer's origin too.
  if (scripts.length === 0 && fallback !== undefined) {
    rewritten.push(["script-src", ...allowingWidget(fallback.slice(1), rewrite)]);
  }
  rewritten.push(["frame-ancestors", rewrite.frameAncestors]);
  return rewritten.map((directive) => directive.join(" ")).join("; ");
}

/**
 * A `Content-Security-Policy` (or its report-only twin) as a framed feedback page needs it: each policy in the
 * comma-separated list loses its `frame-ancestors` and gains `frame-ancestors <hub>`, since a frame is allowed only
 * when every policy allows it, and each that limits scripts lets the widget's script in. Nothing else changes.
 */
export function rewriteCsp(value: string, rewrite: CspRewrite): string {
  return value
    .split(",")
    .filter((policy) => policy.trim() !== "")
    .map((policy) => rewritePolicy(policy, rewrite))
    .join(", ");
}

/** The response header that says a feedback page was served without its widget, because it could not be rewritten. */
export const WIDGET_ABSENT_HEADER = "x-feedback-widget";

export function forwardedResponseHeaders(
  incoming: Headers,
  target: Pick<ForwardTarget, "upstreamOrigin" | "prefix" | "viewerOrigin"> & Partial<Pick<ForwardTarget, "frameAncestors" | "scriptNonce" | "feedback">>
): Headers {
  const named = connectionTokens(incoming);
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (HOP_BY_HOP.has(name) || named.has(name) || DROPPED_FROM_RESPONSE.has(name)) {
      continue;
    }
    headers.append(name, value);
  }
  headers.set("referrer-policy", VIEWER_REFERRER_POLICY);
  const location = incoming.get("location");
  if (location !== null) {
    headers.set("location", rewriteLocation(location, target));
  }
  for (const cookie of incoming.getSetCookie()) {
    const rewritten = rewriteSetCookie(cookie, target.prefix, { feedback: target.feedback });
    if (rewritten !== undefined) {
      headers.append("set-cookie", rewritten);
    }
  }
  if (target.frameAncestors !== undefined) {
    const rewrite = { frameAncestors: target.frameAncestors, scriptOrigin: target.viewerOrigin, nonce: target.scriptNonce };
    headers.delete("x-frame-options");
    const policy = incoming.get("content-security-policy");
    headers.set("content-security-policy", policy === null ? `frame-ancestors ${target.frameAncestors}` : rewriteCsp(policy, rewrite));
    const report = incoming.get("content-security-policy-report-only");
    if (report !== null) {
      headers.set("content-security-policy-report-only", rewriteCsp(report, rewrite));
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

/**
 * The most of an HTML page the viewer reads to move its `<base href>` or put the widget in. A larger page is passed on
 * as it came, since holding it would cost the viewer that much memory per request; an app shell with a `<base>` is a
 * few kilobytes.
 */
export const BASE_REWRITE_LIMIT_BYTES = 2 * 1024 * 1024;

const BASE_HREF = /(<base\b[^>]*?\bhref\s*=\s*)(["'])(\/(?![/\\])[^"']*)\2/i;

/**
 * A page's first `<base href>` from `/`, moved under the prefix. A single-page app such as Angular's routes from its
 * base, so with `/` it reads the prefix as an unknown route and navigates out of it; under the prefix its address
 * bar stays there, and so does the `Referer` its root-relative API calls carry. Anything else is left alone.
 */
export function rewriteBaseHref(html: string, prefix: string): string {
  return html.replace(BASE_HREF, (_match, start: string, quote: string, href: string) => `${start}${quote}${prefix}${href}${quote}`);
}

/** The first `<head>`, then `<html>`, then a doctype, which the widget goes after; before a doctype is quirks mode. */
const INSERT_AFTER = [/<head(?=[\s>/])[^>]*>/i, /<html(?=[\s>/])[^>]*>/i, /^\s*<!doctype[^>]*>/i];

/** `snippet` put immediately after the first opening tag `INSERT_AFTER` finds, or at the very start of a page with none. */
function inserted(html: string, snippet: string): string {
  for (const tag of INSERT_AFTER) {
    const match = tag.exec(html);
    if (match !== null) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}${snippet}${html.slice(at)}`;
    }
  }
  return `${snippet}${html}`;
}

/** A page with its `<base href>` moved under `prefix`, and `inject`, when given, put at the start of its `<head>`. */
export function transformHtml(html: string, options: { prefix: string; inject?: string }): string {
  const moved = rewriteBaseHref(html, options.prefix);
  return options.inject === undefined ? moved : inserted(moved, options.inject);
}

function isHtml(headers: Headers): boolean {
  return (headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
}

/** HTML in UTF-8, or with no charset said, which is the only kind the viewer can rewrite and hand back unchanged otherwise. */
export function isRewritableHtml(headers: Headers): boolean {
  if (!isHtml(headers)) {
    return false;
  }
  const type = (headers.get("content-type") ?? "").toLowerCase();
  const charset = /charset\s*=\s*"?([^";\s]+)/.exec(type)?.[1];
  return charset === undefined || charset === "utf-8" || charset === "utf8";
}

/**
 * The body transformed by `transformHtml`, or, past `BASE_REWRITE_LIMIT_BYTES`, the same bytes streamed on as they
 * came, which `transformed` says.
 */
async function withHtmlTransformed(
  body: ReadableStream<Uint8Array>,
  options: { prefix: string; inject?: string }
): Promise<{ body: BodyInit; transformed: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > BASE_REWRITE_LIMIT_BYTES) {
      const passed = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
      return { body: passed, transformed: false };
    }
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return { body: transformHtml(new TextDecoder().decode(whole), options), transformed: true };
}

/** Sends `request` upstream and hands back its answer as the viewer's, without following its redirects. */
export async function forward(request: Request, target: ForwardTarget, fetchImpl: Fetch): Promise<Response> {
  const url = `${target.upstreamOrigin}${target.rest}${target.search}`;
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers, target, request.method),
      ...(hasBody(request.method) && request.body !== null ? { body: request.body, duplex: "half" as const } : {}),
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    throw new UpstreamUnreachable(error instanceof Error ? error.message : String(error));
  }
  const body = request.method === "HEAD" || NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
  const headers = forwardedResponseHeaders(upstream.headers, target);
  let sent: BodyInit | null = body;
  let transformed = false;
  if (body !== null && isRewritableHtml(upstream.headers)) {
    ({ body: sent, transformed } = await withHtmlTransformed(body, { prefix: target.prefix, inject: target.inject }));
  }
  if (target.inject !== undefined && body !== null && !transformed && isHtml(upstream.headers)) {
    headers.set(WIDGET_ABSENT_HEADER, "absent");
  }
  return new Response(sent, { status: upstream.status, statusText: upstream.statusText, headers });
}
