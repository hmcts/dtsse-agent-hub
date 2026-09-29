import type { Identity } from "../users/identity.ts";

export const DEV_USER_HEADER = "x-dev-user";

/** The tenant recorded for a development identity. Not a GUID, so it can never be mistaken for a real one. */
export const DEV_TENANT = "dev";

/** Every development oid starts with this. An Entra oid is a GUID, so none ever does. */
export const DEV_OID_PREFIX = "dev-";

/** `<oid>|<name>|<email>`, taken at its word. The email is optional; the oid and name are not. */
export function parseIdentity(value: string | null | undefined): Identity | undefined {
  if (!value) {
    return undefined;
  }
  const [oid, name, email, ...rest] = value.split("|").map((part) => part.trim());
  if (!oid || !name || rest.length > 0) {
    return undefined;
  }
  return { oid, tid: DEV_TENANT, name, ...(email ? { email } : {}) };
}

/**
 * `X-Dev-User: <oid>|<name>|<email>`. The oid is given the `dev-` prefix unless it already has it, so the header
 * can name a UI persona (`dev-<slug>`) but never a real person's oid.
 */
export function parseDevUser(header: string | null | undefined): Identity | undefined {
  const identity = parseIdentity(header);
  if (identity === undefined || identity.oid.startsWith(DEV_OID_PREFIX)) {
    return identity;
  }
  return { ...identity, oid: `${DEV_OID_PREFIX}${identity.oid}` };
}
