import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Identity } from "../users/identity.ts";
import { type AgentAuthSettings, jwksUrl } from "./settings.ts";

export class AgentAuthFailed extends Error {}

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
 */
export async function verifyAgentToken(token: string, settings: AgentAuthSettings, keys: JWTVerifyGetKey = tenantKeys(settings.tenantId)): Promise<Identity> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: settings.issuer,
      audience: settings.audiences,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "oid", "tid"]
    }));
  } catch (error) {
    throw new AgentAuthFailed(`the bearer token was refused: ${error instanceof Error ? error.message : String(error)}`);
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
