import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { SecretStore } from "./store.ts";

/**
 * The credentials Key Vault. Only the hub's own workload identity has data-plane access to it, through the
 * `dtsse-agent-hub` ServiceAccount, whose federated token the workload identity webhook mounts into the pod;
 * `DefaultAzureCredential` finds it from the `AZURE_*` variables the webhook sets.
 *
 * Purge protection is on, so a removed secret stays soft-deleted for the vault's retention period and its name
 * cannot be reused until it is recovered. Removal therefore never purges, and a save over a soft-deleted name
 * recovers it first, then writes the new value as a new version.
 */

export interface VaultOptions {
  url: string;
  credential?: TokenCredential;
  /** How long to wait between attempts while a deletion of the same name is still finishing. */
  pauseMs?: number;
}

const ATTEMPTS = 5;
const PAUSE_MS = 2_000;

type Conflict = "deleted" | "deleting";

function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Which 409 this is. The service puts `ObjectIsDeletedButRecoverable` or `ObjectIsBeingDeleted` in the inner error,
 * which the SDK's `RestError` does not keep, so the message is what tells them apart.
 */
function conflictOf(error: unknown): Conflict | undefined {
  if (statusOf(error) !== 409) {
    return undefined;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
  if (/ObjectIsDeletedButRecoverable|deleted but recoverable/i.test(text)) {
    return "deleted";
  }
  if (/ObjectIsBeingDeleted|being deleted/i.test(text)) {
    return "deleting";
  }
  return undefined;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVaultStore({ url, credential = new DefaultAzureCredential(), pauseMs = PAUSE_MS }: VaultOptions): SecretStore {
  const client = new SecretClient(url, credential);

  async function put(name: string, value: string, tags: Record<string, string>): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.setSecret(name, value, { tags, contentType: "text/plain" });
        return;
      } catch (error) {
        const conflict = conflictOf(error);
        if (conflict === undefined || attempt >= ATTEMPTS) {
          throw error;
        }
        if (conflict === "deleted") {
          await (await client.beginRecoverDeletedSecret(name)).pollUntilDone();
        } else {
          await pause(pauseMs);
        }
      }
    }
  }

  async function get(name: string): Promise<string | undefined> {
    try {
      return (await client.getSecret(name)).value;
    } catch (error) {
      if (statusOf(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async function remove(name: string): Promise<void> {
    try {
      // Waits for the deletion to finish, so a save straight after it meets a soft-deleted name it can recover
      // rather than one still being deleted.
      await (await client.beginDeleteSecret(name)).pollUntilDone();
    } catch (error) {
      if (statusOf(error) !== 404) {
        throw error;
      }
    }
  }

  return { acceptsDevIdentities: false, put, get, remove };
}
