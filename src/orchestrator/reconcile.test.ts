import { describe, expect, it } from "vitest";
import { type ClaimedAgent, type Hub, HubError, type LiveAgent, type ObservedBody } from "./hub.ts";
import { type Kind, type Kinds, type Kube, KubeError, type Pod, type Resource, type StatefulSet } from "./kube.ts";
import { labels, statefulSet } from "./manifests.ts";
import { initialState, type Log, podReason, RUNNING_WATCH_MS, reconcilePass, SCHEDULING_GRACE_MS, settled, sweepOrphans } from "./reconcile.ts";
import type { OrchestratorSettings } from "./settings.ts";

const ID = "0f8a6a1e-1234-4000-8000-000000000001";
const OTHER = "1a2b3c4d-1234-4000-8000-000000000002";

const SETTINGS: OrchestratorSettings = {
  cluster: "cft-preview-00",
  namespace: "dtsse",
  hubUrl: "https://hub",
  hubScope: "api://dtsse-agent-hub/.default",
  intervalMs: 10_000,
  orphanSweepEvery: 30,
  port: 8080,
  agent: {
    namespace: "dtsse",
    image: `registry/agent@sha256:${"c".repeat(64)}`,
    serviceAccount: "default",
    hubUrl: "https://hub",
    tenantId: "tenant",
    diskSize: "32Gi",
    storageClass: null
  }
};

function agent(overrides: Partial<ClaimedAgent> = {}): ClaimedAgent {
  const id = overrides.id ?? ID;
  return {
    id,
    generation: 1,
    desired: "running",
    statefulset_name: `va-${id.slice(0, 8)}`,
    pvc_name: `work-va-${id.slice(0, 8)}-0`,
    delete_disk: false,
    model_route: "gateway",
    owner: { oid: "owner" },
    ...overrides
  };
}

type Store = { [K in Kind]: Map<string, Kinds[K]> };

function fakeKube() {
  const store: Store = { statefulsets: new Map(), pods: new Map() };
  const calls: string[] = [];
  const failing = new Set<string>();
  const guard = (call: string) => {
    calls.push(call);
    if (failing.has(call)) {
      throw new KubeError(`${call} failed`, 500);
    }
  };
  const kube: Kube = {
    async get(kind, name) {
      guard(`get ${kind} ${name}`);
      return (store[kind].get(name) ?? null) as never;
    },
    async list(kind, selector) {
      guard(`list ${kind} ${selector}`);
      const [key, value] = selector.split("=");
      return [...store[kind].values()].filter((resource) => resource.metadata.labels?.[key!] === value) as never;
    },
    async apply(kind, body) {
      guard(`apply ${kind} ${body.metadata.name}`);
      (store[kind] as Map<string, Resource>).set(body.metadata.name, body);
      return body;
    },
    async delete(kind, name) {
      guard(`delete ${kind} ${name}`);
      return store[kind].delete(name);
    },
    async patchScale(name, replicas) {
      guard(`scale ${name} ${replicas}`);
      const found = store.statefulsets.get(name);
      if (found === undefined) {
        throw new KubeError("not found", 404);
      }
      found.spec = { ...found.spec, replicas };
    }
  };
  return { kube, store, calls, failing };
}

function fakeHub(claims: ClaimedAgent[][] = [], live: LiveAgent[] = []) {
  const observed: { id: string; body: ObservedBody }[] = [];
  const refusing = new Map<string, HubError>();
  let liveFails = false;
  const hub: Hub = {
    async claim() {
      return claims.shift() ?? [];
    },
    async observed(id, body) {
      const refusal = refusing.get(id);
      if (refusal !== undefined) {
        throw refusal;
      }
      observed.push({ id, body });
    },
    async live() {
      if (liveFails) {
        throw new Error("hub down");
      }
      return live;
    }
  };
  return {
    hub,
    observed,
    refusing,
    failLive() {
      liveFails = true;
    }
  };
}

function setup(claims: ClaimedAgent[][] = [], options: { live?: LiveAgent[]; now?: () => number } = {}) {
  const kube = fakeKube();
  const hub = fakeHub(claims, options.live ?? []);
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const log: Log = (level, message, fields) => logs.push({ level, message, fields });
  const state = initialState();
  state.passes = 1;
  const deps = { kube: kube.kube, hub: hub.hub, settings: SETTINGS, log, now: options.now };
  return { ...kube, ...hub, logs, state, deps, pass: () => reconcilePass(deps, state) };
}

function pod(phase: string, extra: Pod["status"] = {}): Pod {
  return { apiVersion: "v1", kind: "Pod", metadata: { name: "va-0f8a6a1e-0" }, status: { phase, ...extra } };
}

function waiting(reason: string): Pod {
  return pod("Pending", { containerStatuses: [{ name: "agent", state: { waiting: { reason } } }] });
}

function ready(set: StatefulSet | undefined, readyReplicas: number): void {
  set!.status = { readyReplicas };
}

describe("podReason", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");

  it("should be null when there is no pod", () => {
    expect(podReason(null, now)).toBeNull();
  });

  it.each([
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError"
  ])("should report %s when the container waits on it", (reason) => {
    expect(podReason(waiting(reason), now)).toBe(reason);
  });

  it("should report OOMKilled when the container has terminated with it", () => {
    expect(podReason(pod("Running", { containerStatuses: [{ name: "agent", state: { terminated: { reason: "OOMKilled" } } }] }), now)).toBe("OOMKilled");
  });

  it("should report the waiting reason when it is not a failure", () => {
    expect(podReason(waiting("ContainerCreating"), now)).toBe("ContainerCreating");
  });

  it("should prefer a failing container reason over a scheduling problem", () => {
    const failing = waiting("ErrImagePull");
    failing.status!.conditions = [{ type: "PodScheduled", status: "False", reason: "Unschedulable", lastTransitionTime: "2026-10-05T11:00:00Z" }];

    expect(podReason(failing, now)).toBe("ErrImagePull");
  });

  it("should report Unschedulable once the pod has waited past the grace period for a node", () => {
    const since = new Date(now - SCHEDULING_GRACE_MS).toISOString();

    expect(
      podReason(pod("Pending", { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", lastTransitionTime: since }] }), now)
    ).toBe("Unschedulable");
  });

  it("should report Unschedulable when the condition has no time", () => {
    expect(podReason(pod("Pending", { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] }), now)).toBe("Unschedulable");
  });

  it("should not report Unschedulable while the cluster may still be scaling up", () => {
    const since = new Date(now - 60_000).toISOString();

    expect(
      podReason(pod("Pending", { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", lastTransitionTime: since }] }), now)
    ).toBeNull();
  });

  it("should fall back to the pod's own reason when no container says anything", () => {
    expect(podReason(pod("Failed", { reason: "Evicted" }), now)).toBe("Evicted");
  });

  it("should be null when a pod has no status yet", () => {
    expect(podReason({ apiVersion: "v1", kind: "Pod", metadata: { name: "p" } }, now)).toBeNull();
  });
});

describe("settled", () => {
  const seen = (over: Partial<ObservedBody> = {}): ObservedBody => ({
    generation: 1,
    replicas_ready: 0,
    pod_phase: null,
    reason: null,
    disk_deleted: false,
    ...over
  });

  it.each([
    ["running", "a ready replica", agent(), seen({ replicas_ready: 1, pod_phase: "Running" }), true],
    ["running", "a failing reason", agent(), seen({ pod_phase: "Pending", reason: "ImagePullBackOff" }), true],
    ["running", "a failed pod", agent(), seen({ pod_phase: "Failed" }), true],
    ["running", "a pod still creating", agent(), seen({ pod_phase: "Pending", reason: "ContainerCreating" }), false],
    ["running", "no pod yet", agent(), seen(), false],
    ["stopped", "no pod", agent({ desired: "stopped" }), seen(), true],
    ["stopped", "a terminating pod", agent({ desired: "stopped" }), seen({ pod_phase: "Running" }), false],
    ["stopped", "a disk due for deletion still there", agent({ desired: "stopped", delete_disk: true }), seen(), false],
    ["stopped", "a disk due for deletion gone", agent({ desired: "stopped", delete_disk: true }), seen({ disk_deleted: true }), true],
    ["deleted", "the pod and the disk gone", agent({ desired: "deleted", delete_disk: true }), seen({ disk_deleted: true }), true],
    ["deleted", "the disk still there", agent({ desired: "deleted", delete_disk: true }), seen(), false],
    ["deleted", "a ready replica", agent({ desired: "deleted", delete_disk: true }), seen({ replicas_ready: 1, disk_deleted: true }), false]
  ])("should judge a %s agent with %s", (_desired, _label, claimed, observation, expected) => {
    expect(settled(claimed, observation)).toBe(expected);
  });
});

const STS = "va-0f8a6a1e";
const POD = "va-0f8a6a1e-0";

function existing(overrides: Partial<ClaimedAgent> = {}, token = "ahv_old"): StatefulSet {
  return statefulSet(agent(overrides), SETTINGS.agent, token);
}

function envOf(set: StatefulSet | undefined): Record<string, unknown> {
  const containers = (set?.spec as { template: { spec: { containers: { env: { name: string; value: unknown }[] }[] } } }).template.spec.containers;
  return Object.fromEntries(containers[0]!.env.map((entry) => [entry.name, entry.value]));
}

const GONE: ObservedBody = { generation: 0, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: true };

describe("reconcilePass", () => {
  it("should apply a one-replica StatefulSet holding the new launch token and report at once when a running agent is claimed with one", async () => {
    const t = setup([[agent({ launch_token: "ahv_new" })]]);

    expect(await t.pass()).toEqual({ claimed: 1, reported: 1, errors: 0, orphans: 0 });

    expect(t.store.statefulsets.get(STS)?.spec?.replicas).toBe(1);
    expect(envOf(t.store.statefulsets.get(STS)).AGENT_HUB_LAUNCH_TOKEN).toBe("ahv_new");
    expect(t.observed).toEqual([{ id: ID, body: { generation: 1, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: false } }]);
  });

  it("should replace the token the StatefulSet holds when the claim mints a new one", async () => {
    const t = setup([[agent({ generation: 4, launch_token: "ahv_new" })]]);
    t.store.statefulsets.set(STS, existing({ desired: "stopped", generation: 3 }));

    await t.pass();

    expect(envOf(t.store.statefulsets.get(STS)).AGENT_HUB_LAUNCH_TOKEN).toBe("ahv_new");
  });

  it("should keep the token the running pod holds when the claim returns none", async () => {
    const t = setup([[agent()]]);
    t.store.statefulsets.set(STS, existing());

    await t.pass();

    expect(envOf(t.store.statefulsets.get(STS)).AGENT_HUB_LAUNCH_TOKEN).toBe("ahv_old");
  });

  it("should fail the agent's apply when there is no token to give the pod", async () => {
    const t = setup([[agent()]]);

    expect(await t.pass()).toMatchObject({ errors: 1, reported: 0 });
    expect(t.store.statefulsets.size).toBe(0);
    expect(t.logs.find((entry) => entry.message === "could not apply")?.fields?.error).toMatch(/no launch token/);
  });

  it("should never log the launch token or the StatefulSet's spec", async () => {
    const t = setup([[agent({ launch_token: "ahv_new" })], [agent({ id: OTHER })]]);
    t.store.statefulsets.set("va-1a2b3c4d", existing({ id: OTHER }, "ahv_held"));

    await t.pass();
    await t.pass();

    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain("ahv_new");
    expect(logged).not.toContain("ahv_held");
    expect(logged).not.toContain("AGENT_HUB_URL");
    expect(t.logs.find((entry) => entry.message === "applied")?.fields).toMatchObject({ launch_token: true });
  });

  it("should keep an existing StatefulSet's disk when it applies the spec again", async () => {
    const t = setup([[agent({ generation: 2 })]]);
    t.store.statefulsets.set(STS, statefulSet(agent(), { ...SETTINGS.agent, diskSize: "16Gi" }, "ahv_old"));

    await t.pass();

    expect(JSON.stringify(t.store.statefulsets.get(STS))).toContain('"storage":"16Gi"');
  });

  it("should recreate the StatefulSet, and with it a fresh disk, when an agent whose disk expired is started", async () => {
    const t = setup([[agent({ generation: 5, launch_token: "ahv_new" })]]);

    await t.pass();

    expect(t.calls).toContain(`apply statefulsets ${STS}`);
    expect(JSON.stringify(t.store.statefulsets.get(STS))).toContain('"storage":"32Gi"');
  });

  it("should report a running agent again when what is seen changes, and stop watching once its pod is failing", async () => {
    const t = setup([[agent({ launch_token: "ahv_new" })]]);
    await t.pass();
    expect(t.observed).toHaveLength(1);

    await t.pass();
    expect(t.observed).toHaveLength(1);

    t.store.pods.set(POD, waiting("ImagePullBackOff"));
    await t.pass();
    expect(t.observed.at(-1)?.body).toMatchObject({ pod_phase: "Pending", reason: "ImagePullBackOff" });
    expect(t.state.watching.size).toBe(0);
  });

  it("should stop watching a running agent once a replica is ready", async () => {
    const t = setup([[agent({ launch_token: "ahv_new" })]]);
    await t.pass();

    ready(t.store.statefulsets.get(STS), 1);
    t.store.pods.set(POD, pod("Running"));
    await t.pass();

    expect(t.observed.at(-1)?.body).toMatchObject({ replicas_ready: 1, pod_phase: "Running" });
    expect(t.state.watching.size).toBe(0);
  });

  it("should stop watching a running agent that never comes up once the watch has run its course", async () => {
    let now = 0;
    const t = setup([[agent({ launch_token: "ahv_new" })]], { now: () => now });
    await t.pass();

    now = RUNNING_WATCH_MS;
    await t.pass();

    expect(t.state.watching.size).toBe(0);
  });

  it("should report a pod with no phase yet as Pending", async () => {
    const t = setup([[agent({ launch_token: "ahv_new" })]]);
    t.store.pods.set(POD, { apiVersion: "v1", kind: "Pod", metadata: { name: POD } });

    await t.pass();

    expect(t.observed[0]?.body.pod_phase).toBe("Pending");
  });

  it("should stop an agent by scaling it to zero, keeping the StatefulSet and its disk, and report once the pod has gone", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2 })]]);
    t.store.statefulsets.set(STS, existing());
    t.store.pods.set(POD, pod("Running"));

    expect(await t.pass()).toMatchObject({ claimed: 1, reported: 0 });
    expect(t.calls).toContain(`scale ${STS} 0`);
    expect(t.store.statefulsets.get(STS)?.spec?.replicas).toBe(0);
    expect(t.observed).toEqual([]);

    t.store.pods.delete(POD);
    await t.pass();

    expect(t.observed).toEqual([{ id: ID, body: { ...GONE, generation: 2, disk_deleted: false } }]);
    expect(t.calls.some((call) => call.startsWith("delete"))).toBe(false);
    expect(t.state.watching.size).toBe(0);
  });

  it("should report a stopped agent that never had a StatefulSet as stopped with no disk", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2 })]]);

    await t.pass();

    expect(t.calls.some((call) => /^(scale|delete|apply) /.test(call))).toBe(false);
    expect(t.observed).toEqual([{ id: ID, body: { ...GONE, generation: 2 } }]);
  });

  it("should delete a stopped agent's StatefulSet, and so its disk, when its disk has expired, and report it deleted once gone", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2, delete_disk: true })]]);
    t.store.statefulsets.set(STS, existing({ desired: "stopped" }));

    await t.pass();

    expect(t.calls).toContain(`delete statefulsets ${STS}`);
    expect(t.calls.some((call) => call.startsWith("scale"))).toBe(false);
    expect(t.observed).toEqual([{ id: ID, body: { ...GONE, generation: 2 } }]);
  });

  it("should delete a deleted agent's StatefulSet and report once it and its pod are gone", async () => {
    const t = setup([[agent({ desired: "deleted", generation: 3, delete_disk: true })]]);
    t.store.statefulsets.set(STS, existing());
    t.store.pods.set(POD, pod("Running"));

    await t.pass();
    expect(t.store.statefulsets.size).toBe(0);
    expect(t.observed).toEqual([]);
    expect(t.state.watching.has(ID)).toBe(true);

    t.store.pods.clear();
    await t.pass();
    expect(t.observed).toEqual([{ id: ID, body: { ...GONE, generation: 3 } }]);
  });

  it.each([
    ["deleted", agent({ desired: "deleted", delete_disk: true })],
    ["stopped", agent({ desired: "stopped" })],
    ["stopped with an expired disk", agent({ desired: "stopped", delete_disk: true })],
    ["running", agent({ launch_token: "ahv_new" })]
  ])("should refuse to touch a StatefulSet of the same name not labelled as the agent's when it is %s", async (_label, claimed) => {
    const t = setup([[claimed]]);
    t.store.statefulsets.set(STS, { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: STS, labels: { app: "dtsse-pr-1234" } } });

    expect(await t.pass()).toMatchObject({ errors: 1 });

    expect(t.store.statefulsets.get(STS)?.metadata.labels).toEqual({ app: "dtsse-pr-1234" });
    expect(t.calls.some((call) => /^(apply|delete|scale) /.test(call))).toBe(false);
    expect(t.logs.find((entry) => entry.message === "could not apply")?.fields?.error).toMatch(/refusing to touch/);
  });

  it("should refuse to touch a StatefulSet labelled as another virtual agent's", async () => {
    const t = setup([[agent({ desired: "deleted", delete_disk: true })]]);
    t.store.statefulsets.set(STS, { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: STS, labels: labels(OTHER) } });

    expect(await t.pass()).toMatchObject({ errors: 1 });
    expect(t.store.statefulsets.has(STS)).toBe(true);
  });

  it("should carry on with the other agents when one cannot be applied", async () => {
    const t = setup([[agent({ launch_token: "a" }), agent({ id: OTHER, launch_token: "b" })]]);
    t.failing.add(`apply statefulsets ${STS}`);

    expect(await t.pass()).toEqual({ claimed: 2, reported: 1, errors: 1, orphans: 0 });

    expect(t.observed.map((entry) => entry.id)).toEqual([OTHER]);
    expect(t.state.watching.has(ID)).toBe(false);
    expect(t.logs.find((entry) => entry.level === "error")).toMatchObject({ message: "could not apply", fields: { id: ID } });
  });

  it("should count a scaling failure as that agent's error", async () => {
    const t = setup([[agent({ desired: "stopped" })]]);
    t.store.statefulsets.set(STS, existing());
    t.failing.add(`scale ${STS} 0`);

    expect(await t.pass()).toMatchObject({ errors: 1, reported: 0 });
  });

  it("should carry on with the other agents when one cannot be observed, and keep watching it", async () => {
    const t = setup([[agent({ launch_token: "a" }), agent({ id: OTHER, launch_token: "b" })]]);
    t.failing.add(`get pods ${POD}`);

    expect(await t.pass()).toMatchObject({ errors: 1, reported: 1 });
    expect(t.state.watching.has(ID)).toBe(true);
    expect(t.logs.find((entry) => entry.message === "could not observe")?.fields).toMatchObject({ id: ID, error: `get pods ${POD} failed` });
  });

  it.each([404, 409])("should stop watching an agent when the hub refuses its report with %i", async (status) => {
    const t = setup([[agent({ launch_token: "a" })]]);
    t.refusing.set(ID, new HubError("refused", status));

    expect(await t.pass()).toMatchObject({ errors: 1 });
    expect(t.state.watching.size).toBe(0);
  });

  it("should keep watching an agent when the hub fails its report otherwise", async () => {
    const t = setup([[agent({ launch_token: "a" })]]);
    t.refusing.set(ID, new HubError("unavailable", 503));

    await t.pass();

    expect(t.state.watching.has(ID)).toBe(true);
  });

  it("should replace a watch when the agent is claimed again", async () => {
    const t = setup([[agent({ launch_token: "a" })], [agent({ desired: "stopped", generation: 2 })]]);
    await t.pass();
    expect(t.state.watching.get(ID)?.agent.desired).toBe("running");

    await t.pass();

    expect(t.observed.at(-1)).toEqual({ id: ID, body: expect.objectContaining({ generation: 2 }) });
  });

  it("should fail the whole pass when the claim fails", async () => {
    const t = setup();
    t.hub.claim = async () => {
      throw new Error("hub down");
    };

    await expect(t.pass()).rejects.toThrow("hub down");
  });

  it("should sweep orphans on the first pass and every orphanSweepEvery passes after", async () => {
    const t = setup();
    t.state.passes = 0;
    const swept: number[] = [];
    for (let pass = 0; pass < 61; pass += 1) {
      const before = t.calls.length;
      await t.pass();
      if (t.calls.slice(before).some((call) => call.startsWith("list"))) {
        swept.push(pass);
      }
    }

    expect(swept).toEqual([0, 30, 60]);
  });

  it("should count orphans the sweep deleted", async () => {
    const t = setup();
    t.state.passes = 0;
    t.store.statefulsets.set(STS, existing());

    expect(await t.pass()).toMatchObject({ orphans: 1, errors: 0 });
  });

  it("should count a failed sweep as an error without failing the pass", async () => {
    const t = setup();
    t.state.passes = 0;
    t.failLive();

    expect(await t.pass()).toMatchObject({ errors: 1, orphans: 0 });
    expect(t.logs.at(-1)).toMatchObject({ message: "could not sweep orphans", fields: { error: "hub down" } });
  });
});

describe("sweepOrphans", () => {
  function managed(name: string, id: string, deleting = false): StatefulSet {
    return {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name, labels: labels(id), ...(deleting ? { deletionTimestamp: "2026-10-05T00:00:00Z" } : {}) }
    };
  }

  function populate(store: Store): void {
    store.statefulsets.set(STS, managed(STS, ID));
    store.statefulsets.set("va-1a2b3c4d", managed("va-1a2b3c4d", OTHER));
  }

  it("should delete the StatefulSets that belong to no live agent and keep those that do", async () => {
    const t = setup([], { live: [{ id: ID, statefulset_name: STS, pvc_name: "work-va-0f8a6a1e-0" }] });
    populate(t.store);

    expect(await sweepOrphans(t.deps)).toBe(1);

    expect([...t.store.statefulsets.keys()]).toEqual([STS]);
    expect(t.calls.filter((call) => call.startsWith("list"))).toEqual(["list statefulsets app.kubernetes.io/managed-by=agent-hub-orchestrator"]);
  });

  it("should keep a live agent's StatefulSet when the hub has recorded its disk deleted", async () => {
    const t = setup([], { live: [{ id: ID, statefulset_name: STS, pvc_name: null }] });
    t.store.statefulsets.set(STS, managed(STS, ID));

    expect(await sweepOrphans(t.deps)).toBe(0);
  });

  it("should list only what carries the orchestrator's label and never delete anything unlabelled", async () => {
    const t = setup();
    t.store.statefulsets.set("dtsse-pr-1234", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "dtsse-pr-1234" } });

    expect(await sweepOrphans(t.deps)).toBe(0);
    expect(t.calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("should skip anything unlabelled even when the API returns it for the selector", async () => {
    const t = setup();
    t.store.statefulsets.set("dtsse-pr-1234", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "dtsse-pr-1234" } });
    t.deps.kube.list = async (kind) => [...t.store[kind].values()] as never;

    expect(await sweepOrphans(t.deps)).toBe(0);
    expect(t.store.statefulsets.has("dtsse-pr-1234")).toBe(true);
  });

  it("should leave alone what is already being deleted", async () => {
    const t = setup();
    t.store.statefulsets.set(STS, managed(STS, ID, true));

    expect(await sweepOrphans(t.deps)).toBe(0);
    expect(t.calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("should not count what had already gone when it came to delete it", async () => {
    const t = setup();
    t.store.statefulsets.set(STS, managed(STS, ID));
    const original = t.deps.kube.delete;
    t.deps.kube.delete = async (kind, name) => {
      await original(kind, name);
      return false;
    };

    expect(await sweepOrphans(t.deps)).toBe(0);
  });

  it("should carry on when one orphan cannot be deleted", async () => {
    const t = setup();
    populate(t.store);
    t.failing.add(`delete statefulsets ${STS}`);

    expect(await sweepOrphans(t.deps)).toBe(1);
    expect(t.logs.find((entry) => entry.level === "error")?.fields).toMatchObject({ kind: "statefulsets", name: STS });
  });

  it("should delete nothing when the hub cannot say what is live", async () => {
    const t = setup();
    populate(t.store);
    t.failLive();

    await expect(sweepOrphans(t.deps)).rejects.toThrow("hub down");
    expect(t.store.statefulsets.size).toBe(2);
  });
});
