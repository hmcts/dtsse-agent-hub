import { DEV_TENANT, parseDevUser } from "../agent-auth/dev.ts";
import { readSession, SESSION_COOKIE } from "../auth/session.ts";
import { AuthConfigurationError, authRequired, type Environment, sessionSecret } from "../auth/settings.ts";
import type { Identity } from "../users/identity.ts";

/**
 * Who is looking at the web UI, or making a write from it. The one answer every page, server action and the UI
 * stream use, read from the sealed session cookie and never from anything the browser sends as an argument.
 *
 * With `AUTH_DISABLED=true` (a preview, the pipeline's `-staging` release, `yarn dev`) nobody can sign in, so the
 * viewer is a fixed development identity instead. It is a real `user` row, so owning channels and granting access
 * work as they do signed in. Its oid is `dev-…` and its tenant `dev`: an Entra oid is a GUID, so a development
 * identity can never be mistaken for, or act as, a real person.
 */

export class NotSignedIn extends Error {}

export const DEV_PERSONA_COOKIE = "ah_dev_persona";

const PERSONA = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const ANONYMOUS_PERSONA = "anonymous";

/**
 * A development identity. `persona` lets a second browser act as someone else while sign-in is off, which is what
 * a test of grants between two people needs; anything that is not a short slug falls back to `anonymous`.
 */
export function devIdentity(persona: string | undefined = ANONYMOUS_PERSONA): Identity {
  const name = persona !== undefined && PERSONA.test(persona) ? persona : ANONYMOUS_PERSONA;
  return {
    oid: `dev-${name}`,
    tid: DEV_TENANT,
    name: name === ANONYMOUS_PERSONA ? "Anonymous (sign-in disabled)" : `Dev ${name} (sign-in disabled)`,
    // `.invalid` is reserved and resolves nowhere, so the access page can find a development identity by address
    // without that address ever belonging to anybody.
    email: `${name}@dev.invalid`
  };
}

export function isDevIdentity(identity: { tid: string }): boolean {
  return identity.tid === DEV_TENANT;
}

export type CookieReader = (name: string) => string | undefined;

/**
 * `AUTH_DEV_USER=<oid>|<name>|<email>`, read only while sign-in is off: act as a real person without Entra, so the UI
 * shows the agents their `az` token registered. The tenant is `ENTRA_TENANT_ID` when set, so it matches the `user`
 * row that registration wrote.
 */
export function configuredDevUser(env: Environment = process.env): Identity | undefined {
  const value = env.AUTH_DEV_USER;
  if (value === undefined || value === "") {
    return undefined;
  }
  const identity = parseDevUser(value);
  if (identity === undefined) {
    throw new AuthConfigurationError("AUTH_DEV_USER must be <oid>|<name>|<email>, and the oid and name are required");
  }
  return { ...identity, tid: env.ENTRA_TENANT_ID || DEV_TENANT };
}

/** The viewer, or `undefined` when nobody may be served: no session, a session that does not open, no secret. */
export async function viewerFrom(cookie: CookieReader, env: Environment = process.env): Promise<Identity | undefined> {
  if (!authRequired(env)) {
    return configuredDevUser(env) ?? devIdentity(cookie(DEV_PERSONA_COOKIE));
  }
  const secret = sessionSecret(env);
  if (secret === undefined) {
    return undefined;
  }
  return await readSession(cookie(SESSION_COOKIE), secret);
}
