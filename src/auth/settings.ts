/**
 * What the web UI needs to authenticate a person against Microsoft Entra ID. Read from the environment, because the
 * chart mounts every secret as a file that `getPropertiesVolumeSecrets` turns into a variable.
 *
 * Signing in is the whole control for reaching the UI: the registration is single tenant, so Entra refuses anyone
 * outside HMCTS. What a signed-in person may then see of agents is decided by `src/access/`.
 */
export interface AuthSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Absolute, and must match a redirect URI on the app registration exactly. */
  redirectUri: string;
  sessionSecret: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class AuthConfigurationError extends Error {}

/**
 * Fails closed: authentication is required unless `AUTH_DISABLED=true` is set on purpose, so a deployment that
 * loses its Entra variables refuses to serve rather than serving everyone.
 */
export function authRequired(env: Environment = process.env): boolean {
  return env.AUTH_DISABLED !== "true";
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new AuthConfigurationError(`${name} is not set, and authentication is required. Set it, or set AUTH_DISABLED=true to run without a sign-in.`);
  }
  return value;
}

/**
 * The sealing secret, read through here by every caller. Vault values arrive from files, often with a trailing
 * newline; trimming on one side and not the other would make every freshly written cookie fail to open.
 */
export function sessionSecret(env: Environment = process.env): string | undefined {
  const value = env.SESSION_SECRET?.trim();
  return value ? value : undefined;
}

export function authSettings(env: Environment = process.env): AuthSettings {
  return {
    tenantId: required(env, "ENTRA_TENANT_ID"),
    clientId: required(env, "ENTRA_CLIENT_ID"),
    clientSecret: required(env, "ENTRA_CLIENT_SECRET"),
    redirectUri: required(env, "ENTRA_REDIRECT_URI"),
    sessionSecret: sessionSecret(env) ?? required(env, "SESSION_SECRET")
  };
}

/** The Entra v2 issuer for a tenant: what OIDC discovery runs against, and what an agent token's `iss` must be. */
export function issuerUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/v2.0`);
}
