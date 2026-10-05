import { DEV_OID_PREFIX } from "../agent-auth/dev.ts";

/**
 * What a person's virtual agent needs on their behalf: a GitHub token, an Azure CLI token cache, and the key to its
 * model, a Claude token or an Amazon Bedrock API key.
 */
export const CREDENTIAL_KINDS = ["github", "azure", "claude", "bedrock"] as const;

export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

const ENTRA_OID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A development identity, limited to what a Key Vault secret name allows so it shares the naming with real ones. */
const DEV_OID = new RegExp(`^${DEV_OID_PREFIX}[A-Za-z0-9-]{1,64}$`);

/** An Entra object id, which Entra always writes as a lowercase GUID. */
export function isEntraOid(oid: string): boolean {
  return ENTRA_OID.test(oid);
}

export function isDevOid(oid: string): boolean {
  return DEV_OID.test(oid);
}

export class InvalidCredentialOwner extends Error {}

/**
 * Where a person's credential of one kind is kept: `u-<oid>-<kind>`. Key Vault names allow only `[0-9a-zA-Z-]`, so
 * the owner is checked against the two oid shapes the hub issues rather than escaped, and a name can only ever be
 * one person's.
 */
export function secretName(oid: string, kind: CredentialKind): string {
  if (!isEntraOid(oid) && !isDevOid(oid)) {
    throw new InvalidCredentialOwner("credentials can only be stored for an Entra object id or a development identity");
  }
  if (!isCredentialKind(kind)) {
    throw new InvalidCredentialOwner(`${String(kind)} is not a kind of credential`);
  }
  return `u-${oid}-${kind}`;
}
