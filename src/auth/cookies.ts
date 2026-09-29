import { SESSION_COOKIE, SESSION_MAX_AGE } from "./session.ts";

/**
 * `Secure` unconditionally: the service is only reached over HTTPS, and browsers exempt http://localhost.
 * `SameSite=Lax` rather than `Strict`, because Entra returns to the callback by a cross-site redirect and `Strict`
 * would withhold the sign-in cookie on exactly that navigation.
 */
const SHARED = ["path=/", "HttpOnly", "Secure"];

export function sessionCookie(value: string): string {
  return [`${SESSION_COOKIE}=${value}`, ...SHARED, `max-age=${SESSION_MAX_AGE}`, "SameSite=Lax"].join("; ");
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, ...SHARED, "max-age=0", "SameSite=Lax"].join("; ");
}

export const SIGN_IN_COOKIE = "ah_sign_in";

/** Long enough to complete a Microsoft sign-in, short enough that a stale one dies. */
export const SIGN_IN_MAX_AGE = 600;

export function signInCookie(value: string): string {
  return [`${SIGN_IN_COOKIE}=${value}`, ...SHARED, `max-age=${SIGN_IN_MAX_AGE}`, "SameSite=Lax"].join("; ");
}

export function clearedSignInCookie(): string {
  return [`${SIGN_IN_COOKIE}=`, ...SHARED, "max-age=0", "SameSite=Lax"].join("; ");
}
