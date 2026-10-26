// The loop that keeps the hub's copy of a pod's sign-ins current, so the next pod the owner starts does not
// have to sign in again. Atlassian and Azure are stored independently of each other: neither failing stops
// the other. Between the periodic runs twg is refreshed when due; the final run, on SIGTERM, only stores.
//
// A SIGTERM arriving mid-pass only wakes the sleep, so the pass in flight finishes — including a `twg auth
// refresh` at its own 60-second timeout — before the final store begins. The pod has 60 seconds in all
// (`terminationGracePeriodSeconds`), so that final store can be left very little of it, which is why the order
// inside a pass is what it is rather than a detail.
import type { Api } from "../api.ts";
import { createApi } from "../api.ts";
import type { Env } from "../env.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { type SyncAtlassianAuthResult, syncAtlassianAuth } from "./atlassian.ts";
import { type SyncAzureCacheResult, syncAzureCache } from "./azure-cache.ts";
import { say } from "./phases.ts";

export const CACHE_SYNC_MS = 10 * 60 * 1000;

export type CacheSyncOptions = {
  api?: Api;
  env?: Env;
  once?: boolean;
  intervalMs?: number;
};

export type CacheSyncResult = {
  azure: SyncAzureCacheResult | "error";
  atlassian: SyncAtlassianAuthResult | "error";
};

export async function cacheSync({
  api = createApi(),
  env = process.env,
  once = false,
  intervalMs = Number(env.AGENT_HUB_CACHE_SYNC_MS) || CACHE_SYNC_MS
}: CacheSyncOptions = {}): Promise<CacheSyncResult> {
  const { id } = requireVirtualAgent(env);
  const attempt = async (refresh: boolean): Promise<CacheSyncResult> => {
    let azure: CacheSyncResult["azure"];
    let atlassian: CacheSyncResult["atlassian"];
    // Atlassian first, because the two stores are not worth the same. Every twg refresh rotates the refresh token
    // and Atlassian takes only the newest, so a twg sign-in that goes unstored is one the next pod is refused on;
    // Entra's refresh tokens for a public client are not single-use, so a stale MSAL cache restored to the next
    // pod still refreshes. On SIGTERM the two share whatever is left of the pod's 60 seconds, and the one that
    // cannot be recovered from should not be the one spending what the other left behind.
    try {
      atlassian = await syncAtlassianAuth({ api, id, env, refresh });
      if (atlassian === "stored") {
        say("atlassian: twg sign-in stored on agent-hub");
      }
    } catch (e) {
      say(`atlassian: storing the twg sign-in failed: ${(e as Error).message}`);
      atlassian = "error";
    }
    try {
      azure = await syncAzureCache({ api, id, env });
      if (azure === "stored") {
        say("azure: token cache stored on agent-hub");
      }
    } catch (e) {
      say(`azure: storing the token cache failed: ${(e as Error).message}`);
      azure = "error";
    }
    return { azure, atlassian };
  };
  if (once) {
    return attempt(false);
  }
  let wake: (() => void) | null = null;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    while (!stopping) {
      await attempt(true);
      if (stopping) {
        break;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    return attempt(false);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
