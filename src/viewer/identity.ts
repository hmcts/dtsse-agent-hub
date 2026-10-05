import { DEV_OID_PREFIX, DEV_TENANT, parseIdentity } from "../agent-auth/dev.ts";
import { readSession, SESSION_COOKIE } from "../auth/session.ts";
import { AuthConfigurationError, authRequired, type Environment, sessionSecret } from "../auth/settings.ts";
import type { Identity } from "../users/identity.ts";

/**
 * Who is looking at the web UI, or making a write from it. The one answer every page, server action and the UI
 * stream use, read from the sealed session cookie and never from anything the browser sends as an argument.
 *
 * With `AUTH_DISABLED=true` (a preview, the pipeline's `-staging` release, `yarn dev`) nobody can sign in, so the
 * viewer is a fixed development identity instead. It is a real `user` row, so owning channels and granting access
 * work as they do signed in. Its oid is `dev-…` and its tenant `dev`: an Entra oid is a GUID, so a persona can never
 * be mistaken for a real person, and the agent API's `X-Dev-User` gets the same prefix, so it names a persona too.
 * `AUTH_DEV_USER` is the one deliberate exception: it acts as the real person it names.
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
    oid: `${DEV_OID_PREFIX}${name}`,
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
  const identity = parseIdentity(value);
  if (identity === undefined) {
    throw new AuthConfigurationError("AUTH_DEV_USER must be <oid>|<name>|<email>, and the oid and name are required");
  }
  return { ...identity, tid: env.ENTRA_TENANT_ID || DEV_TENANT };
}

/**
 * Which model a person's virtual agents use: Amazon Bedrock, called directly with the Bedrock API key they store with
 * the hub, for holders of the `AIGateway.User` app role, or a Claude licence of their own, whose token they store.
 */
export type ModelRoute = "bedrock" | "own-licence";

export interface Viewer extends Identity {
  modelRoute: ModelRoute;
}

/** A persona named `own-licence` or `own-licence-…` is on the own-licence route; every other persona is on Bedrock. */
export const OWN_LICENCE_PERSONA = "own-licence";

export function modelRouteFor(aiGateway: boolean): ModelRoute {
  return aiGateway ? "bedrock" : "own-licence";
}

function devModelRoute(identity: Identity): ModelRoute {
  const persona = identity.oid.slice(DEV_OID_PREFIX.length);
  return persona === OWN_LICENCE_PERSONA || persona.startsWith(`${OWN_LICENCE_PERSONA}-`) ? "own-licence" : "bedrock";
}

/** The viewer, or `undefined` when nobody may be served: no session, a session that does not open, no secret. */
export async function viewerFrom(cookie: CookieReader, env: Environment = process.env): Promise<Viewer | undefined> {
  if (!authRequired(env)) {
    const configured = configuredDevUser(env);
    if (configured !== undefined) {
      return { ...configured, modelRoute: "bedrock" };
    }
    const persona = devIdentity(cookie(DEV_PERSONA_COOKIE));
    return { ...persona, modelRoute: devModelRoute(persona) };
  }
  const secret = sessionSecret(env);
  if (secret === undefined) {
    return undefined;
  }
  const session = await readSession(cookie(SESSION_COOKIE), secret);
  if (session === undefined) {
    return undefined;
  }
  const { aiGateway, ...identity } = session;
  return { ...identity, modelRoute: modelRouteFor(aiGateway) };
}
