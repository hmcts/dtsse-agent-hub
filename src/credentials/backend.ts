import { authRequired, sessionSecret } from "../auth/settings.ts";
import type { Database } from "../store/prisma.ts";
import { createLocalStore } from "./local.ts";
import type { SecretStore } from "./store.ts";
import { createVaultStore } from "./vault.ts";

/**
 * Which store this process keeps credentials in, decided per call from the environment, because the chart's
 * secrets reach `process.env` only once `instrumentation.ts` has loaded them:
 *
 * - a production build with sign-in off (a preview, the pipeline's `-staging` release): none, whatever is mounted.
 *   Everyone there is a development identity, and none of them is a person whose credentials could be kept.
 * - `CREDENTIALS_VAULT_URL` set: the credentials Key Vault (AAT, as the `dtsse-agent-hub` ServiceAccount).
 * - otherwise, outside production: the local encrypted table, keyed from `SESSION_SECRET`.
 * - otherwise: none. Credentials are unavailable and say so; nothing else about the hub depends on them, so a
 *   deployment without the vault (a preview) still starts.
 */

export const VAULT_URL_VARIABLE = "CREDENTIALS_VAULT_URL";

export type CredentialBackend = { available: true; store: SecretStore } | { available: false; reason: string };

const globalForVault = globalThis as unknown as { agentHubCredentialVault?: { url: string; store: SecretStore } };

/** One client per pod, so its credential's cached token is reused rather than fetched for every request. */
function sharedVaultStore(url: string): SecretStore {
  const shared = globalForVault.agentHubCredentialVault;
  if (shared?.url === url) {
    return shared.store;
  }
  const store = createVaultStore({ url });
  globalForVault.agentHubCredentialVault = { url, store };
  return store;
}

export function credentialBackend(
  db: Pick<Database, "devCredentialValue">,
  env: Readonly<Record<string, string | undefined>> = process.env
): CredentialBackend {
  if (env.NODE_ENV === "production" && !authRequired(env)) {
    return { available: false, reason: "sign-in is off on this deployment, so there is nobody whose credentials could be stored" };
  }
  const url = env[VAULT_URL_VARIABLE]?.trim();
  if (url) {
    if (!url.startsWith("https://")) {
      return { available: false, reason: `${VAULT_URL_VARIABLE} is not an https URL, so credentials cannot be stored on this deployment` };
    }
    return { available: true, store: sharedVaultStore(url) };
  }
  if (env.NODE_ENV === "production") {
    return { available: false, reason: "this deployment has no credentials vault, so credentials cannot be stored here" };
  }
  const secret = sessionSecret(env);
  if (secret === undefined) {
    return { available: false, reason: "set SESSION_SECRET to keep credentials in the local encrypted store" };
  }
  return { available: true, store: createLocalStore({ db, secret, env }) };
}
