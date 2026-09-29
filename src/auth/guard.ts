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
 * sign-in page is not an answer an agent can act on.
 */
const EXEMPT_PREFIXES = ["/health/", "/auth/", "/_next/", "/api/agent/"];

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
