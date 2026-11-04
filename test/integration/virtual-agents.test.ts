import { beforeEach, describe, expect, it, vi } from "vitest";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as liveRoute from "../../src/app/api/orchestrator/live/route.ts";
import * as credentialRoute from "../../src/app/api/virtual/[virtualAgentId]/credentials/[kind]/route.ts";
import * as codeRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/code/route.ts";
import { putCredential } from "../../src/credentials/store.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { APPLY_FAILURES_BEFORE_FAILED } from "../../src/virtual-agents/lifecycle.ts";
import { MAX_VIRTUAL_AGENTS_PER_USER } from "../../src/virtual-agents/limits.ts";
import {
  createVirtualAgent,
  reportPorts,
  reportStatus,
  setDesired,
  setVirtualAgentPlugins,
  setVirtualAgentSize,
  type VirtualAgentRow
} from "../../src/virtual-agents/store.ts";
import { neededCredentials } from "../../src/virtual-agents/views.ts";
import { insertAgent, insertUser, prisma } from "./database.ts";
import { jsonOf } from "./routes.ts";
import {
  ALICE,
  BOB,
  CLAUDE,
  claim,
  create,
  form,
  localStore,
  observe,
  orchestrator,
  pod,
  ports,
  register,
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

const { actAs, revalidated } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/virtual-agents.ts");
const { agentAddress, assistantAgent } = await import("../../src/web/data.ts");
const agentsPage = await import("../../src/app/hub/agents/[id]/page.tsx");

virtualAgentSuite();

describe("creating virtual agents", () => {
  it("should create one meant to be running, with names derived from its id, when the owner is under the limits", async () => {
    const agent = await create(ALICE, "PCS-api");

    expect(agent).toMatchObject({ name: "pcs-api", desired: "running", status: "requested", generation: 1, observedGeneration: 0, modelRoute: "gateway" });
    expect(agent.statefulsetName).toBe(`va-${agent.id.slice(0, 8)}`);
    expect(agent.pvcName).toBe(`work-va-${agent.id.slice(0, 8)}-0`);
  });

  it("should run every agent at once and refuse another create, running or stopped, when the owner is at the limit", async () => {
    for (let index = 0; index < MAX_VIRTUAL_AGENTS_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }
    expect(await prisma.virtualAgent.count({ where: { ownerOid: ALICE.oid, desired: "running" } })).toBe(MAX_VIRTUAL_AGENTS_PER_USER);
    const message = `you already have ${MAX_VIRTUAL_AGENTS_PER_USER} virtual agents; delete one first`;
    await expect(create(ALICE, "one-too-many")).rejects.toMatchObject({ status: 409, message });

    await setDesired(prisma, ALICE.oid, (await prisma.virtualAgent.findFirstOrThrow({ where: { name: "agent-0" } })).id, "stopped");
    await expect(create(ALICE, "still-too-many")).rejects.toMatchObject({ status: 409, message });
    expect(await prisma.virtualAgent.count()).toBe(MAX_VIRTUAL_AGENTS_PER_USER);
  });

  it("should give the place back when one of the owner's agents is deleted", async () => {
    for (let index = 0; index < MAX_VIRTUAL_AGENTS_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }

    await setDesired(prisma, ALICE.oid, (await prisma.virtualAgent.findFirstOrThrow({ where: { name: "agent-0" } })).id, "deleted");

    await expect(create(ALICE, "replacement")).resolves.toMatchObject({ desired: "running" });
  });

  it("should start a stopped agent when every other agent the owner has is running", async () => {
    const stopped = await create(ALICE, "stopped");
    for (let index = 1; index < MAX_VIRTUAL_AGENTS_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }
    await setDesired(prisma, ALICE.oid, stopped.id, "stopped");

    await expect(setDesired(prisma, ALICE.oid, stopped.id, "running")).resolves.toMatchObject({ desired: "running" });
  });

  it("should record the stop as its owner's and clear the failure's detail when its owner stops a failed agent", async () => {
    const agent = await create(ALICE, "failed");
    await reportStatus(prisma, agent.id, "failed", "github: the signed-in account cannot clone hmcts/cft-workspace");

    const stopped = await setDesired(prisma, ALICE.oid, agent.id, "stopped");

    expect(stopped).toMatchObject({ desired: "stopped", stopReason: "user" });
    expect(stopped.statusDetail).toBeNull();
  });

  it("should let only one of two concurrent creates through when one place is left", async () => {
    for (let index = 0; index < MAX_VIRTUAL_AGENTS_PER_USER - 1; index += 1) {
      await create(ALICE, `agent-${index}`);
    }

    const results = await Promise.allSettled([create(ALICE, "second"), create(ALICE, "third")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.virtualAgent.count({ where: { ownerOid: ALICE.oid } })).toBe(MAX_VIRTUAL_AGENTS_PER_USER);
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

describe("the web UI's reads and actions", () => {
  // The Assistant's `ensureAssistant` is the one thing that creates a virtual agent, and it makes one only when the
  // person has none, so nobody can reach the per-person limit by a path they cannot undo.
  it("should offer the web UI no action that creates a virtual agent", () => {
    expect(Object.keys(actions).filter((name) => /create/i.test(name))).toEqual([]);
  });

  it("should refuse a create with a sentence when the owner is at the limit", async () => {
    for (let index = 0; index < MAX_VIRTUAL_AGENTS_PER_USER; index += 1) {
      await create(ALICE, `agent-${index}`);
    }

    await expect(create(ALICE, "one-more")).rejects.toMatchObject({ message: expect.stringContaining(`${MAX_VIRTUAL_AGENTS_PER_USER} virtual agents`) });
  });

  it("should need the owner's Azure sign-in and no Claude token when the agent is on the gateway route", async () => {
    const agent = await create(ALICE, "pcs-api", "gateway");

    expect(neededCredentials(agent.modelRoute)).toEqual(["github", "azure"]);
  });

  it("should need a Claude token and no Azure sign-in when the agent is on its owner's own licence", async () => {
    const agent = await create(ALICE, "pcs-api", "own-licence");

    expect(neededCredentials(agent.modelRoute)).toEqual(["github", "claude"]);
  });
});

/** What the Assistant's settings read and post to for the virtual agent the Assistant runs on. */
describe("the Assistant's settings for its agent", () => {
  const ALICE_VIEWER = { ...ALICE, tid: "dev", modelRoute: "gateway" as const };

  it("should give the owner their assistant's name, state and ports, linked on the viewer under the port's prefix", async () => {
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "agent-hub-viewer.example");
    vi.stubEnv("ENTRA_REDIRECT_URI", "https://agent-hub.example/auth/callback");
    const { id } = await started(ALICE, "assistant");
    await reportPorts(prisma, id, { ports: [3000], localOnly: [5173] });

    const agent = await assistantAgent(ALICE_VIEWER);

    expect(agent).toMatchObject({ id, name: "assistant", desired: "running", localOnlyPorts: [5173] });
    expect(agent?.exposedPorts).toEqual([
      { port: 3000, url: expect.stringMatching(/^https:\/\/va-[0-9a-f]{8}-3000\./), viewerUrl: `https://agent-hub-viewer.example/${id}/3000/` }
    ]);
  });

  it("should give nobody else anything, and the owner nothing before they have an assistant", async () => {
    await insertUser(BOB);
    expect(await assistantAgent({ ...BOB, tid: "dev", modelRoute: "gateway" })).toBeUndefined();
    await started(ALICE, "assistant");

    expect(await assistantAgent({ ...BOB, tid: "dev", modelRoute: "gateway" })).toBeUndefined();
  });

  it("should clear the old pod's reported ports and its run of apply errors when the owner restarts it", async () => {
    const { id, token } = await started(ALICE, "assistant");
    expect((await ports(id, token, { ports: [3000], local_only: [5173] })).status).toBe(204);
    await prisma.virtualAgent.update({ where: { id }, data: { applyFailures: APPLY_FAILURES_BEFORE_FAILED - 1 } });
    actAs("alice");

    await actions.restartVirtualAgent(form({ id }));

    expect(await row(id)).toMatchObject({ exposedPorts: [], localOnlyPorts: [], applyFailures: 0 });
    expect((await assistantAgent({ ...ALICE, tid: "dev", modelRoute: "gateway" }))?.exposedPorts).toEqual([]);
  });

  it("should replace a running agent's pod when the owner restarts it, and leave one that is not running alone", async () => {
    const { id } = await started(ALICE, "assistant");
    const before = await row(id);
    actAs("alice");

    expect(await actions.restartVirtualAgent(form({ id }))).toEqual({ ok: true, confirmation: "Restarting. Your chats are kept." });
    const after = await row(id);
    expect(after.podGeneration).toBeGreaterThan(before.podGeneration);
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id }, select: { launchTokenHash: true } })).launchTokenHash).toBeNull();

    await setDesired(prisma, ALICE.oid, id, "stopped");
    const stopped = await row(id);
    expect(await actions.restartVirtualAgent(form({ id }))).toMatchObject({ ok: true });
    expect((await row(id)).podGeneration).toBe(stopped.podGeneration);
  });

  it("should refuse a restart of somebody else's agent as for no such agent, and change nothing", async () => {
    const { id } = await started(ALICE, "assistant");
    const before = await row(id);
    await insertUser(BOB);
    actAs("bob");

    expect(await actions.restartVirtualAgent(form({ id }))).toEqual({ ok: false, error: "no such virtual agent" });
    expect((await row(id)).podGeneration).toBe(before.podGeneration);
  });

  it("should refuse a restart with a sentence when virtual agents are off", async () => {
    const agent = await create(ALICE, "assistant");
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    expect(await actions.restartVirtualAgent(form({ id: agent.id }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
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

    expect(await actions.resizeVirtualAgent(form({ id: "x", size: "medium" }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
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

describe("a virtual agent's size", () => {
  it("should create a small agent unless another size is chosen, and refuse one that is not a size", async () => {
    await insertUser(ALICE);
    const small = await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "gateway", name: "small-one" });
    const large = await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "gateway", name: "large-one", size: "large" });

    expect([small.size, large.size]).toEqual(["small", "large"]);
    await expect(createVirtualAgent(prisma, { owner: ALICE, modelRoute: "gateway", name: "huge-one", size: "huge" })).rejects.toMatchObject({
      message: "a size is one of small, medium, large"
    });
  });

  it("should change the size of an agent the orchestrator has not claimed yet, bump its generation and claim it with the new size", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id: agent.id, size: "medium" }))).toEqual({
      ok: true,
      confirmation: "It starts at medium the next time it runs."
    });

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

  // A running pod is replaced by the change, as a change of plugins replaces it, so the pod generation moves and the
  // confirmation says what that ends rather than only what the size is now.
  it("should change the size of a running agent, replace its pod and say that it is restarting", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const before = await row(id);
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id, size: "large" }))).toEqual({
      ok: true,
      confirmation: "Restarting at large. Your chats are kept, and anything one of them was working on has stopped."
    });
    expect(await row(id)).toMatchObject({ size: "large", generation: before.generation + 1, podGeneration: before.podGeneration + 1 });
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

describe("a virtual agent's plugins", () => {
  const OFFERED = "pcs=PCS team workflows,dtsse=DTSSE docs,wa";

  /** A form as the plugin checkboxes send it: one `plugins` field per ticked box. */
  function ticked(values: Record<string, string>, plugins: readonly string[]): FormData {
    const data = form(values);
    for (const name of plugins) {
      data.append("plugins", name);
    }
    return data;
  }

  async function createWith(plugins: readonly string[]): Promise<VirtualAgentRow> {
    await insertUser(ALICE);
    return await createVirtualAgent(prisma, { owner: ALICE, modelRoute: "gateway", name: "pcs-api", plugins });
  }

  beforeEach(() => {
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", OFFERED);
  });

  it("should create an agent with the ticked plugins, sorted, and claim it with them", async () => {
    const created = await createWith(["wa", "pcs"]);

    expect(created.plugins).toEqual(["pcs", "wa"]);
    expect((await claim()).find((entry) => entry.id === created.id)).toMatchObject({ plugins: ["pcs", "slides", "wa"] });
  });

  it("should create an agent with no plugins when none are ticked", async () => {
    expect((await createWith([])).plugins).toEqual([]);
  });

  // The offer list is only read once a name is ticked, so a hub whose configuration is malformed can still create the
  // virtual agents nobody asked plugins for — every Assistant, among them. Ticking one is a use of the configuration
  // and still fails loudly.
  it("should create an agent with no plugins when the hub's plugin configuration is malformed", async () => {
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    expect((await createWith([])).plugins).toEqual([]);
  });

  it("should fail to create an agent with a ticked plugin when the hub's plugin configuration is malformed", async () => {
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    await expect(createWith(["pcs"])).rejects.toThrow("VIRTUAL_AGENT_PLUGINS");
    expect(await prisma.virtualAgent.count()).toBe(0);
  });

  it("should refuse to create an agent with a plugin the hub does not offer, and create nothing", async () => {
    await expect(createWith(["pcs", "civil"])).rejects.toMatchObject({ message: "civil is not a plugin this hub offers" });
    expect(await prisma.virtualAgent.count()).toBe(0);
  });

  it("should change a running agent's plugins, bumping both generations so the next claim replaces its pod", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const before = await row(id);
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id }, ["dtsse"]))).toEqual({ ok: true, confirmation: "pcs-api is restarting with its new plugins" });

    expect(await row(id)).toMatchObject({ plugins: ["dtsse"], generation: before.generation + 1, podGeneration: before.podGeneration + 1 });
    expect((await claim()).find((entry) => entry.id === id)).toMatchObject({
      plugins: ["dtsse", "slides"],
      generation: before.generation + 1,
      pod_generation: before.podGeneration + 1
    });
  });

  it("should change a stopped agent's plugins for its next start", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id }, ["pcs"]))).toEqual({
      ok: true,
      confirmation: "pcs-api loads its new plugins when it next starts"
    });
    expect((await row(id)).plugins).toEqual(["pcs"]);
  });

  it("should leave the generations alone and say so when the set is the one it has", async () => {
    const agent = await createWith(["pcs"]);
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id: agent.id }, ["pcs"]))).toEqual({ ok: true, confirmation: "Its plugins are unchanged" });
    expect(await row(agent.id)).toMatchObject({ generation: agent.generation, podGeneration: agent.podGeneration });
  });

  it("should clear every plugin when none are ticked", async () => {
    const agent = await createWith(["pcs", "wa"]);

    expect(await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, [])).toMatchObject({ plugins: [], generation: agent.generation + 1 });
  });

  it("should refuse a plugin the hub does not offer with 400, and change nothing", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["civil"])).rejects.toMatchObject({ status: 400 });
    expect(await row(agent.id)).toMatchObject({ plugins: [], generation: agent.generation });
  });

  // What the store checks is the names being ticked, so unticking everything never reads the offer list and so never
  // raises its error. That is the recovery route the owner gets: `PluginsPanel` keeps its form, with one control that
  // submits an empty list, whenever an agent has plugins and the offer could not be read.
  it("should let the owner clear every plugin while the hub's plugin configuration is malformed", async () => {
    const agent = await createWith(["pcs"]);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    expect(await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, [])).toMatchObject({ plugins: [] });
  });

  it("should fail to tick a plugin while the hub's plugin configuration is malformed", async () => {
    const agent = await createWith(["pcs"]);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    await expect(setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["pcs", "dtsse"])).rejects.toThrow("VIRTUAL_AGENT_PLUGINS");
    expect((await row(agent.id)).plugins).toEqual(["pcs"]);
  });

  it("should keep a plugin no longer offered when the owner leaves it ticked, but not let it be added again once unticked", async () => {
    const agent = await createWith(["pcs"]);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "dtsse");

    expect((await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["pcs", "dtsse"])).plugins).toEqual(["dtsse", "pcs"]);
    expect((await claim()).find((entry) => entry.id === agent.id)).toMatchObject({ plugins: ["dtsse", "pcs", "slides"] });
    await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["dtsse"]);
    await expect(setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["dtsse", "pcs"])).rejects.toMatchObject({ status: 400 });
  });

  it("should create an agent without slides when the request names it, since every pod loads it", async () => {
    expect((await createWith(["slides", "pcs"])).plugins).toEqual(["pcs"]);
  });

  it("should claim an agent with nothing ticked with slides, which every pod loads", async () => {
    const created = await createWith([]);

    expect(created.plugins).toEqual([]);
    expect((await claim()).find((entry) => entry.id === created.id)).toMatchObject({ plugins: ["slides"] });
  });

  it("should strip a stored slides on a save without bumping either generation when nothing ticked has changed", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id }, data: { plugins: ["pcs", "slides"] } });
    const before = await row(id);
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id }, ["pcs"]))).toEqual({ ok: true, confirmation: "Its plugins are unchanged" });

    expect(await row(id)).toMatchObject({ plugins: ["pcs"], generation: before.generation, podGeneration: before.podGeneration });
    expect((await claim()).some((entry) => entry.id === id)).toBe(false);
  });

  it("should strip a stored slides on a save that changes the ticked plugins, and claim the agent with slides added back", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await prisma.virtualAgent.update({ where: { id }, data: { plugins: ["pcs", "slides"] } });
    const before = await row(id);
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id }, ["dtsse"]))).toEqual({ ok: true, confirmation: "pcs-api is restarting with its new plugins" });

    expect(await row(id)).toMatchObject({ plugins: ["dtsse"], generation: before.generation + 1, podGeneration: before.podGeneration + 1 });
    expect((await claim()).find((entry) => entry.id === id)).toMatchObject({ plugins: ["dtsse", "slides"] });
  });

  it("should claim a row that still holds slides with it once", async () => {
    const agent = await createWith(["pcs"]);
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { plugins: ["pcs", "slides"] } });

    expect((await claim()).find((entry) => entry.id === agent.id)).toMatchObject({ plugins: ["pcs", "slides"] });
  });

  it("should neither add nor refuse slides when the form sends it for an agent that has none stored", async () => {
    const agent = await createWith(["pcs"]);

    expect(await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["pcs", "slides"])).toMatchObject({ plugins: ["pcs"], generation: agent.generation });
  });

  it("should store every offered plugin when the most an agent may have are ticked and the row still holds slides", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `p-${index}`);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", many.join(","));
    const agent = await createWith([]);
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { plugins: ["slides"] } });

    expect((await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, many)).plugins).toEqual([...many].sort(byCodePoint));
    expect((await row(agent.id)).plugins).toEqual([...many].sort(byCodePoint));
  });

  it("should accept slides alone while the hub's plugin configuration is malformed", async () => {
    const agent = await createWith([]);
    vi.stubEnv("VIRTUAL_AGENT_PLUGINS", "Not A Plugin Name");

    expect(await setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["slides"])).toMatchObject({ plugins: [], generation: agent.generation });
  });

  it("should refuse someone other than the owner as if there were no such agent", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(setVirtualAgentPlugins(prisma, BOB.oid, agent.id, ["pcs"])).rejects.toMatchObject({ status: 404 });
    expect((await row(agent.id)).plugins).toEqual([]);
  });

  it("should refuse a change while the agent is being deleted", async () => {
    const agent = await create(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, agent.id, "deleted");

    await expect(setVirtualAgentPlugins(prisma, ALICE.oid, agent.id, ["pcs"])).rejects.toMatchObject({ status: 409 });
  });

  it("should refuse the plugins action when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    expect(await actions.setVirtualAgentPlugins(ticked({ id: "x" }, ["pcs"]))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
  });

  it("should refuse more plugins than the most an agent may have in the database too, whatever writes it", async () => {
    const agent = await create(ALICE, "pcs-api");

    await expect(
      prisma.virtualAgent.update({ where: { id: agent.id }, data: { plugins: Array.from({ length: 21 }, (_unused, index) => `p-${index}`) } })
    ).rejects.toThrow(/virtual_agent_plugins_check/);
    await expect(prisma.virtualAgent.update({ where: { id: agent.id }, data: { plugins: { pcs: true } } })).rejects.toThrow(/virtual_agent_plugins_check/);
  });
});

/** The hub shows no agents, so `/hub/agents/{id}` only sends the viewer on, as `retiredAgentPath` says. */
describe("/hub/agents/{id}", () => {
  function visit(id: string): Promise<unknown> {
    return agentsPage.default({ params: Promise.resolve({ id }) });
  }

  function redirectedTo(path: string) {
    return { digest: expect.stringContaining(`;${path};`) };
  }

  it("should send the owner to the Assistant's settings when a virtual agent's id is visited, before or after a session registers", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    actAs("alice");

    await expect(visit(id)).rejects.toMatchObject(redirectedTo("/assistant?settings=assistant"));
    await jsonOf(await register(token, "va-session-1"));
    await expect(visit(id)).rejects.toMatchObject(redirectedTo("/assistant?settings=assistant"));
  });

  // The settings show and restart `findAssistant`'s agent, the person's oldest. Sending a later agent's address there
  // would put the oldest agent's Restart under it, and pressing it would replace the wrong pod.
  it("should send the owner to the Assistant itself, not its settings, when a later virtual agent of theirs or its session is visited", async () => {
    const first = await started(ALICE, "assistant");
    const later = await started(ALICE, "other");
    const session = (await jsonOf(await register(later.token, "va-session-later"))).agent_id;
    actAs("alice");

    await expect(visit(later.id)).rejects.toMatchObject(redirectedTo("/assistant"));
    await expect(visit(session)).rejects.toMatchObject(redirectedTo("/assistant"));
    await expect(visit(first.id)).rejects.toMatchObject(redirectedTo("/assistant?settings=assistant"));
    expect(await agentAddress({ ...ALICE, tid: "dev" }, later.id)).toEqual({ kind: "virtual", assistant: false });
    expect((await assistantAgent({ ...ALICE, tid: "dev", modelRoute: "gateway" }))?.id).toBe(first.id);
  });

  it("should send the owner to the Assistant's settings when a session a virtual agent registered is visited, including one a /clear superseded", async () => {
    const { token } = await started(ALICE, "pcs-api");
    const first = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    const second = (await jsonOf(await register(token, "va-session-2"))).agent_id;
    actAs("alice");

    await expect(visit(first)).rejects.toMatchObject(redirectedTo("/assistant?settings=assistant"));
    await expect(visit(second)).rejects.toMatchObject(redirectedTo("/assistant?settings=assistant"));
  });

  it("should send the owner to the hub's home when a laptop agent with no chat is visited", async () => {
    const laptop = await insertAgent(ALICE, "laptop");
    actAs("alice");

    await expect(visit(laptop)).rejects.toMatchObject(redirectedTo("/hub"));
  });

  it("should send a stranger to the hub's home, whether the id is a virtual agent, its session or nothing", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const agentId = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    await insertUser(BOB);
    actAs("bob");

    for (const visited of [id, agentId, "0f8a6a1e-0000-4000-8000-00000000dead", "not-a-uuid"]) {
      expect(await agentAddress({ ...BOB, tid: "dev" }, visited)).toEqual({ kind: "none" });
      await expect(visit(visited)).rejects.toMatchObject(redirectedTo("/hub"));
    }
  });

  it("should send everyone to the hub's home when virtual agents are off", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const agentId = (await jsonOf(await register(token, "va-session-1"))).agent_id;
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");
    actAs("alice");

    await expect(visit(id)).rejects.toMatchObject(redirectedTo("/hub"));
    await expect(visit(agentId)).rejects.toMatchObject(redirectedTo("/hub"));
  });

  it("should revalidate the Assistant's pages, and no agent page, when an action changes a virtual agent", async () => {
    const agent = await create(ALICE, "pcs-api");
    actAs("alice");

    await actions.resizeVirtualAgent(form({ id: agent.id, size: "medium" }));

    expect(revalidated).toContain("/assistant");
    expect(revalidated.some((path) => path.startsWith("/hub/agents"))).toBe(false);
  });
});
