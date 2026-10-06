import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import * as directRoute from "../../src/app/api/agent/[agentId]/direct/route.ts";
import * as heartbeatRoute from "../../src/app/api/agent/[agentId]/heartbeat/route.ts";
import * as personalCredentialRoute from "../../src/app/api/agent/credentials/[kind]/route.ts";
import * as messageRoute from "../../src/app/api/agent/messages/[id]/route.ts";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as liveRoute from "../../src/app/api/orchestrator/live/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as credentialRoute from "../../src/app/api/virtual/[virtualAgentId]/credentials/[kind]/route.ts";
import * as codeRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/code/route.ts";
import * as completeRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/complete/route.ts";
import * as loginRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/route.ts";
import * as statusRoute from "../../src/app/api/virtual/[virtualAgentId]/status/route.ts";
import { credentialBackend } from "../../src/credentials/backend.ts";
import { putCredential, readCredential, type SecretStore } from "../../src/credentials/store.ts";
import { directAsAgent, directAsPerson, postAs } from "../../src/messages/send.ts";
import { queuedDeliveries, queuedDelivery } from "../../src/messages/store.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { MAX_PER_USER, MAX_RUNNING_PER_USER } from "../../src/virtual-agents/limits.ts";
import { storePastedCode } from "../../src/virtual-agents/logins.ts";
import {
  type ClaimedVirtualAgent,
  type ClaimResult,
  claimVirtualAgents,
  createVirtualAgent,
  findVirtualAgent,
  observeVirtualAgent,
  renameVirtualAgent,
  setDesired,
  setExposedPort,
  setVirtualAgentSize,
  type VirtualAgentRow
} from "../../src/virtual-agents/store.ts";
import { startVirtualAgentSweep, sweepVirtualAgents } from "../../src/virtual-agents/sweep.ts";
import { virtualAgentDetail } from "../../src/virtual-agents/views.ts";
import { connect, insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/virtual-agents.ts");
const { virtualAgentPage, virtualAgentsPage } = await import("../../src/web/data.ts");
const credentialsPage = await import("../../src/app/settings/credentials/page.tsx");

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

/** The development personas the UI acts as, so the server actions and the agent API agree on who is who. */
const ALICE: Person = { oid: "dev-alice", name: "Dev alice (sign-in disabled)", email: "alice@dev.invalid" };
const BOB: Person = { oid: "dev-bob", name: "Dev bob (sign-in disabled)", email: "bob@dev.invalid" };
const CAROL = person("carol");

const GITHUB = `ghp_${"A1b2".repeat(9)}`;
const CLAUDE = `sk-ant-oat01-${"Qw_-".repeat(12)}`;
const BEDROCK = `bedrock-api-key-${"YmVkcm9jay5hbWF6b25hd3MuY29t".repeat(6)}`;
const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";

function azureCacheFor(oid: string): string {
  return gzipSync(Buffer.from(JSON.stringify({ Account: { a: { username: "alice@example.com", home_account_id: `${oid}.${TENANT}` } } }))).toString("base64");
}

const AZURE = azureCacheFor(ALICE.oid);

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

/** A request as a virtual agent's pod makes it: its launch token and nothing else. */
async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, method = "GET", body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function orchestrator<P>(handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown, name = "preview-01"): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "x-dev-orchestrator": name, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

async function claim(cluster = "preview-01"): Promise<ClaimedVirtualAgent[]> {
  const response = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, "POST", { cluster });
  expect(response.status).toBe(200);
  const body = await jsonOf<ClaimResult>(response);
  expect(body.active).toBe(true);
  return body.virtual_agents;
}

/** The agents a claim by `cluster` gets, failing the test if that cluster is refused the lease. */
async function claimedBy(cluster: string, now?: Date): Promise<ClaimedVirtualAgent[]> {
  const result = await claimVirtualAgents(prisma, cluster, { now });
  expect(result.active).toBe(true);
  return result.virtual_agents;
}

async function homeOf(id: string): Promise<string | null> {
  return (await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).cluster;
}

const LATER = () => new Date(Date.now() + 3 * 60_000);

async function observe(id: string, body: Record<string, unknown>): Promise<Response> {
  return await orchestrator(observedRoute.POST, `/api/orchestrator/virtual-agents/${id}/observed`, { id }, "POST", body);
}

async function create(owner: Person, name: string, modelRoute: "bedrock" | "own-licence" = "bedrock"): Promise<VirtualAgentRow> {
  await insertUser(owner);
  return await createVirtualAgent(prisma, { owner, modelRoute, name });
}

/** A virtual agent the orchestrator has claimed and started, with the launch token its pod holds. */
async function started(owner: Person, name: string, modelRoute: "bedrock" | "own-licence" = "bedrock"): Promise<{ id: string; token: string }> {
  const row = await create(owner, name, modelRoute);
  const claimed = (await claim()).find((entry) => entry.id === row.id);
  expect(claimed?.launch_token).toBeDefined();
  expect((await observe(row.id, { generation: claimed!.generation, replicas_ready: 1, pod_phase: "Running" })).status).toBe(204);
  return { id: row.id, token: claimed!.launch_token! };
}

function status(id: string, token: string, body: unknown): Promise<Response> {
  return pod(statusRoute.POST, token, `/api/virtual/${id}/status`, { virtualAgentId: id }, "POST", body);
}

function register(token: string, sessionId: string): Promise<Response> {
  return pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", { session_id: sessionId, name: "va-session" });
}

function localStore(): SecretStore {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    throw new Error(backend.reason);
  }
  return backend.store;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

async function row(id: string): Promise<VirtualAgentRow> {
  return (await findVirtualAgent(prisma, id))!;
}

beforeEach(async () => {
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("ENTRA_TENANT_ID", TENANT);
  await resetDatabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("creating virtual agents", () => {
  it("should create one meant to be running, with names derived from its id, when the owner is under the limits", async () => {
    const agent = await create(ALICE, "PCS-api");

    expect(agent).toMatchObject({ name: "pcs-api", desired: "running", status: "requested", generation: 1, observedGeneration: 0, modelRoute: "bedrock" });
    expect(agent.statefulsetName).toBe(`va-${agent.id.slice(0, 8)}`);
    expect(agent.pvcName).toBe(`work-va-${agent.id.slice(0, 8)}-0`);
  });

  it("should refuse more running than the running limit, and more in all than the total limit", async () => {
    for (let index = 0; index < MAX_RUNNING_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }
    await expect(create(ALICE, "one-too-many")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("running") });

    const first = (await prisma.virtualAgent.findFirstOrThrow({ where: { name: "agent-0" } })).id;
    await setDesired(prisma, ALICE.oid, first, "stopped");
    for (let index = MAX_RUNNING_PER_USER; index < MAX_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }
    await setDesired(prisma, ALICE.oid, (await prisma.virtualAgent.findFirstOrThrow({ where: { name: "agent-1" } })).id, "stopped");
    await expect(create(ALICE, "over-total")).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${MAX_PER_USER} virtual agents`) });
    expect(await prisma.virtualAgent.count()).toBe(MAX_PER_USER);
  });

  it("should refuse a start over the running limit", async () => {
    await create(ALICE, "a");
    const b = await create(ALICE, "b");
    await setDesired(prisma, ALICE.oid, b.id, "stopped");
    await create(ALICE, "c");

    await expect(setDesired(prisma, ALICE.oid, b.id, "running")).rejects.toMatchObject({ status: 409 });
  });

  it("should let only one of two concurrent creates through when one place is left", async () => {
    await create(ALICE, "first");

    const results = await Promise.allSettled([create(ALICE, "second"), create(ALICE, "third")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.virtualAgent.count({ where: { ownerOid: ALICE.oid } })).toBe(MAX_RUNNING_PER_USER);
  });

  it.each([
    ["a name already used", "pcs-api", 409],
    ["a name that is not a slug", "pcs api", 400]
  ])("should refuse %s", async (_label, name, statusCode) => {
    await create(ALICE, "pcs-api");

    await expect(create(ALICE, name)).rejects.toMatchObject({ status: statusCode });
  });

  it("should let two people use the same name", async () => {
    await create(ALICE, "pcs-api");

    await expect(create(BOB, "pcs-api")).resolves.toMatchObject({ ownerOid: BOB.oid });
  });

  it("should tell nobody but the owner that an agent exists when someone else tries to change it", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(setDesired(prisma, BOB.oid, agent.id, "stopped")).rejects.toMatchObject({ status: 404 });
  });
});

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

  it("should pass the Bedrock route to the orchestrator when the agent is on it", async () => {
    await create(ALICE, "pcs-api", "bedrock");

    const [claimed] = await claim();

    expect(claimed?.model_route).toBe("bedrock");
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
      desired: "running",
      statefulset_name: agent.statefulsetName,
      pvc_name: agent.pvcName,
      delete_disk: false,
      model_route: "own_licence",
      size: "small",
      exposed_ports: [],
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
    expect(await row(id)).toMatchObject({ status: "provisioning", stopReason: null, stoppedAt: null, diskExpiresAt: null });
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

    await observe(id, { generation: claimed!.generation, replicas_ready: 0 });

    const stored = await row(id);
    expect(stored.stoppedAt).not.toBeNull();
    expect(stored.diskExpiresAt!.getTime() - stored.stoppedAt!.getTime()).toBe(14 * 24 * 60 * 60_000);
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

describe("registering a virtual agent's session", () => {
  it("should link the agent and the virtual agent when the pod registers with its launch token", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    const response = await register(token, "va-session-1");

    expect(response.status).toBe(200);
    const { agent_id } = await jsonOf(response);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ ownerOid: ALICE.oid, virtualAgentId: id });
    expect((await row(id)).agentId).toBe(agent_id);
  });

  it("should name the agent after the virtual agent when its session registers under another name", async () => {
    const { token } = await started(ALICE, "jerry");

    const response = await register(token, "va-session-1");

    expect(response.status).toBe(200);
    const { agent_id, name } = await jsonOf(response);
    expect(name).toBe("jerry");
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).name).toBe("jerry");
  });

  it("should keep the virtual agent's name when a heartbeat renames the session", async () => {
    const { token } = await started(ALICE, "jerry");
    const { agent_id } = await jsonOf(await register(token, "va-session-1"));

    const response = await pod(heartbeatRoute.POST, token, `/api/agent/${agent_id}/heartbeat`, { agentId: agent_id }, "POST", {
      status: "busy",
      name: "cft-workspace-17"
    });

    expect(response.status).toBe(204);
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).toMatchObject({ name: "jerry", status: "busy" });
  });

  it("should rename a virtual agent's session registered under another name on its next heartbeat", async () => {
    const { id, token } = await started(ALICE, "jerry");
    const { agent_id } = await jsonOf(await register(token, "va-session-1"));
    await prisma.agent.update({ where: { id: agent_id }, data: { name: "cft-workspace-17" } });

    await pod(heartbeatRoute.POST, token, `/api/agent/${agent_id}/heartbeat`, { agentId: agent_id }, "POST", { status: "idle" });

    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).name).toBe("jerry");
    expect((await row(id)).agentId).toBe(agent_id);
  });

  it("should move the link to the new session when the pod registers again after /clear", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const first = (await jsonOf(await register(token, "va-session-1"))).agent_id;

    const second = (await jsonOf(await register(token, "va-session-2"))).agent_id;

    expect(second).not.toBe(first);
    expect((await row(id)).agentId).toBe(second);
  });

  it("should not rewrite the owner's user row when the pod registers", async () => {
    const { token } = await started(ALICE, "pcs-api");
    await prisma.user.update({ where: { oid: ALICE.oid }, data: { name: "Alice As Known", lastSeenAt: new Date(0) } });

    await register(token, "va-session-1");

    expect(await prisma.user.findUniqueOrThrow({ where: { oid: ALICE.oid } })).toMatchObject({ name: "Alice As Known", lastSeenAt: new Date(0) });
  });

  it("should refuse to adopt one of the owner's own sessions when a launch token names its session id", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const laptop = await prisma.agent.findUniqueOrThrow({ where: { id: await insertAgent(ALICE, "laptop") } });

    expect((await register(token, laptop.sessionId)).status).toBe(409);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: laptop.id } })).virtualAgentId).toBeNull();
  });

  it("should refuse the owner's own token when it names a virtual agent's session id", async () => {
    const { token } = await started(ALICE, "pcs-api");
    await register(token, "va-session-1");

    const response = await call(registerRoute.POST, {
      as: ALICE,
      path: "/api/agent/register",
      method: "POST",
      body: { session_id: "va-session-1", name: "x" }
    });

    expect(response.status).toBe(409);
  });
});

describe("a launch token on the agent API", () => {
  it("should act for its own virtual agent's agent and for no other agent of the same owner", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const mine = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    const laptop = await insertAgent(ALICE, "laptop");

    const own = await pod(heartbeatRoute.POST, token, `/api/agent/${mine}/heartbeat`, { agentId: mine }, "POST", { status: "busy" });
    const other = await pod(heartbeatRoute.POST, token, `/api/agent/${laptop}/heartbeat`, { agentId: laptop }, "POST", { status: "busy" });

    expect(own.status).toBe(204);
    expect(other.status).toBe(403);
    expect((await jsonOf(other)).error).toContain("launch token");
  });

  it("should not act for another virtual agent's agent of the same owner", async () => {
    const first = await started(ALICE, "first");
    const second = await started(ALICE, "second");
    const theirs = (await jsonOf(await register(second.token, "second-session"))).agent_id;

    expect((await pod(heartbeatRoute.POST, first.token, `/api/agent/${theirs}/heartbeat`, { agentId: theirs }, "POST", { status: "busy" })).status).toBe(403);
  });

  it("should still let the owner's own token act for the virtual agent's agent", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const mine = (await jsonOf(await register(token, "va-session-1"))).agent_id;

    const response = await call(heartbeatRoute.POST, {
      as: ALICE,
      path: `/api/agent/${mine}/heartbeat`,
      params: { agentId: mine },
      method: "POST",
      body: { status: "idle" }
    });

    expect(response.status).toBe(204);
  });

  it("should refuse the personal credentials routes when a launch token calls them", async () => {
    const { token } = await started(ALICE, "pcs-api");

    const put = await pod(personalCredentialRoute.PUT, token, "/api/agent/credentials/github", { kind: "github" }, "PUT", { value: GITHUB });
    const remove = await pod(personalCredentialRoute.DELETE, token, "/api/agent/credentials/github", { kind: "github" }, "DELETE");

    expect([put.status, remove.status]).toEqual([403, 403]);
    expect(await prisma.credential.count()).toBe(0);
  });

  it("should refuse a launch token reading its owner's Bedrock API key through the person's route", async () => {
    const { token } = await started(ALICE, "pcs-api");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "bedrock", value: BEDROCK, via: "web" });

    const response = await pod(personalCredentialRoute.GET, token, "/api/agent/credentials/bedrock", { kind: "bedrock" });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(BEDROCK);
  });
});

describe("/api/virtual/{id}/status", () => {
  it("should record each phase the pod reports and count it as activity", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await status(id, token, { phase: "cloning", detail: "hmcts/pcs-api" })).status).toBe(204);

    const stored = await row(id);
    expect(stored).toMatchObject({ status: "cloning", statusDetail: "hmcts/pcs-api" });
    expect(stored.lastActiveAt).not.toBeNull();
  });

  it("should refuse a pod's way back to running from failed, and accept a restart", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await status(id, token, { phase: "failed", detail: "git clone failed" });

    expect((await status(id, token, { phase: "running" })).status).toBe(409);
    expect((await status(id, token, { phase: "provisioning" })).status).toBe(204);
  });

  it("should refuse another virtual agent's token on this agent's routes", async () => {
    const first = await started(ALICE, "first");
    const second = await started(ALICE, "second");

    expect((await status(first.id, second.token, { phase: "running" })).status).toBe(403);
  });

  it("should refuse a person's own token on a virtual agent's routes", async () => {
    const { id } = await started(ALICE, "pcs-api");

    const response = await call(statusRoute.POST, {
      as: ALICE,
      path: `/api/virtual/${id}/status`,
      params: { virtualAgentId: id },
      method: "POST",
      body: { phase: "running" }
    });

    expect(response.status).toBe(403);
  });

  it("should refuse a token that was never issued", async () => {
    const { id } = await started(ALICE, "pcs-api");

    expect((await status(id, `ahv_${"x".repeat(43)}`, { phase: "running" })).status).toBe(401);
  });

  it("should refuse a malformed body", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await status(id, token, { phase: "stopped" })).status).toBe(400);
  });
});

describe("/api/virtual/{id}/credentials/{kind}", () => {
  it("should give the pod its owner's Jenkins API token when one is stored, and offer it as optional", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const jenkins = "11a2b3c4d5e6f708192a3b4c5d6e7f8091";
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "jenkins", value: jenkins, via: "web" });

    const found = await pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/jenkins`, { virtualAgentId: id, kind: "jenkins" });

    expect(await jsonOf(found)).toEqual({ value: jenkins });
    expect((await virtualAgentDetail(prisma, ALICE.oid, id))?.optional).toEqual(["jenkins"]);
  });

  it("should give the pod its owner's stored credential, and 404 when there is none", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "github", value: GITHUB, via: "web" });

    const found = await pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/github`, { virtualAgentId: id, kind: "github" });
    const missing = await pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/claude`, { virtualAgentId: id, kind: "claude" });

    expect(found.status).toBe(200);
    expect(await jsonOf(found)).toEqual({ value: GITHUB });
    expect(missing.status).toBe(404);
  });

  it("should never give a credential to anyone but the owner's own virtual agent", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const bobs = await started(BOB, "bobs");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "github", value: GITHUB, via: "web" });

    const asOwner = await call(credentialRoute.GET, {
      as: ALICE,
      path: `/api/virtual/${id}/credentials/github`,
      params: { virtualAgentId: id, kind: "github" }
    });
    const asOtherAgent = await pod(credentialRoute.GET, bobs.token, `/api/virtual/${id}/credentials/github`, { virtualAgentId: id, kind: "github" });

    expect(asOwner.status).toBe(403);
    expect(asOtherAgent.status).toBe(403);
    expect(await asOwner.text()).not.toContain(GITHUB);
  });

  it("should store what the pod saves as saved by the pod", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    const response = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", {
      value: AZURE
    });

    expect(response.status).toBe(204);
    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({
      ownerOid: ALICE.oid,
      kind: "azure",
      updatedVia: "pod",
      accountLabel: "alice@example.com"
    });
  });

  it("should refuse an Azure token cache signed in as someone else with 409, store nothing and fail the agent", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await pod(loginRoute.POST, token, `/api/virtual/${id}/login/azure`, { virtualAgentId: id, kind: "azure" }, "POST", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });

    const response = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", {
      value: azureCacheFor(BOB.oid)
    });

    expect(response.status).toBe(409);
    expect((await jsonOf(response)).error).toContain("someone other than you");
    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.devCredentialValue.count()).toBe(0);
    expect(await row(id)).toMatchObject({ status: "failed", statusDetail: expect.stringContaining("Azure token cache") });
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("failed");
  });

  it("should refuse a token cache that does not decode with 400, leaving the agent as it was", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    const response = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", {
      value: "nope"
    });

    expect(response.status).toBe(400);
    expect((await row(id)).status).toBe("provisioning");
  });

  it("should answer 503 for a token cache when the hub's tenant is not configured", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    vi.stubEnv("ENTRA_TENANT_ID", "");

    expect(
      (await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE })).status
    ).toBe(503);
    expect((await row(id)).status).toBe("provisioning");
  });

  it("should answer 404 for an unknown kind", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/ssh`, { virtualAgentId: id, kind: "ssh" })).status).toBe(404);
  });

  it("should give the pod its owner's Bedrock API key, and 404 until there is one", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const fetchKey = () => pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/bedrock`, { virtualAgentId: id, kind: "bedrock" });
    expect((await fetchKey()).status).toBe(404);

    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "bedrock", value: BEDROCK, via: "web" });

    const found = await fetchKey();
    expect(found.status).toBe(200);
    expect(await jsonOf(found)).toEqual({ value: BEDROCK });
  });

  it("should store a Bedrock API key the pod saves as saved by the pod", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    const response = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/bedrock`, { virtualAgentId: id, kind: "bedrock" }, "PUT", {
      value: BEDROCK
    });

    expect(response.status).toBe(204);
    expect(await prisma.credential.findFirstOrThrow()).toMatchObject({ ownerOid: ALICE.oid, kind: "bedrock", updatedVia: "pod" });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "bedrock")).toBe(BEDROCK);
  });

  it("should record the pod waiting for a Bedrock API key when it reports awaiting_credentials", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await status(id, token, { phase: "awaiting_credentials", detail: "bedrock: paste your Bedrock API key" })).status).toBe(204);

    expect(await row(id)).toMatchObject({ status: "awaiting_credentials", statusDetail: "bedrock: paste your Bedrock API key" });
  });
});

describe("logins", () => {
  function startLogin(id: string, token: string, kind: string, body: unknown): Promise<Response> {
    return pod(loginRoute.POST, token, `/api/virtual/${id}/login/${kind}`, { virtualAgentId: id, kind }, "POST", body);
  }

  function fetchCode(id: string, token: string, kind: string): Promise<Response> {
    return pod(codeRoute.GET, token, `/api/virtual/${id}/login/${kind}/code`, { virtualAgentId: id, kind });
  }

  function complete(id: string, token: string, kind: string, body: unknown): Promise<Response> {
    return pod(completeRoute.POST, token, `/api/virtual/${id}/login/${kind}/complete`, { virtualAgentId: id, kind }, "POST", body);
  }

  it("should show a device-code login to its owner alone and mark the agent waiting on them", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      const response = await startLogin(id, token, "github", {
        prompt: "device_code",
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-1234",
        expires_in: 900
      });

      expect(response.status).toBe(204);
      await expect
        .poll(() => payloads.map((payload) => JSON.parse(payload)))
        .toContainEqual({ type: "virtual_agent", virtual_agent_id: id, owner_oid: ALICE.oid });
    } finally {
      await listener.end();
    }
    expect((await row(id)).status).toBe("awaiting_login");
    expect((await virtualAgentDetail(prisma, ALICE.oid, id))?.logins).toEqual([
      expect.objectContaining({ kind: "github", prompt: "device_code", userCode: "ABCD-1234", state: "pending", codeWaiting: false })
    ]);
    expect(await virtualAgentDetail(prisma, BOB.oid, id)).toBeUndefined();
  });

  it("should hide the virtual agent from a grantee who can see the owner's other agents", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await insertUser(BOB);
    await setGrant(prisma, ALICE.oid, BOB.oid, "write");

    expect(await virtualAgentDetail(prisma, BOB.oid, id)).toBeUndefined();
  });

  it("should hand a pasted code to the pod exactly once, keeping it sealed until then", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth/authorize?code=true", expires_in: 900 });
    expect((await fetchCode(id, token, "claude")).status).toBe(204);

    actAs("alice");
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: " pasted#code-123 " }))).toEqual({
      ok: true,
      confirmation: "Sent to your virtual agent"
    });
    const sealed = await prisma.virtualAgentLogin.findFirstOrThrow();
    expect(Buffer.from(sealed.pastedCodeCiphertext!).toString("utf8")).not.toContain("pasted#code-123");
    expect((await virtualAgentDetail(prisma, ALICE.oid, id))?.logins[0]?.codeWaiting).toBe(true);

    const first = await fetchCode(id, token, "claude");
    expect(first.status).toBe(200);
    expect(await jsonOf(first)).toEqual({ code: "pasted#code-123" });
    expect((await fetchCode(id, token, "claude")).status).toBe(204);
    expect(await prisma.virtualAgentLogin.findFirstOrThrow()).toMatchObject({ pastedCodeCiphertext: null, pastedCodeIv: null, pastedCodeTag: null });
  });

  it("should not hand over a pasted code once it has waited longer than ten minutes", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth", expires_in: 3600 });
    await storePastedCode(prisma, ALICE.oid, id, "claude", "late-code", SECRET, new Date(Date.now() - 11 * 60_000));

    expect((await fetchCode(id, token, "claude")).status).toBe(204);
  });

  it("should refuse a pasted code when it is from someone other than the owner, or for a login not asking for one", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth", expires_in: 900 });

    actAs("bob");
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: "x" }))).toEqual({ ok: false, error: "no such virtual agent" });
    actAs("alice");
    expect(await actions.pasteLoginCode(form({ id, kind: "github", code: "x" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("no longer waiting")
    });
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: "  " }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("paste the code")
    });
    expect(await actions.pasteLoginCode(form({ id, kind: "ssh", code: "x" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await prisma.virtualAgentLogin.count({ where: { NOT: { pastedCodeCiphertext: null } } })).toBe(0);
  });

  it("should wipe the Azure credential, fail the agent and answer 409 when the Azure login was someone else's", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    const response = await complete(id, token, "azure", { account_oid: "someone-else", account_label: "mallory@example.com" });

    expect(response.status).toBe(409);
    expect((await jsonOf(response)).error).toContain("different account");
    expect(await prisma.credential.count()).toBe(0);
    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBeUndefined();
    expect(await row(id)).toMatchObject({ status: "failed", statusDetail: expect.stringContaining("different account") });
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("failed");
  });

  it("should accept the owner's cache saved after the owner's own Azure login was completed", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });

    expect((await complete(id, token, "azure", { account_oid: ALICE.oid })).status).toBe(204);
    const saved = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    expect(saved.status).toBe(204);
    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBe(AZURE);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
    expect((await row(id)).status).toBe("awaiting_login");
  });

  it("should still refuse someone else's cache saved after a completed Azure login", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await complete(id, token, "azure", { account_oid: ALICE.oid });

    const saved = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", {
      value: azureCacheFor(BOB.oid)
    });

    expect(saved.status).toBe(409);
    expect(await prisma.credential.count()).toBe(0);
    expect((await row(id)).status).toBe("failed");
  });

  it("should treat an Azure login with no account as someone else's", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });

    expect((await complete(id, token, "azure", {})).status).toBe(409);
  });

  it("should complete the owner's own Azure login and label the credential with the account", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    expect((await complete(id, token, "azure", { account_oid: ALICE.oid, account_label: "alice@justice.gov.uk" })).status).toBe(204);

    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
    expect((await prisma.credential.findFirstOrThrow()).accountLabel).toBe("alice@justice.gov.uk");
  });

  it("should complete a GitHub login whatever account it names", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });

    expect((await complete(id, token, "github", { account_label: "alice-gh" })).status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
  });

  it("should answer 404 when there is no login of that kind to complete", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await complete(id, token, "github", {})).status).toBe(404);
  });

  it("should refuse a login whose URL is not https", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await startLogin(id, token, "github", { prompt: "paste_code", verification_uri: "javascript:alert(1)", expires_in: 900 })).status).toBe(400);
  });
});

describe("a launch token reading messages", () => {
  function read(token: string, id: string): Promise<Response> {
    return pod(messageRoute.GET, token, `/api/agent/messages/${id}`, { id });
  }

  it("should read posts and its own sessions' directs, and see the owner's other agents' directs as missing", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const mine = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    const laptop = await insertAgent(ALICE, "laptop");
    await insertUser(BOB);
    const post = await postAs(prisma, { oid: BOB.oid, agentId: null }, { topics: ["e2e"], title: null, body: "a post", inReplyTo: null });
    const toMine = await directAsPerson(prisma, ALICE.oid, mine, "for the virtual agent");
    const fromMine = await directAsAgent(prisma, { id: mine, ownerOid: ALICE.oid }, { toAgent: laptop, body: "from the virtual agent" });
    const toLaptop = await directAsPerson(prisma, ALICE.oid, laptop, "for the laptop only");

    const statuses = await Promise.all([post, toMine, fromMine, toLaptop].map(async (message) => (await read(token, message.id)).status));

    expect(statuses).toEqual([200, 200, 200, 404]);
    expect(await (await read(token, toLaptop.id)).json()).toEqual({ error: "no such message" });
    expect((await read(token, "999999")).status).toBe(404);
  });

  it("should leave the owner's own token reading the owner's other agents' directs", async () => {
    await started(ALICE, "pcs-api");
    const laptop = await insertAgent(ALICE, "laptop");
    const toLaptop = await directAsPerson(prisma, ALICE.oid, laptop, "for the laptop only");

    expect((await call(messageRoute.GET, { as: ALICE, path: `/api/agent/messages/${toLaptop.id}`, params: { id: toLaptop.id } })).status).toBe(200);
  });

  it("should answer 404 when a launch token replies to a direct its sessions never saw", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const mine = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    const laptop = await insertAgent(ALICE, "laptop");
    const toLaptop = await directAsPerson(prisma, ALICE.oid, laptop, "for the laptop only");
    const toMine = await directAsPerson(prisma, ALICE.oid, mine, "for the virtual agent");

    const hidden = await pod(directRoute.POST, token, `/api/agent/${mine}/direct`, { agentId: mine }, "POST", { reply_to_message: toLaptop.id, body: "x" });
    const own = await pod(directRoute.POST, token, `/api/agent/${mine}/direct`, { agentId: mine }, "POST", { reply_to_message: toMine.id, body: "on it" });

    expect(hidden.status).toBe(404);
    expect(own.status).toBe(201);
  });
});

describe("from_owner on an agent's stream", () => {
  it("should be true only for a message its owner wrote from the UI", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const target = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    await insertUser(BOB);
    await setGrant(prisma, ALICE.oid, BOB.oid, "write");
    const aliceLaptop = await insertAgent(ALICE, "laptop");

    const fromOwner = await directAsPerson(prisma, ALICE.oid, target, "please run the tests");
    const fromGrantee = await directAsPerson(prisma, BOB.oid, target, "and lint");
    const fromAgent = await directAsAgent(prisma, { id: aliceLaptop, ownerOid: ALICE.oid }, { toAgent: target, body: "from the laptop" });

    const streamed = await queuedDeliveries(prisma, target);
    expect(streamed.map((entry) => [entry.message.id, entry.from_owner])).toEqual([
      [fromOwner.id, true],
      [fromGrantee.id, false],
      [fromAgent.id, false]
    ]);
    expect(await queuedDelivery(prisma, target, BigInt(fromOwner.id))).toMatchObject({ from_owner: true });
  });
});

describe("sweepVirtualAgents", () => {
  const NOW = new Date("2026-10-26T12:00:00.000Z");
  const OPTIONS = { now: NOW, idleMinutes: 120, eveningStop: { hour: 19, minute: 0 } };

  function ago(minutes: number): Date {
    return new Date(NOW.getTime() - minutes * 60_000);
  }

  it("should fail an agent still provisioning with nothing from its pod for fifteen minutes", async () => {
    const stale = await create(ALICE, "stale");
    const fresh = await create(ALICE, "fresh");
    await prisma.virtualAgent.update({ where: { id: stale.id }, data: { status: "provisioning", statusChangedAt: ago(16), startedAt: ago(16) } });
    await prisma.virtualAgent.update({
      where: { id: fresh.id },
      data: { status: "provisioning", statusChangedAt: ago(16), lastActiveAt: ago(5), startedAt: ago(16) }
    });

    expect(await sweepVirtualAgents(prisma, OPTIONS)).toMatchObject({ failed: [stale.id] });
    expect(await row(stale.id)).toMatchObject({ status: "failed", statusDetail: expect.stringContaining("15 minutes") });
    expect((await row(fresh.id)).status).toBe("provisioning");
  });

  it("should expire pending logins past their expiry and drop pasted codes past theirs", async () => {
    const agent = await create(ALICE, "pcs-api");
    await prisma.virtualAgentLogin.create({
      data: {
        virtualAgentId: agent.id,
        kind: "github",
        prompt: "device_code",
        userCode: "A-1",
        verificationUri: "https://github.com/login/device",
        expiresAt: ago(1)
      }
    });
    await prisma.virtualAgentLogin.create({
      data: {
        virtualAgentId: agent.id,
        kind: "claude",
        prompt: "paste_code",
        verificationUri: "https://claude.ai/",
        expiresAt: new Date(NOW.getTime() + 60_000),
        pastedCodeCiphertext: new Uint8Array([1]),
        pastedCodeIv: new Uint8Array([1]),
        pastedCodeTag: new Uint8Array([1]),
        pastedCodeExpiresAt: ago(1)
      }
    });

    expect(await sweepVirtualAgents(prisma, OPTIONS)).toMatchObject({ loginsExpired: [agent.id] });
    const logins = await prisma.virtualAgentLogin.findMany({ orderBy: { kind: "asc" } });
    expect(logins.map((login) => [login.kind, login.state, login.pastedCodeExpiresAt])).toEqual([
      ["github", "expired", null],
      ["claude", "pending", null]
    ]);
  });

  it("should release claims older than two minutes", async () => {
    const agent = await create(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { claimedBy: "dead", claimedAt: ago(3), startedAt: ago(3) } });

    expect(await sweepVirtualAgents(prisma, OPTIONS)).toMatchObject({ claimsReleased: 1 });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } })).claimedBy).toBeNull();
  });

  it("should stop a running agent that has done nothing for the idle period, and leave a busy or recently active one", async () => {
    const idle = await create(ALICE, "idle");
    const busy = await create(BOB, "busy");
    const chatty = await create(CAROL, "chatty");
    const busyAgent = await insertAgent(BOB, "busy-session", { status: "busy" });
    const chattyAgent = await insertAgent(CAROL, "chatty-session", { status: "idle" });
    await prisma.transcriptEntry.create({
      data: { agentId: chattyAgent, sessionId: "s", entryKey: "k", role: "assistant", content: { text: "hi" }, occurredAt: ago(10), createdAt: ago(10) }
    });
    for (const [id, agentId] of [
      [idle.id, null],
      [busy.id, busyAgent],
      [chatty.id, chattyAgent]
    ] as const) {
      await prisma.virtualAgent.update({
        where: { id },
        data: { status: "running", statusChangedAt: ago(300), lastActiveAt: ago(300), startedAt: ago(300), agentId }
      });
    }

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ idle: [idle.id], evening: [] });
    expect(await row(idle.id)).toMatchObject({ desired: "stopped", stopReason: "idle", generation: 2 });
    expect((await row(busy.id)).desired).toBe("running");
    expect((await row(chatty.id)).desired).toBe("running");
  });

  it("should not stop an agent as idle when it was started again just now after a night stopped", async () => {
    const agent = await create(ALICE, "morning");
    await prisma.virtualAgent.update({
      where: { id: agent.id },
      data: { status: "running", statusChangedAt: ago(900), lastActiveAt: ago(900), startedAt: ago(1), agentId: null }
    });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ idle: [] });
    expect((await row(agent.id)).desired).toBe("running");
  });

  it("should stop every agent started before a weekday's evening stop, and not one started after it", async () => {
    const early = await create(ALICE, "early");
    const late = await create(BOB, "late");
    const evening = new Date("2026-10-26T19:05:00.000Z");
    await prisma.virtualAgent.update({ where: { id: early.id }, data: { startedAt: new Date("2026-10-26T09:00:00.000Z"), statusChangedAt: evening } });
    await prisma.virtualAgent.update({ where: { id: late.id }, data: { startedAt: new Date("2026-10-26T19:01:00.000Z"), statusChangedAt: evening } });

    const result = await sweepVirtualAgents(prisma, { ...OPTIONS, now: evening });

    expect(result).toMatchObject({ evening: [early.id], idle: [] });
    expect(await row(early.id)).toMatchObject({ desired: "stopped", stopReason: "evening" });
    expect((await row(late.id)).desired).toBe("running");
  });

  it("should stand down while another pod holds the sweep lock", async () => {
    const other = await connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [0x76697274_61676e74n.toString()]);

      expect(await sweepVirtualAgents(prisma, OPTIONS)).toBeUndefined();
      await other.query("COMMIT");
    } finally {
      await other.end();
    }
  });

  it("should sweep on its interval until stopped", async () => {
    const agent = await create(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { claimedBy: "dead", claimedAt: new Date(Date.now() - 3 * 60_000) } });

    const sweeper = startVirtualAgentSweep(prisma, 20);
    try {
      await expect.poll(async () => (await prisma.virtualAgent.findUniqueOrThrow({ where: { id: agent.id } })).claimedBy).toBeNull();
    } finally {
      sweeper.stop();
    }
  });
});

describe("the web UI's reads and actions", () => {
  it("should create, stop, start and delete the viewer's own virtual agent through the actions", async () => {
    actAs("alice");
    await insertUser(ALICE);

    const created = await actions.createVirtualAgent(form({ name: "pcs-api" }));
    expect(created).toMatchObject({ ok: true, confirmation: "pcs-api is starting" });
    const id = (created as { id: string }).id;

    expect(await actions.stopVirtualAgent(form({ id }))).toEqual({ ok: true });
    expect((await row(id)).desired).toBe("stopped");
    expect(await actions.startVirtualAgent(form({ id }))).toEqual({ ok: true });
    expect((await row(id)).desired).toBe("running");
    expect(await actions.deleteVirtualAgent(form({ id }))).toEqual({ ok: true });
    expect((await row(id)).desired).toBe("deleted");
    expect(await actions.startVirtualAgent(form({ id }))).toMatchObject({ ok: false, error: expect.stringContaining("being deleted") });
    expect(await actions.stopVirtualAgent(form({ id: "" }))).toEqual({ ok: false, error: "no virtual agent was named" });
  });

  it("should refuse a create over the limits with a sentence the page shows", async () => {
    actAs("alice");
    await insertUser(ALICE);
    for (let index = 0; index < MAX_RUNNING_PER_USER; index += 1) {
      await actions.createVirtualAgent(form({ name: `agent-${index}` }));
    }

    expect(await actions.createVirtualAgent(form({ name: "one-more" }))).toMatchObject({ ok: false, error: expect.stringContaining("running") });
  });

  it("should capture the viewer's model route when the agent is created", async () => {
    actAs("own-licence");
    await insertUser({ oid: "dev-own-licence", name: "Dev own-licence (sign-in disabled)", email: "own-licence@dev.invalid" });

    const created = (await actions.createVirtualAgent(form({ name: "pcs-api" }))) as { id: string };

    expect((await row(created.id)).modelRoute).toBe("own-licence");
  });

  it("should show the viewer only their own virtual agents, with the linked agent's conversation once there is one", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await create(BOB, "bobs");
    const agentId = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    await directAsPerson(prisma, ALICE.oid, agentId, "hello");
    const viewer = { ...ALICE, tid: "dev", modelRoute: "bedrock" as const };

    const list = await virtualAgentsPage(viewer);
    const page = await virtualAgentPage(viewer, id);

    expect(list.agents.map((agent) => agent.name)).toEqual(["pcs-api"]);
    expect(page?.detail.needed).toEqual(["github", "azure", "bedrock"]);
    expect(page?.linked?.view.agent.id).toBe(agentId);
    expect(page?.linked?.conversation.messages.map((message) => message.body)).toEqual(["hello"]);
    expect(await virtualAgentPage({ ...BOB, tid: "dev", modelRoute: "bedrock" }, id)).toBeUndefined();
    expect(await virtualAgentPage(viewer, "not-a-uuid")).toBeUndefined();
  });

  it("should need a Bedrock API key and no Claude token when the agent is on the Bedrock route", async () => {
    const agent = await create(ALICE, "pcs-api", "bedrock");

    expect((await virtualAgentDetail(prisma, ALICE.oid, agent.id))?.needed).toEqual(["github", "azure", "bedrock"]);
  });

  it("should need a Claude token and no Bedrock API key when the agent is on its owner's own licence", async () => {
    const agent = await create(ALICE, "pcs-api", "own-licence");

    expect((await virtualAgentDetail(prisma, ALICE.oid, agent.id))?.needed).toEqual(["github", "azure", "claude"]);
  });
});

describe("with virtual agents off", () => {
  beforeEach(() => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
  });

  it("should answer 404 on every virtual-agent and orchestrator route", async () => {
    const id = "0f8a6a1e-0000-4000-8000-000000000001";
    const token = `ahv_${"x".repeat(43)}`;

    const responses = await Promise.all([
      status(id, token, { phase: "running" }),
      pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/github`, { virtualAgentId: id, kind: "github" }),
      pod(codeRoute.GET, token, `/api/virtual/${id}/login/claude/code`, { virtualAgentId: id, kind: "claude" }),
      orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, "POST", { cluster: "x" }),
      orchestrator(liveRoute.GET, "/api/orchestrator/live", {}),
      observe(id, { generation: 1, replicas_ready: 0 })
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it("should refuse every action with a sentence saying so", async () => {
    actAs("alice");

    expect(await actions.createVirtualAgent(form({ name: "x" }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    expect(await actions.stopVirtualAgent(form({ id: "x" }))).toMatchObject({ ok: false });
    expect(await actions.pasteLoginCode(form({ id: "x", kind: "claude", code: "c" }))).toMatchObject({ ok: false });
  });

  it("should not recognise a launch token that was issued while it was on", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    const { token } = await started(ALICE, "pcs-api");
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");

    expect((await pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", { session_id: "s", name: "n" })).status).toBe(401);
  });
});

describe("a stored Claude token for the own-licence route", () => {
  it("should reach the pod when the owner saved it on the web", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "claude", value: CLAUDE, via: "web" });

    expect(await jsonOf(await pod(credentialRoute.GET, token, `/api/virtual/${id}/credentials/claude`, { virtualAgentId: id, kind: "claude" }))).toEqual({
      value: CLAUDE
    });
  });
});

describe("renaming a virtual agent", () => {
  it("should rename the virtual agent and its session, keep its pod's names and tell the owner's streams when the owner renames it", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const { agent_id } = await jsonOf(await register(token, "va-session-1"));
    const before = await row(id);
    actAs("alice");
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      expect(await actions.renameVirtualAgent(form({ id, name: " PCS-Frontend " }))).toEqual({ ok: true, confirmation: "Renamed to pcs-frontend" });

      await expect
        .poll(() => payloads.map((payload) => JSON.parse(payload)))
        .toContainEqual({ type: "virtual_agent", virtual_agent_id: id, owner_oid: ALICE.oid });
    } finally {
      await listener.end();
    }
    const after = await row(id);
    expect(after).toMatchObject({ name: "pcs-frontend", statefulsetName: before.statefulsetName, pvcName: before.pvcName, generation: before.generation });
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).name).toBe("pcs-frontend");
  });

  it("should keep the new name through the session's next heartbeat when it still calls itself by the old one", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const { agent_id } = await jsonOf(await register(token, "va-session-1"));
    await renameVirtualAgent(prisma, ALICE.oid, id, "jerry");

    const response = await pod(heartbeatRoute.POST, token, `/api/agent/${agent_id}/heartbeat`, { agentId: agent_id }, "POST", {
      status: "busy",
      name: "pcs-api"
    });

    expect(response.status).toBe(204);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agent_id } })).name).toBe("jerry");
  });

  it("should refuse with the name rule's sentence and change nothing when the name is invalid", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("alice");

    expect(await actions.renameVirtualAgent(form({ id: agent.id, name: "not_a name" }))).toEqual({
      ok: false,
      error: "a name is lowercase letters, digits and hyphens, starting and ending with a letter or digit"
    });
    await expect(renameVirtualAgent(prisma, ALICE.oid, agent.id, "")).rejects.toMatchObject({ status: 400 });
    expect((await row(agent.id)).name).toBe("pcs-api");
  });

  it("should refuse with a sentence naming the clash when the owner already has a virtual agent of that name", async () => {
    const agent = await create(ALICE, "pcs-api");
    await create(ALICE, "jerry");
    actAs("alice");

    expect(await actions.renameVirtualAgent(form({ id: agent.id, name: "jerry" }))).toEqual({
      ok: false,
      error: "you already have a virtual agent called jerry"
    });
    expect((await row(agent.id)).name).toBe("pcs-api");
  });

  it("should let the name match another person's virtual agent when only they have it", async () => {
    const agent = await create(ALICE, "pcs-api");
    await create(BOB, "jerry");

    await expect(renameVirtualAgent(prisma, ALICE.oid, agent.id, "jerry")).resolves.toMatchObject({ name: "jerry" });
  });

  it("should answer as for no such agent and change nothing when someone other than the owner renames it", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("bob");

    expect(await actions.renameVirtualAgent(form({ id: agent.id, name: "bobs" }))).toEqual({ ok: false, error: "no such virtual agent" });
    expect(await actions.renameVirtualAgent(form({ id: "", name: "bobs" }))).toEqual({ ok: false, error: "no virtual agent was named" });
    expect((await row(agent.id)).name).toBe("pcs-api");
  });

  it("should refuse a rename when the agent is being deleted", async () => {
    const agent = await create(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, agent.id, "deleted");

    await expect(renameVirtualAgent(prisma, ALICE.oid, agent.id, "jerry")).rejects.toMatchObject({ status: 409 });
  });

  it("should change nothing and succeed when the name is the one it already has", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(renameVirtualAgent(prisma, ALICE.oid, agent.id, "PCS-API")).resolves.toMatchObject({ name: "pcs-api" });
  });

  it("should refuse a rename when virtual agents are off", async () => {
    const agent = await create(ALICE, "pcs-api");
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    expect(await actions.renameVirtualAgent(form({ id: agent.id, name: "jerry" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("not available")
    });
  });
});

describe("/settings/credentials", () => {
  it("should send the viewer to the credentials section of the virtual agents page when virtual agents are on", async () => {
    actAs("alice");

    await expect(credentialsPage.default()).rejects.toMatchObject({ digest: expect.stringContaining(";/virtual#credentials;") });
  });

  it("should render the standalone page when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    await expect(credentialsPage.default()).resolves.toBeDefined();
  });
});

describe("a virtual agent's size", () => {
  it("should create a small agent unless another size is chosen, and refuse one that is not a size", async () => {
    await insertUser(ALICE);
    actAs("alice");

    const small = (await actions.createVirtualAgent(form({ name: "small-one" }))) as { id: string };
    const large = (await actions.createVirtualAgent(form({ name: "large-one", size: "large" }))) as { id: string };

    expect((await row(small.id)).size).toBe("small");
    expect((await row(large.id)).size).toBe("large");
    expect(await actions.createVirtualAgent(form({ name: "huge-one", size: "huge" }))).toEqual({ ok: false, error: "a size is one of small, medium, large" });
  });

  it("should change the size of an agent the orchestrator has not claimed yet, bump its generation and claim it with the new size", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id: agent.id, size: "medium" }))).toEqual({ ok: true, confirmation: "pcs-api is now medium" });

    expect((await row(agent.id)).generation).toBe(agent.generation + 1);
    expect((await claim()).find((entry) => entry.id === agent.id)).toMatchObject({ size: "medium", generation: agent.generation + 1 });
  });

  it("should change the size of a stopped agent and claim it again so the StatefulSet is applied with it", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const stopping = await row(id);
    await claim();
    await observe(id, { generation: stopping.generation, replicas_ready: 0 });
    expect((await row(id)).status).toBe("stopped");

    await setVirtualAgentSize(prisma, ALICE.oid, id, "large");

    expect((await claim()).find((entry) => entry.id === id)).toMatchObject({ size: "large", desired: "stopped", generation: stopping.generation + 1 });
  });

  it("should refuse a change while the agent's pod may be running, and change nothing", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const before = await row(id);
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id, size: "large" }))).toEqual({ ok: false, error: "stop the virtual agent before changing its size" });
    expect(await row(id)).toMatchObject({ size: "small", generation: before.generation });
  });

  it("should refuse someone other than the owner as if there were no such agent", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(setVirtualAgentSize(prisma, BOB.oid, agent.id, "large")).rejects.toMatchObject({ status: 404 });
    await expect(setVirtualAgentSize(prisma, ALICE.oid, agent.id, "huge")).rejects.toMatchObject({ status: 400 });
  });

  it("should leave the generation alone when the size is the one it has", async () => {
    const agent = await create(ALICE, "pcs-api");

    expect(await setVirtualAgentSize(prisma, ALICE.oid, agent.id, "small")).toMatchObject({ generation: agent.generation });
  });
});

describe("a virtual agent's exposed ports", () => {
  it("should expose and remove ports in any state, bump the generation each time, and claim the agent with them", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const before = await row(id);
    actAs("alice");
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      expect(await actions.exposePort(form({ id, port: "8080" }))).toEqual({ ok: true });
      expect(await actions.exposePort(form({ id, port: "3000" }))).toEqual({ ok: true });

      await expect
        .poll(() => payloads.map((payload) => JSON.parse(payload)))
        .toContainEqual({ type: "virtual_agent", virtual_agent_id: id, owner_oid: ALICE.oid });
    } finally {
      await listener.end();
    }
    expect(await row(id)).toMatchObject({ exposedPorts: [3000, 8080], generation: before.generation + 2 });
    expect((await claim()).find((entry) => entry.id === id)).toMatchObject({ exposed_ports: [3000, 8080] });

    expect(await actions.unexposePort(form({ id, port: "8080" }))).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ exposedPorts: [3000], generation: before.generation + 3 });
  });

  it("should show each port's URL under the configured domain on the owner's page", async () => {
    vi.stubEnv("VIRTUAL_AGENT_PUBLIC_DOMAIN", "example.net");
    const agent = await create(ALICE, "pcs-api");
    await setExposedPort(prisma, ALICE.oid, agent.id, 5173, true);

    expect((await virtualAgentDetail(prisma, ALICE.oid, agent.id))?.card.exposedPorts).toEqual([
      { port: 5173, url: `https://${agent.statefulsetName}-5173.example.net` }
    ]);
  });

  it("should refuse a port out of range, a port twice and a fourth port with a sentence the page shows", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("alice");

    expect(await actions.exposePort(form({ id: agent.id, port: "80" }))).toEqual({ ok: false, error: "a port is a whole number from 1024 to 65535" });
    for (const port of ["3000", "4000", "5000"]) {
      expect(await actions.exposePort(form({ id: agent.id, port }))).toEqual({ ok: true });
    }
    expect(await actions.exposePort(form({ id: agent.id, port: "3000" }))).toEqual({ ok: false, error: "port 3000 is already exposed" });
    expect(await actions.exposePort(form({ id: agent.id, port: "6000" }))).toMatchObject({ ok: false, error: expect.stringContaining("at most 3") });
    expect((await row(agent.id)).exposedPorts).toEqual([3000, 4000, 5000]);
  });

  it("should refuse a stranger as if there were no such agent, and a deleted agent", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("bob");

    expect(await actions.exposePort(form({ id: agent.id, port: "3000" }))).toEqual({ ok: false, error: "no such virtual agent" });
    expect(await actions.unexposePort(form({ id: "", port: "3000" }))).toEqual({ ok: false, error: "no virtual agent was named" });
    await setDesired(prisma, ALICE.oid, agent.id, "deleted");
    await expect(setExposedPort(prisma, ALICE.oid, agent.id, 3000, true)).rejects.toMatchObject({ status: 409 });
  });

  it("should leave the generation alone when a port that is not exposed is removed", async () => {
    const agent = await create(ALICE, "pcs-api");

    expect(await setExposedPort(prisma, ALICE.oid, agent.id, 3000, false)).toMatchObject({ generation: agent.generation, exposedPorts: [] });
  });

  it("should refuse an unservable port list in the database too, whatever writes it", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(prisma.virtualAgent.update({ where: { id: agent.id }, data: { exposedPorts: [80] } })).rejects.toThrow(/virtual_agent_exposed_ports_check/);
    await expect(prisma.virtualAgent.update({ where: { id: agent.id }, data: { exposedPorts: [3000, 4000, 5000, 6000] } })).rejects.toThrow(
      /virtual_agent_exposed_ports_check/
    );
  });

  it("should refuse every port and size action when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    for (const result of [
      await actions.exposePort(form({ id: "x", port: "3000" })),
      await actions.unexposePort(form({ id: "x", port: "3000" })),
      await actions.resizeVirtualAgent(form({ id: "x", size: "large" }))
    ]) {
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
    }
  });
});

describe("signing in again", () => {
  async function storedGithub(): Promise<void> {
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "github", value: GITHUB, via: "pod" });
  }

  it("should delete the credential and restart the pod with a fresh launch token when the agent is running", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await storedGithub();
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toEqual({
      ok: true,
      confirmation: "pcs-api is restarting to sign in to GitHub again"
    });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBeUndefined();
    expect(await prisma.credential.count({ where: { ownerOid: ALICE.oid, kind: "github" } })).toBe(0);
    const after = await row(id);
    expect(after.generation).toBe(before.generation + 1);
    expect(after).toMatchObject({ desired: "running", status: "provisioning", statusDetail: "restarting to sign in to GitHub again" });
    expect((await status(id, token, { phase: "running" })).status).toBe(401);
    const claimed = (await claim()).find((entry) => entry.id === id);
    expect(claimed).toMatchObject({ generation: after.generation, desired: "running" });
    expect(claimed?.launch_token).toBeDefined();
    expect((await status(id, claimed!.launch_token!, { phase: "awaiting_login" })).status).toBe(204);
  });

  it("should delete the credential and leave the generation alone when the agent is stopped", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "azure", value: AZURE, via: "pod" });
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "azure" }))).toEqual({ ok: true, confirmation: "pcs-api signs in to Azure when it next starts" });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBeUndefined();
    expect(await row(id)).toMatchObject({ generation: before.generation, desired: "stopped", status: before.status });
  });

  it("should delete nothing and restart nothing when someone other than the owner asks", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await storedGithub();
    await insertUser(BOB);
    const before = await row(id);

    actAs("bob");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toEqual({ ok: false, error: "no such virtual agent" });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
    expect((await row(id)).generation).toBe(before.generation);
  });

  it("should refuse when the kind is not a sign-in, or the agent is being deleted", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await storedGithub();
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "bedrock", value: BEDROCK, via: "web" });

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "bedrock" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await actions.reconnectSignIn(form({ id: "", kind: "github" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "bedrock")).toBe(BEDROCK);

    await setDesired(prisma, ALICE.oid, id, "deleted");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toMatchObject({ ok: false, error: expect.stringContaining("being deleted") });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
  });

  it("should refuse when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    actAs("alice");

    expect(await actions.reconnectSignIn(form({ id: "x", kind: "github" }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
  });
});
