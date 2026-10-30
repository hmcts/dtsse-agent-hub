// The kube contexts a pod is given, so an agent can read the clusters its owner can read.
//
// A pod has no cluster credential of its own: the pod template mounts no ServiceAccount token and no CA bundle, so
// `kubectl` with no kubeconfig falls back to localhost:8080. What it does have is the owner's own relayed Azure
// sign-in, and a CFT kubeconfig holds no secret beyond it — every user entry is `kubelogin get-token --login
// azurecli`, which asks the signed-in `az` for a token on each call. So the pod can make the file for itself, and
// an agent gets exactly its owner's access and no more.
//
// Made here rather than baked into the image because `az aks get-credentials` is also the only thing that knows a
// cluster's API server and CA, and both change when a cluster is rebuilt. It is not an extra barrier: it is how a
// person gets their own config, so anyone who can use `kubectl` at all can make the call.
import type { Env } from "../env.ts";
import { say } from "./phases.ts";
import { run } from "./sign-in.ts";

/** `az aks get-credentials` reaches a cluster in another subscription only when it is named. */
export const PREVIEW_SUBSCRIPTION = "DCD-CFTAPPS-DEV";
export const AAT_SUBSCRIPTION = "DCD-CFTAPPS-STG";

/**
 * Both AAT clusters, because a service runs on both and an agent cannot know in advance which holds the pod it
 * wants. Prod is deliberately absent: an agent acts with its owner's access, and a context it never has is one it
 * cannot reach on an elevation they took for something else.
 */
export const AAT_CLUSTERS = ["cft-aat-00", "cft-aat-01"] as const;

const GET_CREDENTIALS_TIMEOUT_MS = 120_000;

/** Named by subscription rather than by id, which is what every other CFT repo uses; `az` takes either. */
export function subscriptionFor(cluster: string): string | undefined {
  if (cluster.startsWith("cft-preview-")) {
    return PREVIEW_SUBSCRIPTION;
  }
  if (cluster.startsWith("cft-aat-")) {
    return AAT_SUBSCRIPTION;
  }
  return undefined;
}

/**
 * The clusters a pod is given, its own first so that it is in the file even if the others fail.
 *
 * Its own comes from `AGENT_HUB_CLUSTER`, which the orchestrator sets to the cluster it is running in. Preview runs
 * one cluster at a time and which one changes without notice, so a fixed list would go stale, and the pod cannot
 * work out where it is for itself — it has no API server to ask. A switchover recreates the pod on the new cluster
 * with the new name, so the contexts follow it.
 */
export function clustersFor(env: Env): string[] {
  const own = env.AGENT_HUB_CLUSTER;
  const rest = AAT_CLUSTERS.filter((cluster) => cluster !== own);
  return own ? [own, ...rest] : [...rest];
}

/** The context `kubectl` uses when an agent names none: the cluster the pod is in. */
export function contextFor(cluster: string): string {
  return `${cluster}-aks`;
}

export type KubeContextsResult = "configured" | "not-configured";

/**
 * Writes the pod's kubeconfig and selects its own cluster. Safe to run again at any time, and meant to be: an owner
 * with no live AKS access is the ordinary case rather than a failure, and an agent whose `kubectl` is refused can
 * run this again once they have elevated.
 */
export async function configureKubeContexts({ env = process.env }: { env?: Env } = {}): Promise<KubeContextsResult> {
  let added = 0;
  for (const cluster of clustersFor(env)) {
    const subscription = subscriptionFor(cluster);
    if (!subscription) {
      say(`kube: ${cluster}: no subscription is known for this cluster; skipped`);
      continue;
    }
    const got = await run(
      "az",
      [
        "aks",
        "get-credentials",
        "--subscription",
        subscription,
        "--resource-group",
        `${cluster}-rg`,
        "--name",
        contextFor(cluster),
        "--overwrite-existing",
        "--only-show-errors"
      ],
      { env, timeoutMs: GET_CREDENTIALS_TIMEOUT_MS }
    );
    if (got.code === 0) {
      added += 1;
    } else {
      say(`kube: ${cluster}: az aks get-credentials failed (exit ${got.code}); its context is not configured`);
    }
  }
  if (added === 0) {
    say("kube: no cluster answered get-credentials; kubectl is not configured");
    return "not-configured";
  }
  // Converts every entry at once, from the device-code login `az` writes to the `az` the pod is already signed in
  // as. Without it `kubectl` would try to relay a device code nobody is there to enter.
  const converted = await run("kubelogin", ["convert-kubeconfig", "-l", "azurecli"], { env });
  if (converted.code !== 0) {
    say(`kube: kubelogin could not convert the kubeconfig (exit ${converted.code}); kubectl would ask for a device code`);
    return "not-configured";
  }
  const own = env.AGENT_HUB_CLUSTER;
  const selected = own ? await run("kubectl", ["config", "use-context", contextFor(own)], { env }) : undefined;
  if (selected?.code === 0) {
    say(`kube: ${added} context(s) configured; the current one is ${contextFor(own as string)}`);
  } else {
    say(`kube: ${added} context(s) configured; there is no current context, so kubectl needs --context`);
  }
  return "configured";
}
