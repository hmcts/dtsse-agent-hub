// The Azure sign-in a pod keeps on the hub. `az` stores its tokens in an MSAL cache under AZURE_CONFIG_DIR;
// what matters there is the refresh token, so the cache is pruned of everything that expires within the hour,
// gzipped and base64ed to fit the hub's cap, and restored into a fresh pod on its next boot.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import { readText, sha256 } from "../session.ts";
import { virtualStateDir } from "./phases.ts";

export const AZURE_CACHE_MAX_CHARS = 24000;

/** An MSAL token cache: credential type → id → entry. Only the keys this module acts on are named. */
export type MsalCache = Record<string, unknown>;

export type PackedAzureCache = {
  value: string;
  sha: string;
  cache: MsalCache;
};

export type AzureProfile = {
  installationId: string;
  subscriptions: {
    id: string | undefined;
    name: string;
    state: string;
    user: { name: unknown; type: string };
    isDefault: boolean;
    tenantId: string | undefined;
    environmentName: string;
    homeTenantId: string | undefined;
    managedByTenants: never[];
  }[];
};

export type SyncAzureCacheOptions = {
  api: Pick<Api, "putCredential">;
  id: string;
  env?: Env;
  force?: boolean;
};

export type SyncAzureCacheResult = "no-cache" | "unchanged" | "stored";

export function azureDir(env: Env = process.env): string {
  return env.AZURE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".azure");
}

const syncedShaFile = (): string => path.join(virtualStateDir(), "azure-cache.sha");

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Access tokens expire within the hour and make up most of the cache; the refresh token is what matters. */
export function pruneMsalCache(cache: MsalCache): MsalCache {
  const { AccessToken: _dropped, ...rest } = cache;
  return rest;
}

/**
 * The cache as the hub stores it, with its sha so an unchanged one is not re-uploaded. Id tokens go too if
 * that is what it takes to fit. A cache that is not an object is refused rather than stored as an empty one,
 * which would overwrite a good sign-in on the hub with nothing.
 */
export function packAzureCache(text: string, { max = AZURE_CACHE_MAX_CHARS }: { max?: number } = {}): PackedAzureCache {
  const parsed = asRecord(JSON.parse(text));
  if (!parsed) {
    throw new Error("the Azure token cache is not an object");
  }
  let pruned = pruneMsalCache(parsed);
  const pack = (obj: MsalCache) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8")).toString("base64");
  let value = pack(pruned);
  if (value.length > max && pruned.IdToken) {
    const { IdToken: _idTokens, ...rest } = pruned;
    pruned = rest;
    value = pack(pruned);
  }
  if (value.length > max) {
    throw new Error(`the pruned Azure token cache is ${value.length} characters, over the hub's ${max}`);
  }
  return { value, sha: sha256(JSON.stringify(pruned)), cache: pruned };
}

export function unpackAzureCache(value: string): MsalCache {
  const cache = asRecord(JSON.parse(zlib.gunzipSync(Buffer.from(value, "base64")).toString("utf8")));
  if (!cache?.RefreshToken) {
    throw new Error("the stored Azure token cache holds no refresh token");
  }
  return cache;
}

/** What `az login --allow-no-subscriptions` writes for a tenant-level account. */
export function minimalProfile(cache: MsalCache, tenantId?: string): AzureProfile {
  const account = asRecord(Object.values(asRecord(cache.Account) ?? {})[0]) ?? {};
  const tid = tenantId || (typeof account.realm === "string" ? account.realm : undefined);
  return {
    installationId: randomUUID(),
    subscriptions: [
      {
        id: tid,
        name: "N/A(tenant level account)",
        state: "Enabled",
        user: { name: account.username, type: "user" },
        isDefault: true,
        tenantId: tid,
        environmentName: "AzureCloud",
        homeTenantId: tid,
        managedByTenants: []
      }
    ]
  };
}

export function restoreAzureCache(value: string, { env = process.env }: { env?: Env } = {}): MsalCache {
  const cache = unpackAzureCache(value);
  const dir = azureDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "msal_token_cache.json"), JSON.stringify(cache), { mode: 0o600 });
  const profile = path.join(dir, "azureProfile.json");
  if (!fs.existsSync(profile)) {
    fs.writeFileSync(profile, JSON.stringify(minimalProfile(cache, env.AZURE_TENANT_ID)), { mode: 0o600 });
  }
  fs.writeFileSync(syncedShaFile(), `${sha256(JSON.stringify(pruneMsalCache(cache)))}\n`);
  return cache;
}

export function readAzureCache(env: Env = process.env): string | null {
  try {
    return fs.readFileSync(path.join(azureDir(env), "msal_token_cache.json"), "utf8");
  } catch {
    return null;
  }
}

/** PUTs the pruned cache when it differs from the last one stored. Returns what it did. */
export async function syncAzureCache({ api, id, env = process.env, force = false }: SyncAzureCacheOptions): Promise<SyncAzureCacheResult> {
  const text = readAzureCache(env);
  if (!text) {
    return "no-cache";
  }
  const { value, sha } = packAzureCache(text);
  if (!force && readText(syncedShaFile()) === sha) {
    return "unchanged";
  }
  await withRetry(() => api.putCredential(id, "azure", value), { attempts: 3 });
  fs.writeFileSync(syncedShaFile(), `${sha}\n`);
  return "stored";
}
