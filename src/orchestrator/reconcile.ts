import { FAILING_REASONS } from "../virtual-agents/lifecycle.ts";
import { type Claim, type ClaimedAgent, type Hub, HubError, type Lease, type ObservedBody } from "./hub.ts";
import type { Kube, Pod, Resource, StatefulSet } from "./kube.ts";
import { describeError, type Log } from "./log.ts";
import { carriedOver, ID_LABEL, MANAGED_BY, MANAGED_SELECTOR, podName, statefulSet } from "./manifests.ts";
import type { OrchestratorSettings } from "./settings.ts";

/**
 * One reconcile pass: claim what the hub has for this cluster, make the namespace match it, and report what is there.
 *
 * Stopping and deleting take a pod's grace period to finish, and the hub records only one observation per
 * generation that moves an agent on, so a stopped or deleted agent is reported once it has settled. Until then the
 * orchestrator holds the claim and looks again each pass; if it dies, the claim lapses after two minutes and the
 * agent is claimed again. A running agent is reported at once, and again whenever what is seen changes, until its
 * pod is ready or failing or `RUNNING_WATCH_MS` has passed, after which its own reports take over.
 *
 * Only the cluster holding the hub's orchestrator lease is given anything by a claim. Any other is on standby: it
 * reports nothing, and its orphan sweep also deletes what the hub has moved to another cluster.
 */

export const RUNNING_WATCH_MS = 15 * 60_000;

/** A pod waits this long for a node before it is reported unschedulable, so a cluster scaling up does not fail it. */
export const SCHEDULING_GRACE_MS = 5 * 60_000;

export type { Level, Log } from "./log.ts";

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
  /** The lease holder this cluster last stood by for, `null` once it was active, `undefined` before its first claim. */
  standby?: string | null;
}

export interface PassResult {
  claimed: number;
  reported: number;
  errors: number;
  orphans: number;
  /** The lease another cluster holds, when this pass was on standby. */
  standby?: Lease;
}

export function initialState(): ReconcileState {
  return { passes: 0, watching: new Map() };
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

async function ownedStatefulSet(kube: Kube, name: string, id: string): Promise<StatefulSet | null> {
  const found = await kube.get("statefulsets", name);
  if (found !== null && !owned(found, id)) {
    throw new Error(`refusing to touch StatefulSet ${name}: it is not labelled as virtual agent ${id}'s`);
  }
  return found;
}

/**
 * Running applies the StatefulSet with the claim's new launch token, or the one its pod already holds. Stopping
 * scales it to zero, which keeps the disk. Deleting the agent or its disk deletes the StatefulSet, and its PVC
 * retention policy deletes the disk with it.
 */
async function apply({ kube, settings }: ReconcileDeps, agent: ClaimedAgent): Promise<void> {
  const name = agent.statefulset_name;
  const existing = await ownedStatefulSet(kube, name, agent.id);
  if (agent.desired === "running") {
    const carried = carriedOver(existing);
    const launchToken = agent.launch_token ?? carried.launchToken;
    if (launchToken === undefined) {
      throw new Error("the claim has no launch token and the StatefulSet holds none; stop and start the agent to mint one");
    }
    await kube.apply("statefulsets", statefulSet(agent, settings.agent, launchToken, carried));
  } else if (existing === null) {
    return;
  } else if (agent.desired === "deleted" || agent.delete_disk) {
    await kube.delete("statefulsets", name);
  } else {
    await kube.patchScale(name, 0);
  }
}

/**
 * The orchestrator cannot read PVCs, so the disk counts as deleted once the StatefulSet that owns it is gone: its
 * retention policy deletes the PVC with it.
 */
async function look(kube: Kube, agent: ClaimedAgent, now: number): Promise<ObservedBody> {
  const name = agent.statefulset_name;
  const [found, pod] = await Promise.all([kube.get("statefulsets", name), kube.get("pods", podName(name))]);
  return {
    generation: agent.generation,
    replicas_ready: found?.status?.readyReplicas ?? 0,
    pod_phase: pod?.status?.phase ?? (pod === null ? null : "Pending"),
    reason: podReason(pod, now),
    disk_deleted: found === null
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
 * Deletes every StatefulSet labelled `app.kubernetes.io/managed-by=agent-hub-orchestrator` that the hub no longer
 * has an agent for, and with it that agent's disk. On standby it also deletes those of agents the hub has on another
 * cluster: they have started again there, on a fresh disk, and the pods here hold tokens the hub no longer accepts.
 * An agent with no cluster recorded is kept, since it may be this cluster's.
 *
 * The label is what scopes the sweep in a namespace other workloads share: anything without it is never listed, and
 * is skipped if it is. Nothing is deleted unless the hub has answered, so an outage cannot empty the namespace. One at
 * a time, as everything else the orchestrator does.
 */
export async function sweepOrphans({ kube, hub, settings, log }: ReconcileDeps, standby = false): Promise<number> {
  const live = new Map((await hub.live()).map((agent) => [agent.statefulset_name, agent.cluster]));
  let deleted = 0;
  for (const resource of await kube.list("statefulsets", MANAGED_SELECTOR)) {
    const name = resource.metadata.name;
    const cluster = live.get(name);
    const movedTo = standby && typeof cluster === "string" && cluster !== settings.cluster ? cluster : undefined;
    if (!owned(resource) || (live.has(name) && movedTo === undefined) || resource.metadata.deletionTimestamp !== undefined) {
      continue;
    }
    try {
      if (await kube.delete("statefulsets", name)) {
        deleted += 1;
        log("info", "deleted an orphan", { kind: "statefulsets", name, ...(movedTo === undefined ? {} : { moved_to: movedTo }) });
      }
    } catch (error) {
      log("error", "could not delete an orphan", { kind: "statefulsets", name, error: describeError(error) });
    }
  }
  return deleted;
}

/** Applies one claimed agent and starts watching it; `false` when it could not be applied. */
async function applyClaimed(deps: ReconcileDeps, state: ReconcileState, agent: ClaimedAgent, now: number): Promise<boolean> {
  const { log } = deps;
  state.watching.delete(agent.id);
  try {
    await apply(deps, agent);
  } catch (error) {
    log("error", "could not apply", { id: agent.id, generation: agent.generation, desired: agent.desired, error: describeError(error) });
    return false;
  }
  state.watching.set(agent.id, { agent, since: now });
  log("info", "applied", {
    id: agent.id,
    generation: agent.generation,
    desired: agent.desired,
    delete_disk: agent.delete_disk,
    launch_token: agent.launch_token !== undefined
  });
  return true;
}

type Checked = "reported" | "quiet" | "failed";

/** Looks at one watched agent, and stops watching it once it is done or the hub will not take its report. */
async function checkWatched(deps: ReconcileDeps, state: ReconcileState, watch: Watch, now: number): Promise<Checked> {
  try {
    const { done, reported } = await check(deps, watch, now);
    if (done) {
      state.watching.delete(watch.agent.id);
    }
    return reported ? "reported" : "quiet";
  } catch (error) {
    // The hub no longer has the agent, or refuses this report: a newer claim brings whatever is still to do.
    if (error instanceof HubError && (error.status === 404 || error.status === 409)) {
      state.watching.delete(watch.agent.id);
    }
    deps.log("error", "could not observe", { id: watch.agent.id, generation: watch.agent.generation, error: describeError(error) });
    return "failed";
  }
}

/** The number of orphans deleted, or `undefined` when the sweep failed. */
async function sweepSafely(deps: ReconcileDeps, standby: boolean): Promise<number | undefined> {
  try {
    return await sweepOrphans(deps, standby);
  } catch (error) {
    deps.log("error", "could not sweep orphans", { error: describeError(error) });
    return undefined;
  }
}

/** Logs when this cluster becomes active or goes on standby, and when the lease it stands by for changes hands. */
function noteLease({ settings, log }: ReconcileDeps, state: ReconcileState, claim: Claim): void {
  const standby = claim.active ? null : claim.lease.cluster;
  if (state.standby === standby) {
    return;
  }
  if (claim.active) {
    log("info", "active: this cluster holds the hub's orchestrator lease", { cluster: settings.cluster });
  } else {
    log("info", "on standby: another cluster holds the hub's orchestrator lease", {
      cluster: settings.cluster,
      holder: claim.lease.cluster,
      renewed_at: claim.lease.renewed_at,
      dropped_watches: state.watching.size
    });
  }
  state.standby = standby;
}

async function sweepIfDue(deps: ReconcileDeps, state: ReconcileState, result: PassResult, standby: boolean): Promise<void> {
  if (state.passes % deps.settings.orphanSweepEvery === 0) {
    const orphans = await sweepSafely(deps, standby);
    result.orphans = orphans ?? 0;
    result.errors += orphans === undefined ? 1 : 0;
  }
  state.passes += 1;
}

/**
 * Throws only when the claim does: one agent's failure is logged and the rest of the pass goes on. Agents are taken
 * one at a time, so the API server and the hub each see one request from the orchestrator at once.
 */
export async function reconcilePass(deps: ReconcileDeps, state: ReconcileState): Promise<PassResult> {
  const now = deps.now ?? Date.now;
  const result: PassResult = { claimed: 0, reported: 0, errors: 0, orphans: 0 };

  const claim = await deps.hub.claim(deps.settings.cluster);
  noteLease(deps, state, claim);
  if (!claim.active) {
    // The holder reports on these agents now, and the hub would take this cluster's reports as theirs.
    state.watching.clear();
    await sweepIfDue(deps, state, result, true);
    return { ...result, standby: claim.lease };
  }

  const claimed = claim.agents;
  result.claimed = claimed.length;
  for (const agent of claimed) {
    if (!(await applyClaimed(deps, state, agent, now()))) {
      result.errors += 1;
    }
  }

  for (const watch of state.watching.values()) {
    const checked = await checkWatched(deps, state, watch, now());
    result.reported += checked === "reported" ? 1 : 0;
    result.errors += checked === "failed" ? 1 : 0;
  }

  await sweepIfDue(deps, state, result, false);
  return result;
}
