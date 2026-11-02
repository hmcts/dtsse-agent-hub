// The pod's Azure sign-in: the stored one restored, or a device code relayed to the owner.
import fs from "node:fs";
import { type Api, ApiError, createApi } from "../api.ts";
import { DEFAULT_SCOPE } from "../az-token.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { azureDir, restoreAzureCache, syncAzureCache } from "./azure-cache.ts";
import { type DeviceCodePrompt, DeviceLoginError, type LoginOptions, type RelayDeviceLoginResult, relayDeviceLogin } from "./device-relay.ts";
import { FatalError, say } from "./phases.ts";
import { run } from "./process.ts";

/**
 * What `azureLogin` does when the pod has no working Azure sign-in. Azure is optional, so a pod's boot restores a
 * stored one (`restore`) and relays a device code only once the owner has asked for one from their settings
 * (`requested`), in the background. `relay` relays whether or not anybody asked, for a hand-run in a pod.
 */
export type AzureLoginMode = "relay" | "restore" | "requested";

export type AzureLoginOptions = LoginOptions & { mode?: AzureLoginMode };

/** `not-connected` is a pod left without Azure: nothing usable stored and nobody asking, or a sign-in not finished. */
export type AzureLoginResult = "restored" | "signed-in" | "not-connected";

// `az login --use-device-code` (2.88) writes this to stderr:
// "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code LNKR6UHMN to authenticate."
export function parseAzDeviceCode(text: string): DeviceCodePrompt | null {
  const m = /open the page (https:\/\/\S+?)\.? and enter the code ([A-Z0-9-]+)/.exec(text);
  return m ? { verification_uri: m[1] as string, user_code: m[2] as string } : null;
}

async function azOk(env: Env): Promise<boolean> {
  const r = await run("az", ["account", "get-access-token", "--scope", env.AGENT_HUB_SCOPE || DEFAULT_SCOPE, "-o", "none"], { env, timeoutMs: 60000 });
  return r.code === 0;
}

/**
 * Tells the hub a requested Azure sign-in is over unfinished, so the owner's screen withdraws the code and the agent
 * leaves `awaiting_login`. A few tries only: Azure is optional, and a hub that cannot be told is not worth holding
 * the sign-in's caller for.
 */
async function reportAzureNotConnected(api: Pick<Api, "loginFailed">, id: string, state: "expired" | "failed", detail: string): Promise<void> {
  say(`${detail}; Azure stays unconfigured`);
  await withRetry(() => api.loginFailed(id, "azure", { state, detail }), { attempts: 3 }).catch((e: unknown) => {
    say(`azure: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`);
  });
}

/** Whether the sign-in stored on the hub was restored and works; says why not when it was not. */
async function restoreStoredSignIn(api: Api, id: string, env: Env, mode: AzureLoginMode): Promise<boolean> {
  const then = mode === "relay" ? "signing in again" : "Azure stays unconfigured until the owner connects it";
  const stored = await withRetry(() => api.getCredential(id, "azure"));
  if (!stored) {
    if (mode === "restore") {
      say(`azure: no sign-in is stored; ${then}`);
    }
    return false;
  }
  try {
    restoreAzureCache(stored, { env });
    if (await azOk(env)) {
      say("azure: restored the stored sign-in");
      await syncAzureCache({ api, id, env });
      return true;
    }
    say(`azure: the stored sign-in no longer works; ${then}`);
  } catch (e) {
    say(`azure: could not restore the stored sign-in (${(e as Error).message}); ${then}`);
  }
  return false;
}

/** What comes before any code is relayed: a restored sign-in, a relay to make, or a pod left without Azure. */
async function beforeRelay(api: Api, id: string, env: Env, mode: AzureLoginMode): Promise<"restored" | "relay" | "not-connected"> {
  // A pod asked to sign in has already found what is stored unusable at boot, so it goes straight to asking.
  if (mode === "requested") {
    return (await withRetry(() => api.signInRequested(id, "azure"))) ? "relay" : "not-connected";
  }
  if (await restoreStoredSignIn(api, id, env, mode)) {
    return "restored";
  }
  return mode === "restore" ? "not-connected" : "relay";
}

/** Relays `az login`'s device code; `not-connected` once a requested sign-in has been reported over. */
async function relayAzureCode(api: Api, id: string, env: Env, mode: AzureLoginMode): Promise<RelayDeviceLoginResult | "not-connected"> {
  const tenant = env.AZURE_TENANT_ID;
  const args = ["login", "--use-device-code", "--allow-no-subscriptions", "-o", "none"];
  if (tenant) {
    args.splice(2, 0, "--tenant", tenant);
  }
  let relayed: RelayDeviceLoginResult;
  try {
    relayed = await relayDeviceLogin({ api, id, kind: "azure", cmd: "az", args, env, parse: parseAzDeviceCode, label: "azure" });
  } catch (e) {
    // A code the owner may be looking at is owed a `failed`; one that never reached them is retried by the caller.
    if (mode === "requested" && e instanceof DeviceLoginError && e.shown) {
      await reportAzureNotConnected(api, id, "failed", `azure: the sign-in could not be relayed (${e.message})`);
      return "not-connected";
    }
    throw e;
  }
  if (relayed.code === 0) {
    return relayed;
  }
  if (mode !== "requested") {
    throw new Error(`az login exited ${relayed.code}`);
  }
  // The owner asked once, so one code is all they are shown: the next is theirs to ask for from their settings.
  await reportAzureNotConnected(
    api,
    id,
    relayed.expired ? "expired" : "failed",
    relayed.expired ? "azure: the sign-in code ran out before it was used" : `azure: the sign-in was not completed (az login exited ${relayed.code})`
  );
  return "not-connected";
}

/** Tells the hub whose sign-in it was, which it refuses for anyone but the owner, and stores what az now holds. */
async function completeAzureSignIn(api: Api, id: string, env: Env): Promise<void> {
  const who = await run("az", ["ad", "signed-in-user", "show", "--query", "{id:id,upn:userPrincipalName}", "-o", "json"], { env });
  if (who.code !== 0) {
    throw new Error("az ad signed-in-user show failed after sign-in");
  }
  const { id: oid, upn } = JSON.parse(who.stdout) as { id: string; upn: string };
  try {
    await withRetry(() => api.loginComplete(id, "azure", { account_oid: oid, account_label: upn }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      fs.rmSync(azureDir(env), { recursive: true, force: true });
      await withRetry(() => api.virtualStatus(id, "failed", "azure: signed in as an account that is not the agent owner")).catch(() => {});
      throw new FatalError("azure: the hub refused the sign-in: the account is not the agent owner");
    }
    throw e;
  }
  await syncAzureCache({ api, id, env, force: true });
  say(`azure: signed in as ${upn}`);
}

/**
 * Restores the Azure sign-in the hub holds, or, by `mode`, relays a device-code sign-in to the owner. See
 * `AzureLoginMode`: a pod's boot never relays one the owner did not ask for, because Azure only lets Claude act as
 * them with `az` and gives Jenkins their object id, and nothing else in the pod waits for it.
 */
export async function azureLogin({ api = createApi(), env = process.env, mode = "relay" }: AzureLoginOptions = {}): Promise<AzureLoginResult> {
  const { id } = requireVirtualAgent(env);
  const next = await beforeRelay(api, id, env, mode);
  if (next !== "relay") {
    return next;
  }
  if ((await relayAzureCode(api, id, env, mode)) === "not-connected") {
    return "not-connected";
  }
  await completeAzureSignIn(api, id, env);
  return "signed-in";
}
