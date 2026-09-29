import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Identity } from "../users/identity.ts";
import { type AgentAuthSettings, jwksUrl } from "./settings.ts";

export class AgentAuthFailed extends Error {}

/** The tenant's signing keys could not be fetched, so no token can be judged either way. */
export class AgentAuthUnavailable extends Error {}

/**
 * Whether a key lookup failed because the JWKS endpoint did, rather than because of the token: a timeout, a network
 * error, a non-200 or unparseable response (a bare `JOSEError`), or a malformed key set. A token naming a key the
 * tenant does not publish (`JWKSNoMatchingKey`) or an unsupported algorithm is still the token's fault.
 */
function isKeySetOutage(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return true;
  }
  if (error instanceof errors.JOSEError) {
    return error.constructor === errors.JOSEError;
  }
  return true;
}

function outageAware(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await keys(header, token);
    } catch (error) {
      if (isKeySetOutage(error)) {
        throw new AgentAuthUnavailable(`the tenant's signing keys could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  };
}

/** Clock skew tolerated on `exp` and `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 60;

let remote: { tenantId: string; keys: JWTVerifyGetKey } | undefined;

/** The tenant's signing keys, fetched and cached by `jose` and rotated when a token names a key it has not seen. */
export function tenantKeys(tenantId: string): JWTVerifyGetKey {
  if (remote?.tenantId !== tenantId) {
    remote = { tenantId, keys: createRemoteJWKSet(jwksUrl(tenantId)) };
  }
  return remote.keys;
}

function claim(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The caller an Entra access token names.
 *
 * Signature, `iss` (the tenant's v2 issuer, which is why the registration sets `accessTokenAcceptedVersion: 2`),
 * `aud`, `exp` and `nbf` are checked by `jwtVerify`; `tid` is checked here, because a multi-tenant key set would
 * otherwise vouch for a token from another tenant. Identity is `oid`, never anything the client sent.
 *
 * `scp` must be present: only a delegated token, issued to a signed-in person, carries it. An app-only
 * (client-credentials) token has `roles` instead, and an ID token has neither, so neither acts as the person whose
 * `oid` it names. Which scope is not checked, because the registration's scope names are not this service's to fix.
 */
export async function verifyAgentToken(token: string, settings: AgentAuthSettings, keys: JWTVerifyGetKey = tenantKeys(settings.tenantId)): Promise<Identity> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, outageAware(keys), {
      issuer: settings.issuer,
      audience: settings.audiences,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "oid", "tid"]
    }));
  } catch (error) {
    if (error instanceof AgentAuthUnavailable) {
      throw error;
    }
    throw new AgentAuthFailed(`the bearer token was refused: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (claim(payload, "scp") === undefined) {
    throw new AgentAuthFailed("the bearer token is not a delegated access token: it has no scp");
  }
  const tid = claim(payload, "tid");
  if (tid !== settings.tenantId) {
    throw new AgentAuthFailed(`the bearer token was issued for tenant ${tid ?? "(none)"}`);
  }
  const oid = claim(payload, "oid");
  if (oid === undefined) {
    throw new AgentAuthFailed("the bearer token names no oid");
  }
  const email = claim(payload, "preferred_username") ?? claim(payload, "email") ?? claim(payload, "upn");
  return {
    oid,
    tid,
    name: claim(payload, "name") ?? email ?? oid,
    ...(email === undefined ? {} : { email })
  };
}
