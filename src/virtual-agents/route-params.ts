import { HttpError } from "../agent-api/http.ts";
import { sessionSecret } from "../auth/settings.ts";
import { type CredentialBackend, credentialBackend } from "../credentials/backend.ts";
import { type CredentialKind, isCredentialKind } from "../credentials/names.ts";
import type { SecretStore } from "../credentials/store.ts";
import type { Database } from "../store/prisma.ts";

/** What the `/api/virtual/{id}/…` handlers share: the kind in the path, and the stores they need, or the refusal. */

export function pathKind(value: string): CredentialKind {
  if (!isCredentialKind(value)) {
    throw new HttpError(404, "no such kind of credential");
  }
  return value;
}

export function requireStore(db: Pick<Database, "devCredentialValue">, backend: CredentialBackend = credentialBackend(db)): SecretStore {
  if (!backend.available) {
    throw new HttpError(503, backend.reason);
  }
  return backend.store;
}

export function requireSessionSecret(): string {
  const secret = sessionSecret();
  if (secret === undefined) {
    throw new HttpError(503, "SESSION_SECRET is not set, so a pasted code cannot be kept");
  }
  return secret;
}
