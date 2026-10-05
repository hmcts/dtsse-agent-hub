import { canManageCredential } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { CREDENTIAL_KINDS, type CredentialKind, isDevOid, isEntraOid, secretName } from "./names.ts";
import { checkCredential } from "./validate.ts";

/**
 * Each person's credentials: the value in a `SecretStore`, and a `credential` row saying it is there. The row never
 * holds the value. `readCredential` hands one to the owner's own virtual agent, and to the owner only for the kinds
 * `canOwnerReadCredential` allows.
 */

/** Where values are kept: the credentials Key Vault, or the local encrypted table in development and tests. */
export interface SecretStore {
  /** The Key Vault is never written for a development identity, which is not a person. */
  readonly acceptsDevIdentities: boolean;
  put(name: string, value: string, tags: Record<string, string>): Promise<void>;
  /** The value, or `undefined` when there is none. */
  get(name: string): Promise<string | undefined>;
  /** Succeeds when there was nothing to remove. */
  remove(name: string): Promise<void>;
}

export type CredentialVia = "web" | "cli" | "pod";

export interface CredentialStatus {
  kind: CredentialKind;
  stored: boolean;
  accountLabel: string | null;
  updatedAt: string | null;
  updatedVia: CredentialVia | null;
}

export interface CredentialTarget {
  actorOid: string;
  ownerOid: string;
  kind: CredentialKind;
}

export interface CredentialWrite extends CredentialTarget {
  value: unknown;
  via: CredentialVia;
}

/** Why `ownerOid` cannot keep credentials in `store`, or `undefined` when they can. */
export function ownerRefusal(store: SecretStore, ownerOid: string): HttpError | undefined {
  if (isDevOid(ownerOid) && !store.acceptsDevIdentities) {
    return new HttpError(403, "a development identity cannot store credentials on this deployment");
  }
  if (!isEntraOid(ownerOid) && !isDevOid(ownerOid)) {
    return new HttpError(400, "credentials can only be stored for an Entra user");
  }
  return undefined;
}

function checkTarget(store: SecretStore, { actorOid, ownerOid }: CredentialTarget): void {
  if (!canManageCredential(actorOid, ownerOid)) {
    throw new HttpError(403, "you can only change your own credentials");
  }
  const refusal = ownerRefusal(store, ownerOid);
  if (refusal !== undefined) {
    throw refusal;
  }
}

/**
 * Saves the value first and the row after it. A failure between the two leaves a value with no row, which reads as
 * not stored and is overwritten by the next save, rather than a row promising a value that is not there.
 */
export async function putCredential(prisma: PrismaClient, store: SecretStore, write: CredentialWrite): Promise<void> {
  checkTarget(store, write);
  const checked = checkCredential(write.kind, write.value);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const name = secretName(write.ownerOid, write.kind);
  await store.put(name, checked.value, { owner: write.ownerOid, kind: write.kind, via: write.via });
  await prisma.$transaction(async (tx) => {
    const row = { secretName: name, accountLabel: checked.accountLabel, updatedAt: new Date(), updatedVia: write.via };
    await tx.credential.upsert({
      where: { ownerOid_kind: { ownerOid: write.ownerOid, kind: write.kind } },
      create: { ownerOid: write.ownerOid, kind: write.kind, ...row },
      update: row
    });
    await notify(tx, { type: "credential", owner_oid: write.ownerOid, kind: write.kind });
  });
}

/**
 * Removes the value first and the row after it, so a delete that fails half way still leaves nothing to read. The
 * value is removed even with no row, in case an earlier save stopped between the two. Deleting nothing succeeds.
 */
export async function deleteCredential(prisma: PrismaClient, store: SecretStore, target: CredentialTarget): Promise<void> {
  checkTarget(store, target);
  await store.remove(secretName(target.ownerOid, target.kind));
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.credential.deleteMany({ where: { ownerOid: target.ownerOid, kind: target.kind } });
    if (count > 0) {
      await notify(tx, { type: "credential", owner_oid: target.ownerOid, kind: target.kind });
    }
  });
}

/** What the owner has stored, one entry per kind, from the rows alone. Never touches a value. */
export async function credentialStatus(db: Database, ownerOid: string): Promise<CredentialStatus[]> {
  const rows = await db.credential.findMany({
    where: { ownerOid },
    select: { kind: true, accountLabel: true, updatedAt: true, updatedVia: true }
  });
  return CREDENTIAL_KINDS.map((kind) => {
    const row = rows.find((candidate) => candidate.kind === kind);
    return row === undefined
      ? { kind, stored: false, accountLabel: null, updatedAt: null, updatedVia: null }
      : { kind, stored: true, accountLabel: row.accountLabel, updatedAt: row.updatedAt.toISOString(), updatedVia: row.updatedVia };
  });
}

/**
 * The value of the owner's credential, for the hub to hand to that owner's own virtual agent, or to the owner when
 * `canOwnerReadCredential` allows. Never log it.
 */
export async function readCredential(db: Database, store: SecretStore, ownerOid: string, kind: CredentialKind): Promise<string | undefined> {
  const row = await db.credential.findUnique({ where: { ownerOid_kind: { ownerOid, kind } }, select: { secretName: true } });
  return row === null ? undefined : await store.get(row.secretName);
}
