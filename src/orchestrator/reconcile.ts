import { FAILING_REASONS } from "../virtual-agents/lifecycle.ts";
import { type ClaimedAgent, type Hub, HubError, type ObservedBody } from "./hub.ts";
import type { Kind, Kinds, Kube, Pod, Resource } from "./kube.ts";
import { existingDisk, ID_LABEL, launchSecret, launchSecretName, MANAGED_BY, MANAGED_SELECTOR, podName, statefulSet, workPvcName } from "./manifests.ts";
import type { OrchestratorSettings } from "./settings.ts";

/**
 * One reconcile pass: claim what the hub has for this cluster, make the namespace match it, and report what is there.
 *
 * Stopping and deleting take a pod's grace period to finish, and the hub records only one observation per
 * generation that moves an agent on, so a stopped or deleted agent is reported once it has settled. Until then the
 * orchestrator holds the claim and looks again each pass; if it dies, the claim lapses after two minutes and the
 * agent is claimed again. A running agent is reported at once, and again whenever what is seen changes, until its
 * pod is ready or failing or `RUNNING_WATCH_MS` has passed, after which its own reports take over.
 */

export const RUNNING_WATCH_MS = 15 * 60_000;

/** A pod waits this long for a node before it is reported unschedulable, so a cluster scaling up does not fail it. */
export const SCHEDULING_GRACE_MS = 5 * 60_000;

export type Level = "info" | "warn" | "error";
export type Log = (level: Level, message: string, fields?: Record<string, unknown>) => void;

export interface ReconcileDeps {
  kube: Kube;
  hub: Hub;
  settings: OrchestratorSettings;
  log: Log;
  now?: () => number;
}

interface Watch {
  agent: ClaimedAgent;
  since: number;
  /** The last observation sent for a running agent, so an unchanged one is not sent again. */
  reported?: string;
}

export interface ReconcileState {
  passes: number;
  watching: Map<string, Watch>;
}

export interface PassResult {
  claimed: number;
  reported: number;
  errors: number;
  orphans: number;
}

export function initialState(): ReconcileState {
  return { passes: 0, watching: new Map() };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why the pod is not up, as the hub's lifecycle reads it: a failing container reason first, then a scheduling
 * failure once it has outlasted the grace period, then whatever the container is waiting on.
 */
export function podReason(pod: Pod | null, now: number): string | null {
  if (pod === null) {
    return null;
  }
  const status = pod.status ?? {};
  const container = status.containerStatuses?.find((candidate) => candidate.name === "agent");
  const current = container?.state?.waiting?.reason ?? container?.state?.terminated?.reason;
  if (current !== undefined && FAILING_REASONS.has(current)) {
    return current;
  }
  const unscheduled = status.conditions?.find(
    (condition) => condition.type === "PodScheduled" && condition.status === "False" && condition.reason === "Unschedulable"
  );
  if (unscheduled !== undefined) {
    const since = Date.parse(unscheduled.lastTransitionTime ?? "");
    if (Number.isNaN(since) || now - since >= SCHEDULING_GRACE_MS) {
      return "Unschedulable";
    }
  }
  return current ?? status.reason ?? null;
}

/** Whether what is seen is final for what the agent is meant to be, by the hub's lifecycle rules. */
export function settled(agent: ClaimedAgent, seen: ObservedBody): boolean {
  const gone = seen.replicas_ready === 0 && seen.pod_phase === null;
  switch (agent.desired) {
    case "running":
      return seen.replicas_ready > 0 || seen.pod_phase === "Failed" || (seen.reason !== null && FAILING_REASONS.has(seen.reason));
    case "stopped":
      return gone && (!agent.delete_disk || seen.disk_deleted);
    case "deleted":
      return gone && seen.disk_deleted;
  }
}

/**
 * The namespace is shared with other workloads (in preview, `dtsse`'s PR previews), so nothing is changed or deleted
 * by name alone: it must carry the orchestrator's label and, where the agent is known, that agent's id.
 */
export function owned(resource: Resource, id?: string): boolean {
  const tags = resource.metadata.labels ?? {};
  return tags["app.kubernetes.io/managed-by"] === MANAGED_BY && (id === undefined || tags[ID_LABEL] === id);
}

/** The hub's `pvc_name`, once it is known to be the PVC the StatefulSet's claim template makes; `undefined` if not. */
export function pvcNameOf(agent: { statefulset_name: string; pvc_name: string | null }): string | undefined {
  return agent.pvc_name === workPvcName(agent.statefulset_name) ? agent.pvc_name : undefined;
}

async function ownedOrAbsent<K extends Kind>(kube: Kube, kind: K, name: string, id: string): Promise<Kinds[K] | null> {
  const found = await kube.get(kind, name);
  if (found !== null && !owned(found, id)) {
    throw new Error(`refusing to touch ${kind} ${name}: it is not labelled as virtual agent ${id}'s`);
  }
  return found;
}

async function deleteOwned(kube: Kube, kind: Kind, name: string, id: string): Promise<void> {
  if ((await ownedOrAbsent(kube, kind, name, id)) !== null) {
    await kube.delete(kind, name);
  }
}

async function apply({ kube, settings }: ReconcileDeps, agent: ClaimedAgent, pvc: string): Promise<void> {
  const name = agent.statefulset_name;
  const secret = launchSecretName(name);
  switch (agent.desired) {
    case "running": {
      const existing = await ownedOrAbsent(kube, "statefulsets", name, agent.id);
      if (agent.launch_token !== undefined) {
        await ownedOrAbsent(kube, "secrets", secret, agent.id);
        await kube.apply("secrets", launchSecret({ ...agent, launch_token: agent.launch_token }, settings.namespace));
      }
      await kube.apply("statefulsets", statefulSet(agent, settings.agent, existingDisk(existing)));
      return;
    }
    case "stopped":
      if ((await ownedOrAbsent(kube, "statefulsets", name, agent.id)) !== null) {
        await kube.patchScale(name, 0);
      }
      if (agent.delete_disk) {
        await deleteOwned(kube, "persistentvolumeclaims", pvc, agent.id);
      }
      return;
    case "deleted":
      await deleteOwned(kube, "statefulsets", name, agent.id);
      await deleteOwned(kube, "secrets", secret, agent.id);
      await deleteOwned(kube, "persistentvolumeclaims", pvc, agent.id);
      return;
  }
}

async function look(kube: Kube, agent: ClaimedAgent, now: number): Promise<ObservedBody> {
  const name = agent.statefulset_name;
  const [found, pod, pvc] = await Promise.all([
    kube.get("statefulsets", name),
    kube.get("pods", podName(name)),
    kube.get("persistentvolumeclaims", agent.pvc_name)
  ]);
  return {
    generation: agent.generation,
    replicas_ready: found?.status?.readyReplicas ?? 0,
    pod_phase: pod?.status?.phase ?? (pod === null ? null : "Pending"),
    reason: podReason(pod, now),
    disk_deleted: pvc === null
  };
}

/** Reports on a watched agent when there is something to report; `true` once it needs no more watching. */
async function check({ kube, hub, log }: ReconcileDeps, watch: Watch, now: number): Promise<{ done: boolean; reported: boolean }> {
  const { agent } = watch;
  const seen = await look(kube, agent, now);
  const done = settled(agent, seen);
  if (agent.desired === "running") {
    const key = JSON.stringify(seen);
    const changed = key !== watch.reported;
    if (changed) {
      await hub.observed(agent.id, seen);
      watch.reported = key;
      log("info", "observed", { id: agent.id, ...seen });
    }
    return { done: done || now - watch.since >= RUNNING_WATCH_MS, reported: changed };
  }
  if (!done) {
    return { done: false, reported: false };
  }
  await hub.observed(agent.id, seen);
  log("info", "observed", { id: agent.id, desired: agent.desired, ...seen });
  return { done: true, reported: true };
}

/**
 * Deletes every StatefulSet, Secret and PVC labelled `app.kubernetes.io/managed-by=agent-hub-orchestrator` that the
 * hub no longer has an agent for, or no longer has a disk for. The label is what scopes the sweep in a namespace
 * other workloads share: anything without it is never listed, and is skipped if it is. Nothing is deleted unless the
 * hub has answered, so an outage cannot empty the namespace, and no PVC is deleted while any of the hub's PVC names
 * is not what the StatefulSets make, since the sweep would then take a live agent's disk for an orphan.
 */
export async function sweepOrphans({ kube, hub, log }: ReconcileDeps): Promise<number> {
  const live = await hub.live();
  const misnamed = live.filter((agent) => agent.pvc_name !== null && pvcNameOf(agent) === undefined);
  for (const agent of misnamed) {
    log("error", "THE HUB'S pvc_name IS NOT THE STATEFULSET'S PVC: not sweeping PVCs", {
      id: agent.id,
      pvc_name: agent.pvc_name,
      expected: workPvcName(agent.statefulset_name)
    });
  }
  const statefulSets = new Set(live.map((agent) => agent.statefulset_name));
  const secrets = new Set(live.map((agent) => launchSecretName(agent.statefulset_name)));
  const disks = new Set(live.flatMap((agent) => (agent.pvc_name === null ? [] : [agent.pvc_name])));
  const kinds: [Kind, Set<string>][] = [
    ["statefulsets", statefulSets],
    ["secrets", secrets]
  ];
  if (misnamed.length === 0) {
    kinds.push(["persistentvolumeclaims", disks]);
  }
  let deleted = 0;
  for (const [kind, keep] of kinds) {
    for (const resource of await kube.list(kind, MANAGED_SELECTOR)) {
      const name = resource.metadata.name;
      if (!owned(resource) || keep.has(name) || resource.metadata.deletionTimestamp !== undefined) {
        continue;
      }
      try {
        if (await kube.delete(kind, name)) {
          deleted += 1;
          log("info", "deleted an orphan", { kind, name });
        }
      } catch (error) {
        log("error", "could not delete an orphan", { kind, name, error: describe(error) });
      }
    }
  }
  return deleted;
}

/** Throws only when the claim does: one agent's failure is logged and the rest of the pass goes on. */
export async function reconcilePass(deps: ReconcileDeps, state: ReconcileState): Promise<PassResult> {
  const now = deps.now ?? Date.now;
  const { log } = deps;
  const result: PassResult = { claimed: 0, reported: 0, errors: 0, orphans: 0 };

  const claimed = await deps.hub.claim(deps.settings.cluster);
  result.claimed = claimed.length;
  for (const agent of claimed) {
    state.watching.delete(agent.id);
    const pvc = pvcNameOf(agent);
    if (pvc === undefined) {
      result.errors += 1;
      log("error", "THE HUB'S pvc_name IS NOT THE STATEFULSET'S PVC: leaving this agent alone", {
        id: agent.id,
        pvc_name: agent.pvc_name,
        expected: workPvcName(agent.statefulset_name)
      });
      continue;
    }
    try {
      await apply(deps, agent, pvc);
      state.watching.set(agent.id, { agent, since: now() });
      log("info", "applied", {
        id: agent.id,
        generation: agent.generation,
        desired: agent.desired,
        delete_disk: agent.delete_disk,
        launch_token: agent.launch_token !== undefined
      });
    } catch (error) {
      result.errors += 1;
      log("error", "could not apply", { id: agent.id, generation: agent.generation, desired: agent.desired, error: describe(error) });
    }
  }

  for (const watch of [...state.watching.values()]) {
    try {
      const { done, reported } = await check(deps, watch, now());
      if (reported) {
        result.reported += 1;
      }
      if (done) {
        state.watching.delete(watch.agent.id);
      }
    } catch (error) {
      result.errors += 1;
      // The hub no longer has the agent, or refuses this report: a newer claim brings whatever is still to do.
      if (error instanceof HubError && (error.status === 404 || error.status === 409)) {
        state.watching.delete(watch.agent.id);
      }
      log("error", "could not observe", { id: watch.agent.id, generation: watch.agent.generation, error: describe(error) });
    }
  }

  if (state.passes % deps.settings.orphanSweepEvery === 0) {
    try {
      result.orphans = await sweepOrphans(deps);
    } catch (error) {
      result.errors += 1;
      log("error", "could not sweep orphans", { error: describe(error) });
    }
  }
  state.passes += 1;
  return result;
}
