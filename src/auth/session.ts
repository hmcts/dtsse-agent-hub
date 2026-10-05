import { open, seal } from "./sealed.ts";

/**
 * A person's session, held entirely in an encrypted cookie.
 *
 * Keyed by `oid` and `tid`, not `sub`: `sub` is pairwise per app registration, so it would never match the `oid`
 * an agent's `az` token carries for the same person.
 */
export interface Session {
  oid: string;
  tid: string;
  name: string;
  email?: string;
  /** Whether the id token carried the `AIGateway.User` app role. Read at sign-in, so a change waits for the next. */
  aiGateway: boolean;
}

export const SESSION_COOKIE = "ah_session";

/** A working day. A cookie-borne session cannot be revoked early, which is what keeps this short. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

export async function sealSession(session: Session, secret: string, now = new Date()): Promise<string> {
  return await seal({ ...session }, secret, SESSION_MAX_AGE, now);
}

export async function readSession(cookie: string | undefined, secret: string): Promise<Session | undefined> {
  const payload = await open(cookie, secret);
  if (payload === undefined) {
    return undefined;
  }
  const { oid, tid, name, email, aiGateway } = payload;
  if (typeof oid !== "string" || typeof tid !== "string" || typeof name !== "string") {
    return undefined;
  }
  return {
    oid,
    tid,
    name,
    ...(typeof email === "string" ? { email } : {}),
    // Anything but `true`, including a cookie sealed before the role was read, is no role: wrongly withholding it
    // lasts until the person next signs in, where wrongly granting it would put someone outside the group on Bedrock.
    aiGateway: aiGateway === true
  };
}
