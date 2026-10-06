/**
 * Which requests may be served without a session, and where a person may be sent after signing in. Pure functions
 * because both are wrong quietly: an over-broad exemption publishes pages, and an unchecked return path is an open
 * redirect.
 */

const EXEMPT_PATHS = ["/health", "/liveness", "/readiness", "/favicon.ico"];

/**
 * Every prefix ends in `/`, so `/health` does not also exempt `/health-summary`.
 *
 * `/api/agent/` authenticates every request itself with an Entra bearer token (`src/agent-auth/`); a redirect to a
 * sign-in page is not an answer an agent can act on. `/api/virtual/` (a virtual agent's pod, with its launch token) and
 * `/api/orchestrator/` (the orchestrator's application token) authenticate the same way.
 *
 * `/api/ui/` is called by `fetch` and `EventSource`, which follow a redirect to a page they cannot read and so
 * cannot tell a person their session has ended. Every handler there answers 401 itself without one (`uiViewer`).
 */
const EXEMPT_PREFIXES = ["/health/", "/auth/", "/_next/", "/api/agent/", "/api/virtual/", "/api/orchestrator/", "/api/ui/"];

export function exempt(pathname: string): boolean {
  return EXEMPT_PATHS.includes(pathname) || EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** A backslash, or any C0 control character or DEL. */
function unsafeInAPath(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\" || code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export const HOME = "/";

/**
 * The same-origin path a person may be returned to, or `/`. Refuses `//host` (protocol-relative), `/\host` (which
 * some browsers normalise into the same) and control characters (a newline in `Location` splits the response).
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return HOME;
  }
  if (unsafeInAPath(value)) {
    return HOME;
  }
  return value;
}

/** Query parameters that only a mistaken native form submit or a hand-edited link would put a secret in. */
const SECRET_PARAMETERS = new Set(["value", "token", "code", "password", "secret"]);

/** The OpenID Connect callback, whose authorisation `code` arrives in the query by design. */
const CALLBACK_PATH = "/auth/callback";

/**
 * Whether a GET or HEAD carries what looks like a secret in its query string. The proxy answers one with a redirect
 * to the bare path, so the page never renders the value into links, `redirect=` parameters or its own logs.
 */
export function carriesSecret(method: string, pathname: string, search: URLSearchParams): boolean {
  if ((method !== "GET" && method !== "HEAD") || pathname === CALLBACK_PATH) {
    return false;
  }
  for (const name of search.keys()) {
    if (SECRET_PARAMETERS.has(name.toLowerCase())) {
      return true;
    }
  }
  return false;
}
