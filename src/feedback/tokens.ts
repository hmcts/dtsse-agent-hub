import { randomBytes } from "node:crypto";

/**
 * A share link's token: 32 random bytes, base64url, so 43 characters that are safe in a path segment. It is the whole
 * of what a reviewer needs besides being signed in (`feedbackLinkAccess`), so it carries 256 bits and is never derived
 * from anything about the link. Rotating a link replaces it.
 */

const TOKEN_BYTES = 32;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newFeedbackToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Whether `value` has a token's shape, so a lookup is not spent on what no link could carry. */
export function isFeedbackToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
