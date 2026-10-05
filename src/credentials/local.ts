import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { Database } from "../store/prisma.ts";
import type { SecretStore } from "./store.ts";

/**
 * The value store for `yarn dev` and the test suites, which have no credentials vault: each value AES-256-GCM
 * sealed in `dev_credential_value`, under a key derived from `SESSION_SECRET`. The secret name is the additional
 * authenticated data, so a ciphertext copied onto another row does not open there.
 *
 * Production never uses it: a deployment without the vault has no credentials at all rather than keeping them in
 * its database, beside everything else the hub stores.
 */

export class LocalStoreRefused extends Error {}

export interface SealedValue {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_INFO = "dtsse-agent-hub local credential store";

/** HKDF rather than the secret itself, so this key is never the one that seals session cookies. */
export function localKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));
}

function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

export function sealValue(key: Buffer, name: string, value: string): SealedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: bytes(ciphertext), iv: bytes(iv), tag: bytes(cipher.getAuthTag()) };
}

/** Throws when the key, the name or any byte of the sealed value differs from what sealed it. */
export function openValue(key: Buffer, name: string, sealed: SealedValue): string {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

export interface LocalStoreOptions {
  db: Pick<Database, "devCredentialValue">;
  secret: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export function createLocalStore({ db, secret, env = process.env }: LocalStoreOptions): SecretStore {
  if (env.NODE_ENV === "production") {
    throw new LocalStoreRefused("the local credential store is for development and tests; production keeps credentials in the vault");
  }
  const key = localKey(secret);

  async function put(name: string, value: string): Promise<void> {
    const sealed = sealValue(key, name, value);
    await db.devCredentialValue.upsert({
      where: { secretName: name },
      create: { secretName: name, ...sealed },
      update: { ...sealed, updatedAt: new Date() }
    });
  }

  async function get(name: string): Promise<string | undefined> {
    const row = await db.devCredentialValue.findUnique({ where: { secretName: name }, select: { ciphertext: true, iv: true, tag: true } });
    return row === null ? undefined : openValue(key, name, row);
  }

  async function remove(name: string): Promise<void> {
    await db.devCredentialValue.deleteMany({ where: { secretName: name } });
  }

  return { acceptsDevIdentities: true, put, get, remove };
}
