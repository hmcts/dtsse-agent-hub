import { describe, expect, it, vi } from "vitest";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as liveRoute from "../../src/app/api/orchestrator/live/route.ts";
import * as applyFailedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/apply-failed/route.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { APPLY_FAILURES_BEFORE_FAILED } from "../../src/virtual-agents/lifecycle.ts";
import {
  type ClaimedVirtualAgent,
  claimVirtualAgents,
  findVirtualAgent,
  observeVirtualAgent,
  recordApplyError,
  setDesired,
  setVirtualAgentSize
} from "../../src/virtual-agents/store.ts";
import { prisma } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import {
  ALICE,
  BOB,
  CAROL,
  claim,
  claimedBy,
  create,
  GATEWAY_APIM_KEY,
  homeOf,
  LATER,
  observe,
  orchestrator,
  pod,
  row,
  started,
  status,
  virtualAgentSuite
} from "./virtual-agent-suite.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

virtualAgentSuite();

describe("POST /api/orchestrator/claim", () => {
  it("should let only one of two clusters claiming at once take the lease, and give it everything due", async () => {
    const ids: string[] = [];
    for (const owner of [ALICE, BOB, CAROL]) {
      ids.push((await create(owner, "one")).id, (await create(owner, "two")).id);
    }

    const results = await Promise.all([claimVirtualAgents(prisma, "cluster-a"), claimVirtualAgents(prisma, "cluster-b")]);

    const active = results.filter((result) => result.active);
    const standby = results.filter((result) => !result.active);
    expect(active).toHaveLength(1);
    expect(standby).toEqual([
      { active: false, virtual_agents: [], lease: { cluster: expect.stringMatching(/^cluster-[ab]$/), renewed_at: expect.any(String) } }
    ]);
    expect(active[0]!.virtual_agents.map((entry) => entry.id).sort(byCodePoint)).toEqual([...ids].sort(byCodePoint));
  });

  it("should pass the gateway route to the orchestrator when the agent is on it", async () => {
    await create(ALICE, "pcs-api", "gateway");

    const [claimed] = await claim();

    expect(claimed?.model_route).toBe("gateway");
  });

  // The hub reads the APIM subscription key and hands it to the orchestrator here, which is what keeps the one value
  // hai cannot fetch for itself in this repository's chart rather than in the orchestrator's own Deployment.
  it("should pass the gateway route to the orchestrator with the APIM key when a gateway is configured", async () => {
    await create(ALICE, "pcs-api", "gateway");

    const [claimed] = await claim();

    expect(claimed?.model_route).toBe("gateway");
    expect(claimed?.gateway).toEqual({ apim_key: GATEWAY_APIM_KEY });
  });

  // The pod gives its agent this host's URLs to hand out, in place of the VPN-only ones.
  it("should tell the orchestrator the viewer's host when the viewer is on, and nothing when it is off", async () => {
    await create(ALICE, "pcs-api", "gateway");
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "agent-hub-viewer.example");
    vi.stubEnv("ENTRA_REDIRECT_URI", "https://agent-hub.example/auth/callback");
    vi.stubEnv("SESSION_SECRET", "a-test-session-secret-long-enough-to-be-plausible");

    const [on] = await claimedBy("cluster-a");

    expect(on?.viewer_host).toBe("agent-hub-viewer.example");

    // The claim has to lapse before the same agent can be claimed again.
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "");
    const [off] = await claimedBy("cluster-a", LATER());

    expect(off?.viewer_host).toBeUndefined();
  });

  // One service's key rather than one agent's, so a pod that cannot use it must never be handed it.
  it("should send the gateway's APIM key to no agent on another route", async () => {
    await create(ALICE, "pcs-api", "own-licence");

    const [claimed] = await claim();

    expect(claimed?.gateway).toBeUndefined();
  });

  // A pod with no key boots and then fails every turn, so the claim is refused instead.
  it("should refuse the claim when a gateway agent's deployment has no APIM key", async () => {
    await create(ALICE, "pcs-api", "gateway");
    vi.stubEnv("AI_GATEWAY_APIM_KEY", "");

    await expect(claimVirtualAgents(prisma, "cluster-a")).rejects.toThrow("AI_GATEWAY_APIM_KEY");
  });

  // Nobody is on the gateway, so there is no gateway to be misconfigured for.
  it("should claim an own_licence agent when the deployment has no APIM key", async () => {
    await create(ALICE, "pcs-api", "own-licence");
    vi.stubEnv("AI_GATEWAY_APIM_KEY", "");

    const [claimed] = await claim();

    expect(claimed?.model_route).toBe("own_licence");
  });

  it("should claim at most the limit at once, leaving the rest for the next claim", async () => {
    for (const owner of [ALICE, BOB, CAROL]) {
      await create(owner, "one");
    }

    expect((await claimVirtualAgents(prisma, "cluster-a", { limit: 2 })).virtual_agents).toHaveLength(2);
    expect(await claimedBy("cluster-a")).toHaveLength(1);
  });

  it("should describe each claimed agent and mint a token for one that is starting", async () => {
    const agent = await create(ALICE, "pcs-api", "own-licence");

    const [claimed] = await claim();

    expect(claimed).toEqual({
      id: agent.id,
      generation: 1,
      pod_generation: 1,
      desired: "running",
      statefulset_name: agent.statefulsetName,
      pvc_name: agent.pvcName,
      delete_disk: false,
      model_route: "own_licence",
      size: "small",
      exposed_ports: [],
      plugins: [],
      owner: { oid: ALICE.oid },
      launch_token: expect.stringMatching(/^ahv_[A-Za-z0-9_-]{43}$/)
    });
    const stored = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stored.claimedBy).toBe("preview-01");
    expect(Buffer.from(stored.launchTokenHash!).toString("utf8")).not.toContain(claimed!.launch_token!);
  });

  it("should hand a claim back to its holder once it has gone unreported for two minutes, replacing the token", async () => {
    const agent = await create(ALICE, "pcs-api");
    const [first] = await claimedBy("cluster-a");
    expect(await claimedBy("cluster-a")).toEqual([]);

    const [again] = await claimedBy("cluster-a", LATER());

    expect(again).toMatchObject({ id: agent.id, generation: first!.generation });
    expect(again?.launch_token).not.toBe(first?.launch_token);
    expect((await status(agent.id, first!.launch_token!, { phase: "provisioning" })).status).toBe(401);
    expect((await status(agent.id, again!.launch_token!, { phase: "provisioning" })).status).toBe(204);
  });

  it("should not mint again for an agent whose pod already holds a token when its spec changes otherwise", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id }, data: { generation: { increment: 1 } } });

    const [claimed] = await claim();

    expect(claimed?.launch_token).toBeUndefined();
    expect((await status(id, token, { phase: "cloning" })).status).toBe(204);
  });

  it("should refuse a person's own credentials when they are sent instead of the orchestrator's", async () => {
    const response = await call(claimRoute.POST, { as: ALICE, path: "/api/orchestrator/claim", method: "POST", body: { cluster: "x" } });

    expect(response.status).toBe(401);
  });

  it("should refuse a launch token when it is sent instead of the orchestrator's", async () => {
    const { token } = await started(ALICE, "pcs-api");

    expect((await pod(claimRoute.POST, token, "/api/orchestrator/claim", {}, "POST", { cluster: "x" })).status).toBe(401);
  });
});

describe("the orchestrator lease", () => {
  it("should be taken by the first cluster to claim and renewed by each claim it makes", async () => {
    const first = new Date();
    const second = new Date(first.getTime() + 10_000);

    expect(await claimVirtualAgents(prisma, "cluster-a", { now: first })).toEqual({ active: true, virtual_agents: [] });
    expect(await prisma.orchestratorLease.findUniqueOrThrow({ where: { id: 1 } })).toEqual({ id: 1, cluster: "cluster-a", renewedAt: first });
    await claimVirtualAgents(prisma, "cluster-a", { now: second });

    expect(await prisma.orchestratorLease.findUniqueOrThrow({ where: { id: 1 } })).toEqual({ id: 1, cluster: "cluster-a", renewedAt: second });
  });

  it("should put another cluster on standby, claiming nothing, while the lease is fresh", async () => {
    const renewed = new Date();
    await claimVirtualAgents(prisma, "preview-01", { now: renewed });
    const agent = await create(ALICE, "pcs-api");

    const response = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, "POST", { cluster: "preview-02" }, "preview-02");

    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toEqual({ virtual_agents: [], active: false, lease: { cluster: "preview-01", renewed_at: renewed.toISOString() } });
    expect(await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ claimedBy: null, cluster: null });
    expect(await prisma.orchestratorLease.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ cluster: "preview-01", renewedAt: renewed });
  });

  it("should pass to another cluster, and say so, once the holder has not claimed for the lease's length", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const renewed = new Date();
    await claimVirtualAgents(prisma, "cluster-a", { now: renewed });

    expect((await claimVirtualAgents(prisma, "cluster-b", { now: new Date(renewed.getTime() + 119_000) })).active).toBe(false);
    expect((await claimVirtualAgents(prisma, "cluster-b", { now: new Date(renewed.getTime() + 120_000) })).active).toBe(true);
    expect(await claimVirtualAgents(prisma, "cluster-a", { now: new Date(renewed.getTime() + 121_000) })).toMatchObject({
      active: false,
      lease: { cluster: "cluster-b" }
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the orchestrator lease passed from cluster-a to cluster-b"));
    warn.mockRestore();
  });

  it("should last ORCHESTRATOR_LEASE_SECONDS when that is set", async () => {
    vi.stubEnv("ORCHESTRATOR_LEASE_SECONDS", "600");
    const renewed = new Date();
    await claimVirtualAgents(prisma, "cluster-a", { now: renewed });

    expect((await claimVirtualAgents(prisma, "cluster-b", { now: new Date(renewed.getTime() + 300_000) })).active).toBe(false);
  });
});

describe("moving virtual agents between clusters", () => {
  /** An agent started and running on `cluster`, with its pod's token. */
  async function runningOn(cluster: string, name = "pcs-api"): Promise<{ id: string; token: string; generation: number }> {
    const agent = await create(ALICE, name);
    const claimed = (await claimedBy(cluster)).find((entry) => entry.id === agent.id)!;
    await observeVirtualAgent(prisma, agent.id, { generation: claimed.generation, replicasReady: 1, podPhase: "Running" });
    return { id: agent.id, token: claimed.launch_token!, generation: claimed.generation };
  }

  it("should start a running agent on the new holder's cluster on a fresh disk, with a new token that shuts the old pod out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id, token, generation } = await runningOn("cluster-a");

    const [moved] = await claimedBy("cluster-b", LATER());

    expect(moved).toMatchObject({ id, desired: "running", generation: generation + 1, launch_token: expect.stringMatching(/^ahv_/) });
    expect(await row(id)).toMatchObject({ status: "provisioning", statusDetail: "moved from cluster-a to cluster-b; starting on a fresh disk" });
    expect(await homeOf(id)).toBe("cluster-b");
    expect((await status(id, token, { phase: "running" })).status).toBe(401);
    expect((await status(id, moved!.launch_token!, { phase: "provisioning" })).status).toBe(204);
    expect(warn).toHaveBeenCalledWith(`virtual agent ${id} moved from cluster-a to cluster-b, on a fresh disk`);
    warn.mockRestore();
  });

  it("should move nothing while the old cluster still holds the lease", async () => {
    const { id, token, generation } = await runningOn("cluster-a");

    expect((await claimVirtualAgents(prisma, "cluster-b")).active).toBe(false);

    expect(await row(id)).toMatchObject({ generation, status: "provisioning", statusDetail: null });
    expect(await homeOf(id)).toBe("cluster-a");
    expect((await status(id, token, { phase: "running" })).status).toBe(204);
  });

  it("should leave a stopped agent on its cluster, and move it to the holder's when it starts again", async () => {
    const { id } = await runningOn("cluster-a");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const [stopping] = await claimedBy("cluster-a");
    await observeVirtualAgent(prisma, id, { generation: stopping!.generation, replicasReady: 0 });
    const stopped = await row(id);

    expect(await claimedBy("cluster-b", LATER())).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "stopped", generation: stopped.generation });
    expect(await homeOf(id)).toBe("cluster-a");

    await setDesired(prisma, ALICE.oid, id, "running");
    const [starting] = await claimedBy("cluster-b", LATER());

    expect(starting).toMatchObject({ id, desired: "running", launch_token: expect.any(String) });
    expect(await homeOf(id)).toBe("cluster-b");
  });

  it("should adopt a running agent with no cluster recorded without restarting it", async () => {
    const { id, token, generation } = await runningOn("cluster-a");
    await prisma.virtualAgent.update({ where: { id }, data: { cluster: null } });

    expect(await claimedBy("cluster-a")).toEqual([]);

    expect(await homeOf(id)).toBe("cluster-a");
    expect((await row(id)).generation).toBe(generation);
    expect((await status(id, token, { phase: "running" })).status).toBe(204);
  });
});

describe("the launch token across stop and start", () => {
  it("should be refused once the agent is stopped, and replaced by a new one when it starts again", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    await setDesired(prisma, ALICE.oid, id, "stopped");
    expect((await status(id, token, { phase: "running" })).status).toBe(401);
    const [stopping] = await claim();
    expect(stopping).toMatchObject({ id, desired: "stopped", delete_disk: false });
    expect(stopping?.launch_token).toBeUndefined();
    expect((await observe(id, { generation: stopping!.generation, replicas_ready: 0 })).status).toBe(204);
    expect(await row(id)).toMatchObject({ status: "stopped", stopReason: "user" });

    await setDesired(prisma, ALICE.oid, id, "running");
    const [restarting] = await claim();
    expect(restarting?.launch_token).toBeDefined();
    expect(restarting?.launch_token).not.toBe(token);
    expect((await status(id, token, { phase: "provisioning" })).status).toBe(401);
    expect((await status(id, restarting!.launch_token!, { phase: "provisioning" })).status).toBe(204);
    expect(await row(id)).toMatchObject({ status: "provisioning", stopReason: null, diskExpiresAt: null });
  });
});

describe("POST /api/orchestrator/virtual-agents/{id}/observed", () => {
  it("should record the generation applied, release the claim and move a starting agent to provisioning", async () => {
    const agent = await create(ALICE, "pcs-api");
    await claim();

    expect((await observe(agent.id, { generation: 1, replicas_ready: 0, pod_phase: "Pending", reason: "ContainerCreating" })).status).toBe(204);

    const stored = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stored).toMatchObject({ observedGeneration: 1, claimedBy: null, claimedAt: null, status: "provisioning" });
    expect(await claim()).toEqual([]);
  });

  it("should fail the agent with the reason when its pod cannot start", async () => {
    const agent = await create(ALICE, "pcs-api");
    await claim();

    await observe(agent.id, { generation: 1, replicas_ready: 0, pod_phase: "Pending", reason: "ImagePullBackOff" });

    expect(await row(agent.id)).toMatchObject({ status: "failed", statusDetail: "the pod is not starting: ImagePullBackOff" });
  });

  it("should start a stopped agent's disk expiry when it observes the agent stopped", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const [claimed] = await claim();

    const before = Date.now();
    await observe(id, { generation: claimed!.generation, replicas_ready: 0 });
    const after = Date.now();

    const expires = (await row(id)).diskExpiresAt!.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 14 * 24 * 60 * 60_000);
    expect(expires).toBeLessThanOrEqual(after + 14 * 24 * 60 * 60_000);
  });

  it("should hand an expired disk to the orchestrator for deletion until it reports the disk gone", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const [stopping] = await claim();
    await observe(id, { generation: stopping!.generation, replicas_ready: 0 });
    await prisma.virtualAgent.update({ where: { id }, data: { diskExpiresAt: new Date(Date.now() - 1000) } });

    const [due] = await claim();
    expect(due).toMatchObject({ id, desired: "stopped", delete_disk: true });
    await observe(id, { generation: due!.generation, replicas_ready: 0, disk_deleted: false });
    expect((await claim()).map((entry) => entry.id)).toEqual([id]);
    await observe(id, { generation: due!.generation, replicas_ready: 0, disk_deleted: true });

    expect((await row(id)).diskDeletedAt).not.toBeNull();
    expect(await claim()).toEqual([]);
    const live = await jsonOf(await orchestrator(liveRoute.GET, "/api/orchestrator/live", {}));
    expect(live.virtual_agents).toEqual([{ id, statefulset_name: `va-${id.slice(0, 8)}`, pvc_name: null, cluster: "preview-01" }]);
  });

  it("should remove a deleted agent once its pod and disk are both gone", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "deleted");
    const [claimed] = await claim();
    expect(claimed).toMatchObject({ desired: "deleted", delete_disk: true });

    await observe(id, { generation: claimed!.generation, replicas_ready: 0, pod_phase: "Running" });
    expect(await row(id)).toMatchObject({ status: "stopping" });
    await observe(id, { generation: claimed!.generation, replicas_ready: 0, disk_deleted: true });

    expect(await findVirtualAgent(prisma, id)).toBeUndefined();
  });

  it.each([
    ["a generation not yet asked for", { generation: 9, replicas_ready: 0 }, 409],
    ["a malformed body", { generation: "one" }, 400]
  ])("should refuse %s", async (_label, body, statusCode) => {
    const agent = await create(ALICE, "pcs-api");

    expect((await observe(agent.id, body)).status).toBe(statusCode);
  });

  it("should answer 404 for an agent the hub does not have", async () => {
    expect((await observe("0f8a6a1e-0000-4000-8000-000000000001", { generation: 1, replicas_ready: 0 })).status).toBe(404);
    expect((await observe("not-a-uuid", { generation: 1, replicas_ready: 0 })).status).toBe(404);
  });
});

describe("GET /api/orchestrator/live", () => {
  it("should list every virtual agent the hub has, whoever owns it", async () => {
    const alice = await create(ALICE, "a");
    const bob = await create(BOB, "b");

    const live = await jsonOf(await orchestrator(liveRoute.GET, "/api/orchestrator/live", {}));

    expect(live.virtual_agents.map((entry: { id: string }) => entry.id).sort(byCodePoint)).toEqual([alice.id, bob.id].sort(byCodePoint));
  });

  it("should name an agent's disk as its StatefulSet's claim template makes it until the disk is deleted", async () => {
    const agent = await create(ALICE, "a");

    const live = await jsonOf(await orchestrator(liveRoute.GET, "/api/orchestrator/live", {}));

    expect(live.virtual_agents).toEqual([
      { id: agent.id, statefulset_name: `va-${agent.id.slice(0, 8)}`, pvc_name: `work-va-${agent.id.slice(0, 8)}-0`, cluster: null }
    ]);
  });

  it("should name the cluster each agent is on once one has claimed it, without the caller holding the lease", async () => {
    const agent = await create(ALICE, "a");
    await claimVirtualAgents(prisma, "preview-00");

    const live = await jsonOf(await orchestrator(liveRoute.GET, "/api/orchestrator/live", {}, "GET", undefined, "preview-01"));

    expect(live.virtual_agents).toEqual([expect.objectContaining({ id: agent.id, cluster: "preview-00" })]);
  });
});

describe("POST /api/orchestrator/virtual-agents/{id}/apply-failed", () => {
  const ERROR = 'services "va-0f8a6a1e" is forbidden: User "system:serviceaccount:dtsse:orchestrator" cannot get resource "services"';

  function applyFailed(id: string, body: unknown): Promise<Response> {
    return orchestrator(applyFailedRoute.POST, `/api/orchestrator/virtual-agents/${id}/apply-failed`, { id }, "POST", body);
  }

  it("should keep the error as the detail without touching the generations or the claim, and with no launch token in it", async () => {
    const agent = await create(ALICE, "pcs-api");
    const [claimed] = await claim();
    const before = await row(agent.id);

    const response = await applyFailed(agent.id, { generation: claimed!.generation, error: `${ERROR}; env AGENT_HUB_TOKEN=${claimed!.launch_token}` });

    expect(response.status).toBe(204);
    const stored = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stored).toMatchObject({
      status: "requested",
      statusDetail: `the orchestrator couldn't apply this agent: ${ERROR}; env AGENT_HUB_TOKEN=ahv_[redacted]`,
      applyFailures: 1,
      generation: before.generation,
      observedGeneration: before.observedGeneration,
      claimedBy: "preview-01"
    });
    expect(JSON.stringify(stored, (_key, value) => (value instanceof Uint8Array ? "bytes" : value))).not.toContain(claimed!.launch_token!.slice(4));
  });

  it("should fail the agent after five claims in a row it could not apply, and start it again once an apply works", async () => {
    const agent = await create(ALICE, "pcs-api");
    let at = Date.now();
    let claimed: ClaimedVirtualAgent | undefined;
    for (let attempt = 1; attempt <= APPLY_FAILURES_BEFORE_FAILED; attempt += 1) {
      [claimed] = await claimedBy("preview-01", new Date(at));
      expect(claimed?.launch_token).toBeDefined();
      await recordApplyError(prisma, agent.id, { generation: claimed!.generation, error: ERROR }, new Date(at));
      expect((await row(agent.id)).status).toBe(attempt < APPLY_FAILURES_BEFORE_FAILED ? "requested" : "failed");
      at += 3 * 60_000;
    }
    expect(await row(agent.id)).toMatchObject({ status: "failed", statusDetail: `the orchestrator couldn't apply this agent: ${ERROR}`, applyFailures: 5 });

    [claimed] = await claimedBy("preview-01", new Date(at));
    expect(claimed?.launch_token).toBeDefined();
    await observeVirtualAgent(prisma, agent.id, { generation: claimed!.generation, replicasReady: 0, podPhase: "Pending" });

    expect(await row(agent.id)).toMatchObject({ status: "provisioning", statusDetail: null, applyFailures: 0, observedGeneration: claimed!.generation });
    expect((await status(agent.id, claimed!.launch_token!, { phase: "running" })).status).toBe(204);
  });

  it("should fail a stop it could not apply, and settle it as stopped once one works", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    let at = Date.now();
    let claimed: ClaimedVirtualAgent | undefined;
    for (let attempt = 1; attempt <= APPLY_FAILURES_BEFORE_FAILED; attempt += 1) {
      [claimed] = await claimedBy("preview-01", new Date(at));
      await recordApplyError(prisma, id, { generation: claimed!.generation, error: ERROR }, new Date(at));
      at += 3 * 60_000;
    }
    expect(await row(id)).toMatchObject({ desired: "stopped", status: "failed" });

    [claimed] = await claimedBy("preview-01", new Date(at));
    await observeVirtualAgent(prisma, id, { generation: claimed!.generation, replicasReady: 0 });

    expect(await row(id)).toMatchObject({ status: "stopped", statusDetail: null, applyFailures: 0 });
  });

  it("should give the owner's next start a fresh run of claims before it fails", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id }, data: { applyFailures: APPLY_FAILURES_BEFORE_FAILED - 1 } });

    expect(await setDesired(prisma, ALICE.oid, id, "stopped")).toMatchObject({ applyFailures: 0 });
  });

  it("should ignore an error about a generation older than the latest", async () => {
    const agent = await create(ALICE, "pcs-api");
    await claim();
    await setVirtualAgentSize(prisma, ALICE.oid, agent.id, "large");

    expect((await applyFailed(agent.id, { generation: 1, error: ERROR })).status).toBe(204);
    expect(await row(agent.id)).toMatchObject({ statusDetail: null, applyFailures: 0 });
  });

  it("should refuse a generation not yet asked for, an unknown agent and a malformed body", async () => {
    const agent = await create(ALICE, "pcs-api");

    expect((await applyFailed(agent.id, { generation: 9, error: ERROR })).status).toBe(409);
    expect((await applyFailed("0f8a6a1e-1234-4000-8000-000000000009", { generation: 1, error: ERROR })).status).toBe(404);
    expect((await applyFailed("not-a-uuid", { generation: 1, error: ERROR })).status).toBe(404);
    expect((await applyFailed(agent.id, { generation: 1, error: "x".repeat(501) })).status).toBe(400);
    expect((await applyFailed(agent.id, { generation: 1 })).status).toBe(400);
    expect(await row(agent.id)).toMatchObject({ statusDetail: null, applyFailures: 0 });
  });
});
