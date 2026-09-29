import type { Identity } from "../users/identity.ts";

export const DEV_USER_HEADER = "x-dev-user";

/** The tenant recorded for a development identity. Not a GUID, so it can never be mistaken for a real one. */
export const DEV_TENANT = "dev";

/** `X-Dev-User: <oid>|<name>|<email>`. The email is optional; the oid and name are not. */
export function parseDevUser(header: string | null | undefined): Identity | undefined {
  if (!header) {
    return undefined;
  }
  const [oid, name, email, ...rest] = header.split("|").map((part) => part.trim());
  if (!oid || !name || rest.length > 0) {
    return undefined;
  }
  return { oid, tid: DEV_TENANT, name, ...(email ? { email } : {}) };
}
