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
  namespace: "virtual-agents",
  hubUrl: "https://hub",
  hubScope: "api://dtsse-agent-hub/.default",
  intervalMs: 10_000,
  orphanSweepEvery: 30,
  port: 8080,
  agent: {
    namespace: "virtual-agents",
    image: `registry/agent@sha256:${"c".repeat(64)}`,
    serviceAccount: "virtual-agent",
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
  const store: Store = { statefulsets: new Map(), secrets: new Map(), persistentvolumeclaims: new Map(), pods: new Map() };
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

const PVC: Resource = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "work-va-0f8a6a1e-0", labels: labels(ID) } };

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

describe("reconcilePass", () => {
  it("should apply the launch Secret and a one-replica StatefulSet and report at once when a running agent is claimed with a token", async () => {
    const t = setup([[agent({ launch_token: "ahv_token" })]]);

    expect(await t.pass()).toEqual({ claimed: 1, reported: 1, errors: 0, orphans: 0 });

    expect(t.store.secrets.get("va-0f8a6a1e-launch")?.data).toEqual({ token: Buffer.from("ahv_token").toString("base64") });
    expect(t.store.statefulsets.get("va-0f8a6a1e")?.spec?.replicas).toBe(1);
    expect(t.observed).toEqual([{ id: ID, body: { generation: 1, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: true } }]);
  });

  it("should leave the Secret alone when the claim returns no token", async () => {
    const t = setup([[agent()]]);

    await t.pass();

    expect(t.store.secrets.size).toBe(0);
    expect(t.calls.some((call) => call.startsWith("apply secrets"))).toBe(false);
    expect(t.store.statefulsets.has("va-0f8a6a1e")).toBe(true);
  });

  it("should never log the launch token", async () => {
    const t = setup([[agent({ launch_token: "ahv_token" })]]);

    await t.pass();

    expect(JSON.stringify(t.logs)).not.toContain("ahv_token");
    expect(t.logs.find((entry) => entry.message === "applied")?.fields).toMatchObject({ launch_token: true });
  });

  it("should keep an existing StatefulSet's disk when it applies the spec again", async () => {
    const t = setup([[agent({ generation: 2 })]]);
    t.store.statefulsets.set("va-0f8a6a1e", statefulSet(agent(), { ...SETTINGS.agent, diskSize: "16Gi" }));

    await t.pass();

    expect(JSON.stringify(t.store.statefulsets.get("va-0f8a6a1e"))).toContain('"storage":"16Gi"');
  });

  it("should report a running agent again when what is seen changes, and stop watching once its pod is failing", async () => {
    const t = setup([[agent()]]);
    await t.pass();
    expect(t.observed).toHaveLength(1);

    await t.pass();
    expect(t.observed).toHaveLength(1);

    t.store.pods.set("va-0f8a6a1e-0", waiting("ImagePullBackOff"));
    await t.pass();
    expect(t.observed.at(-1)?.body).toMatchObject({ pod_phase: "Pending", reason: "ImagePullBackOff" });

    t.store.pods.set("va-0f8a6a1e-0", waiting("ErrImagePull"));
    await t.pass();
    expect(t.observed).toHaveLength(2);
    expect(t.state.watching.size).toBe(0);
  });

  it("should stop watching a running agent once a replica is ready", async () => {
    const t = setup([[agent()]]);
    await t.pass();

    ready(t.store.statefulsets.get("va-0f8a6a1e"), 1);
    t.store.pods.set("va-0f8a6a1e-0", pod("Running"));
    await t.pass();

    expect(t.observed.at(-1)?.body).toMatchObject({ replicas_ready: 1, pod_phase: "Running" });
    expect(t.state.watching.size).toBe(0);
  });

  it("should stop watching a running agent that never comes up once the watch has run its course", async () => {
    let now = 0;
    const t = setup([[agent()]], { now: () => now });
    await t.pass();

    now = RUNNING_WATCH_MS;
    await t.pass();

    expect(t.state.watching.size).toBe(0);
  });

  it("should report a pod with no phase yet as Pending", async () => {
    const t = setup([[agent()]]);
    t.store.pods.set("va-0f8a6a1e-0", { apiVersion: "v1", kind: "Pod", metadata: { name: "va-0f8a6a1e-0" } });

    await t.pass();

    expect(t.observed[0]?.body.pod_phase).toBe("Pending");
  });

  it("should scale a stopped agent to zero and report only once its pod has gone", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2 })]]);
    t.store.statefulsets.set("va-0f8a6a1e", statefulSet(agent(), SETTINGS.agent));
    t.store.pods.set("va-0f8a6a1e-0", pod("Running"));
    t.store.persistentvolumeclaims.set("work-va-0f8a6a1e-0", PVC);

    expect(await t.pass()).toMatchObject({ claimed: 1, reported: 0 });
    expect(t.store.statefulsets.get("va-0f8a6a1e")?.spec?.replicas).toBe(0);
    expect(t.observed).toEqual([]);

    t.store.pods.delete("va-0f8a6a1e-0");
    await t.pass();

    expect(t.observed).toEqual([{ id: ID, body: { generation: 2, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: false } }]);
    expect(t.store.persistentvolumeclaims.has("work-va-0f8a6a1e-0")).toBe(true);
    expect(t.state.watching.size).toBe(0);
  });

  it("should report a stopped agent that never had a StatefulSet as stopped with no disk", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2 })]]);

    await t.pass();

    expect(t.calls.some((call) => call.startsWith("scale"))).toBe(false);
    expect(t.observed).toEqual([{ id: ID, body: { generation: 2, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: true } }]);
  });

  it("should delete a stopped agent's expired disk and report it deleted", async () => {
    const t = setup([[agent({ desired: "stopped", generation: 2, delete_disk: true })]]);
    t.store.statefulsets.set("va-0f8a6a1e", statefulSet(agent({ desired: "stopped" }), SETTINGS.agent));
    t.store.persistentvolumeclaims.set("work-va-0f8a6a1e-0", PVC);

    await t.pass();

    expect(t.calls.indexOf("scale va-0f8a6a1e 0")).toBeLessThan(t.calls.indexOf("delete persistentvolumeclaims work-va-0f8a6a1e-0"));
    expect(t.store.persistentvolumeclaims.size).toBe(0);
    expect(t.store.statefulsets.has("va-0f8a6a1e")).toBe(true);
    expect(t.observed[0]?.body).toMatchObject({ disk_deleted: true });
  });

  it("should delete a deleted agent's StatefulSet, Secret and disk and report once they are gone", async () => {
    const t = setup([[agent({ desired: "deleted", generation: 3, delete_disk: true })]]);
    t.store.statefulsets.set("va-0f8a6a1e", statefulSet(agent(), SETTINGS.agent));
    t.store.secrets.set("va-0f8a6a1e-launch", { apiVersion: "v1", kind: "Secret", metadata: { name: "va-0f8a6a1e-launch", labels: labels(ID) } });
    t.store.persistentvolumeclaims.set("work-va-0f8a6a1e-0", PVC);

    await t.pass();

    expect([t.store.statefulsets.size, t.store.secrets.size, t.store.persistentvolumeclaims.size]).toEqual([0, 0, 0]);
    expect(t.observed).toEqual([{ id: ID, body: { generation: 3, replicas_ready: 0, pod_phase: null, reason: null, disk_deleted: true } }]);
  });

  it("should hold a deleted agent's report while its pod is still terminating", async () => {
    const t = setup([[agent({ desired: "deleted", generation: 3, delete_disk: true })]]);
    t.store.pods.set("va-0f8a6a1e-0", pod("Running"));

    await t.pass();
    expect(t.observed).toEqual([]);
    expect(t.state.watching.has(ID)).toBe(true);

    t.store.pods.clear();
    await t.pass();
    expect(t.observed).toHaveLength(1);
  });

  it("should carry on with the other agents when one cannot be applied", async () => {
    const t = setup([[agent(), agent({ id: OTHER })]]);
    t.failing.add("apply statefulsets va-0f8a6a1e");

    expect(await t.pass()).toEqual({ claimed: 2, reported: 1, errors: 1, orphans: 0 });

    expect(t.observed.map((entry) => entry.id)).toEqual([OTHER]);
    expect(t.state.watching.has(ID)).toBe(false);
    expect(t.logs.find((entry) => entry.level === "error")).toMatchObject({ message: "could not apply", fields: { id: ID } });
  });

  it("should count a scaling failure as that agent's error", async () => {
    const t = setup([[agent({ desired: "stopped" })]]);
    t.store.statefulsets.set("va-0f8a6a1e", statefulSet(agent(), SETTINGS.agent));
    t.failing.add("scale va-0f8a6a1e 0");

    expect(await t.pass()).toMatchObject({ errors: 1, reported: 0 });
  });

  it("should carry on with the other agents when one cannot be observed, and keep watching it", async () => {
    const t = setup([[agent(), agent({ id: OTHER })]]);
    t.failing.add("get pods va-0f8a6a1e-0");

    expect(await t.pass()).toMatchObject({ errors: 1, reported: 1 });
    expect(t.state.watching.has(ID)).toBe(true);
    expect(t.logs.find((entry) => entry.message === "could not observe")?.fields).toMatchObject({ id: ID, error: "get pods va-0f8a6a1e-0 failed" });
  });

  it.each([404, 409])("should stop watching an agent when the hub refuses its report with %i", async (status) => {
    const t = setup([[agent()]]);
    t.refusing.set(ID, new HubError("refused", status));

    expect(await t.pass()).toMatchObject({ errors: 1 });
    expect(t.state.watching.size).toBe(0);
  });

  it("should keep watching an agent when the hub fails its report otherwise", async () => {
    const t = setup([[agent()]]);
    t.refusing.set(ID, new HubError("unavailable", 503));

    await t.pass();

    expect(t.state.watching.has(ID)).toBe(true);
  });

  it("should replace a watch when the agent is claimed again", async () => {
    const t = setup([[agent()], [agent({ desired: "stopped", generation: 2 })]]);
    await t.pass();
    expect(t.state.watching.get(ID)?.agent.desired).toBe("running");

    await t.pass();

    expect(t.observed.at(-1)).toEqual({ id: ID, body: expect.objectContaining({ generation: 2 }) });
  });

  it("should leave an agent alone and say so loudly when the hub's pvc_name is not the StatefulSet's PVC", async () => {
    const t = setup([[agent({ desired: "deleted", delete_disk: true, pvc_name: "va-0f8a6a1e" }), agent({ id: OTHER })]]);
    t.store.persistentvolumeclaims.set("va-0f8a6a1e", { ...PVC, metadata: { ...PVC.metadata, name: "va-0f8a6a1e" } });

    expect(await t.pass()).toMatchObject({ claimed: 2, errors: 1, reported: 1 });

    expect(t.calls.some((call) => call.includes("va-0f8a6a1e"))).toBe(false);
    expect(t.state.watching.has(ID)).toBe(false);
    expect(t.logs.find((entry) => entry.level === "error")).toMatchObject({
      message: expect.stringContaining("pvc_name IS NOT THE STATEFULSET'S PVC"),
      fields: { id: ID, pvc_name: "va-0f8a6a1e", expected: "work-va-0f8a6a1e-0" }
    });
  });

  it.each([
    ["StatefulSet", "statefulsets", "va-0f8a6a1e", agent({ desired: "deleted", delete_disk: true })],
    ["Secret", "secrets", "va-0f8a6a1e-launch", agent({ desired: "deleted", delete_disk: true })],
    ["PVC", "persistentvolumeclaims", "work-va-0f8a6a1e-0", agent({ desired: "stopped", delete_disk: true })],
    ["StatefulSet", "statefulsets", "va-0f8a6a1e", agent({ desired: "stopped" })],
    ["StatefulSet", "statefulsets", "va-0f8a6a1e", agent()],
    ["Secret", "secrets", "va-0f8a6a1e-launch", agent({ launch_token: "ahv_token" })]
  ] as const)("should refuse to touch a %s of the same name that is not labelled as the agent's", async (_label, kind, name, claimed) => {
    const t = setup([[claimed]]);
    (t.store[kind] as Map<string, Resource>).set(name, { apiVersion: "v1", kind: "Other", metadata: { name, labels: { app: "dtsse-pr-1234" } } });

    expect(await t.pass()).toMatchObject({ errors: 1 });

    expect(t.store[kind].has(name)).toBe(true);
    expect(t.calls.some((call) => /^(apply|delete|scale) /.test(call))).toBe(false);
    expect(t.logs.find((entry) => entry.message === "could not apply")?.fields?.error).toMatch(/refusing to touch/);
  });

  it("should refuse to touch a resource labelled as another virtual agent's", async () => {
    const t = setup([[agent({ desired: "deleted", delete_disk: true })]]);
    t.store.statefulsets.set("va-0f8a6a1e", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "va-0f8a6a1e", labels: labels(OTHER) } });

    expect(await t.pass()).toMatchObject({ errors: 1 });
    expect(t.store.statefulsets.has("va-0f8a6a1e")).toBe(true);
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

  it("should count a failed sweep as an error without failing the pass", async () => {
    const t = setup();
    t.state.passes = 0;
    t.failLive();

    expect(await t.pass()).toMatchObject({ errors: 1, orphans: 0 });
    expect(t.logs.at(-1)).toMatchObject({ message: "could not sweep orphans", fields: { error: "hub down" } });
  });
});

describe("sweepOrphans", () => {
  function resource(kind: string, name: string, id: string, deleting = false): Resource {
    return { apiVersion: "v1", kind, metadata: { name, labels: labels(id), ...(deleting ? { deletionTimestamp: "2026-10-05T00:00:00Z" } : {}) } };
  }

  function populate(store: Store): void {
    for (const [id, sts] of [
      [ID, "va-0f8a6a1e"],
      [OTHER, "va-1a2b3c4d"]
    ]) {
      store.statefulsets.set(sts!, resource("StatefulSet", sts!, id!));
      store.secrets.set(`${sts}-launch`, resource("Secret", `${sts}-launch`, id!));
      store.persistentvolumeclaims.set(`work-${sts}-0`, resource("PersistentVolumeClaim", `work-${sts}-0`, id!));
    }
  }

  it("should delete what belongs to no live agent and keep what does", async () => {
    const t = setup([], { live: [{ id: ID, statefulset_name: "va-0f8a6a1e", pvc_name: "work-va-0f8a6a1e-0" }] });
    populate(t.store);

    expect(await sweepOrphans(t.deps)).toBe(3);

    expect([...t.store.statefulsets.keys()]).toEqual(["va-0f8a6a1e"]);
    expect([...t.store.secrets.keys()]).toEqual(["va-0f8a6a1e-launch"]);
    expect([...t.store.persistentvolumeclaims.keys()]).toEqual(["work-va-0f8a6a1e-0"]);
    expect(t.calls).toContain("list statefulsets app.kubernetes.io/managed-by=agent-hub-orchestrator");
  });

  it("should delete a live agent's disk when the hub has recorded it deleted", async () => {
    const t = setup([], {
      live: [
        { id: ID, statefulset_name: "va-0f8a6a1e", pvc_name: null },
        { id: OTHER, statefulset_name: "va-1a2b3c4d", pvc_name: "work-va-1a2b3c4d-0" }
      ]
    });
    populate(t.store);

    expect(await sweepOrphans(t.deps)).toBe(1);
    expect([...t.store.persistentvolumeclaims.keys()]).toEqual(["work-va-1a2b3c4d-0"]);
  });

  it("should leave alone what is already being deleted", async () => {
    const t = setup();
    t.store.persistentvolumeclaims.set("work-va-0f8a6a1e-0", resource("PersistentVolumeClaim", "work-va-0f8a6a1e-0", ID, true));

    expect(await sweepOrphans(t.deps)).toBe(0);
    expect(t.calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("should not count what had already gone when it came to delete it", async () => {
    const t = setup();
    t.store.statefulsets.set("va-0f8a6a1e", resource("StatefulSet", "va-0f8a6a1e", ID));
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
    t.failing.add("delete statefulsets va-0f8a6a1e");

    expect(await sweepOrphans(t.deps)).toBe(5);
    expect(t.logs.find((entry) => entry.level === "error")?.fields).toMatchObject({ kind: "statefulsets", name: "va-0f8a6a1e" });
  });

  it("should list only what carries the orchestrator's label and never delete anything unlabelled", async () => {
    const t = setup();
    t.store.statefulsets.set("dtsse-pr-1234", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "dtsse-pr-1234" } });
    t.store.secrets.set("dtsse-pr-1234-values", { apiVersion: "v1", kind: "Secret", metadata: { name: "dtsse-pr-1234-values", labels: { app: "x" } } });
    t.store.persistentvolumeclaims.set("data-dtsse-pr-1234-0", { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "data-dtsse-pr-1234-0" } });

    expect(await sweepOrphans(t.deps)).toBe(0);

    expect(t.calls.filter((call) => call.startsWith("list"))).toEqual([
      "list statefulsets app.kubernetes.io/managed-by=agent-hub-orchestrator",
      "list secrets app.kubernetes.io/managed-by=agent-hub-orchestrator",
      "list persistentvolumeclaims app.kubernetes.io/managed-by=agent-hub-orchestrator"
    ]);
    expect(t.calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("should skip anything unlabelled even when the API returns it for the selector", async () => {
    const t = setup();
    t.store.statefulsets.set("dtsse-pr-1234", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "dtsse-pr-1234" } });
    t.deps.kube.list = async (kind) => [...t.store[kind].values()] as never;

    expect(await sweepOrphans(t.deps)).toBe(0);
    expect(t.store.statefulsets.has("dtsse-pr-1234")).toBe(true);
  });

  it("should sweep no PVCs and say so loudly when any of the hub's pvc_names is not the StatefulSet's PVC", async () => {
    const t = setup([], {
      live: [
        { id: ID, statefulset_name: "va-0f8a6a1e", pvc_name: "va-0f8a6a1e" },
        { id: OTHER, statefulset_name: "va-1a2b3c4d", pvc_name: null }
      ]
    });
    populate(t.store);

    expect(await sweepOrphans(t.deps)).toBe(0);

    expect(t.store.persistentvolumeclaims.size).toBe(2);
    expect(t.calls).not.toContain("list persistentvolumeclaims app.kubernetes.io/managed-by=agent-hub-orchestrator");
    expect(t.logs.find((entry) => entry.level === "error")?.fields).toMatchObject({ id: ID, expected: "work-va-0f8a6a1e-0" });
  });

  it("should delete nothing when the hub cannot say what is live", async () => {
    const t = setup();
    populate(t.store);
    t.failLive();

    await expect(sweepOrphans(t.deps)).rejects.toThrow("hub down");
    expect(t.store.statefulsets.size).toBe(2);
  });
});
