// What an assistant's pod says about its own memory, end to end through Postgres: the pod's report, what the
// settings read from it, who may read it, and the size change the warning sends people to.
//
// The pod's own half — reading the cgroup — is in the client package's `src/assistant/memory.test.ts`; the threshold
// and the three "we cannot tell" states are in `src/assistant/memory-report.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as memoryRoute from "../../src/app/api/virtual/[virtualAgentId]/memory/route.ts";
import { assistantMemory, reportMemoryUse } from "../../src/assistant/memory.ts";
import { CONVERSATION_MEMORY_BYTES, memoryPressure } from "../../src/assistant/memory-report.ts";
import { createConversation, reportSessions } from "../../src/assistant/store.ts";
import { claimVirtualAgents, observeVirtualAgent } from "../../src/virtual-agents/store.ts";
import { assistantSize } from "../../src/web/data.ts";
import { ALICE, BOB, form, podFixture, viewer } from "./assistant-pod.ts";
import { type Person, prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/virtual-agents.ts");

beforeEach(async () => {
  await resetDatabase();
  actAs("alice");
  // Every `/api/virtual/…` route, and every virtual-agent action, answers as if it did not exist without this.
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
});

const LIMIT = 8 * 1024 ** 3;

/**
 * A report whose non-reclaimable figure leaves `headroom` bytes under the limit, which is what the threshold is about.
 *
 * **Both figures that count page cache are pinned at the limit** — `current_bytes` and `peak_bytes` — and neither may
 * raise the warning on its own: a pod that has merely read its workspace clone sits at its ceiling on both, and
 * nothing resets `memory.peak` while the pod lives, so a threshold computed from it could never be cleared.
 */
function report(headroom: number) {
  return { limit_bytes: LIMIT, current_bytes: LIMIT, peak_bytes: LIMIT, anon_bytes: LIMIT - headroom };
}

/**
 * The shared fixture, bound to the claims this suite is about: the pod's own session reports its memory, including
 * the `anon` figure the warning is computed from. Both names, because that is what a current client claims.
 */
const assistantOf = podFixture(["memory", "memory-anon"]);

/** A chat with a session the pod says is running, which is what a change of size would end. */
async function openChat(who: Person, title: string, sessionState: string | null = "live"): Promise<string> {
  const conversation = await createConversation(prisma, who.oid, { title });
  await prisma.assistantConversation.update({ where: { id: conversation.id }, data: { sessionState } });
  return conversation.id;
}

/** The assistant's own launch token, which is the only caller the pod-facing route accepts. */
async function launchToken(id: string): Promise<string> {
  const claimed = await claimVirtualAgents(prisma, "preview-01", { limit: 20 });
  const mine = claimed.virtual_agents.find((agent) => agent.id === id);
  if (mine?.launch_token === undefined || mine.launch_token === null) {
    throw new Error("the assistant was not claimed with a launch token");
  }
  await observeVirtualAgent(prisma, id, { generation: mine.generation, replicasReady: 1, podPhase: "Running" });
  return mine.launch_token;
}

async function put(id: string, token: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/virtual/${id}/memory`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await memoryRoute.PUT(request, { params: Promise.resolve({ virtualAgentId: id }) });
}

describe("the memory an assistant reports", () => {
  it("should show the four figures, dated, when the pod has reported", async () => {
    const assistant = await assistantOf(ALICE);

    await reportMemoryUse(prisma, assistant, report(4 * CONVERSATION_MEMORY_BYTES));
    const view = await assistantMemory(prisma, ALICE.oid, assistant);

    expect(view?.use).toMatchObject({
      reported: true,
      limitBytes: LIMIT,
      currentBytes: LIMIT,
      peakBytes: LIMIT,
      anonBytes: LIMIT - 4 * CONVERSATION_MEMORY_BYTES,
      stopped: false
    });
    expect(view?.use.reported && typeof view.use.at).toBe("string");
  });

  // Never zero for "we have not heard": that would read as an idle pod.
  it("should report nothing, rather than an idle pod, before it has said anything", async () => {
    const assistant = await assistantOf(ALICE);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "waiting" });
  });

  it("should say the client is too old when the pod's own session never claimed the feature", async () => {
    const assistant = await assistantOf(ALICE, null);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "older_client" });
  });

  // A client from before `anon_bytes` claims `memory` and sends three figures, which the route refuses. Shown as an
  // older version rather than a pod that has gone quiet: it is, and its next boot fixes it.
  it("should say the client is too old when its own session claims memory but not the anon figure", async () => {
    const assistant = await podFixture(["memory"])(ALICE);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "older_client" });
  });

  it("should say nothing has looked when the assistant is stopped and has never reported", async () => {
    const assistant = await assistantOf(ALICE, ["memory"], "stopped");

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "not_running" });
  });

  // No session has ever registered, so nothing has claimed anything either way; calling that an older version would
  // be a guess about a pod that has never been up.
  it("should say nothing has looked, not that the client is old, when no supervisor has ever registered", async () => {
    const assistant = await assistantOf(ALICE, null, "stopped", { session: false });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "not_running" });
  });

  it("should replace the last report, not add to it, when the pod reports again", async () => {
    const assistant = await assistantOf(ALICE);

    await reportMemoryUse(prisma, assistant, report(0));
    await reportMemoryUse(prisma, assistant, report(4 * CONVERSATION_MEMORY_BYTES));
    const view = await assistantMemory(prisma, ALICE.oid, assistant);

    expect(view?.use.reported && view.use.anonBytes).toBe(LIMIT - 4 * CONVERSATION_MEMORY_BYTES);
    expect(memoryPressure(view!.use, view!.openChats, view!.size)).toBeUndefined();
  });

  it("should count the chats with a session running, and not the ones queued for one", async () => {
    const assistant = await assistantOf(ALICE);
    await openChat(ALICE, "Possession claim", "live");
    await openChat(ALICE, "Rent arrears", "starting");
    await openChat(ALICE, "Waiting its turn", "queued");
    await openChat(ALICE, "Nothing running", null);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.openChats).toBe(2);
  });

  it("should warn once what it cannot reclaim leaves no room for another chat, and name the size to move to", async () => {
    const assistant = await assistantOf(ALICE);
    await openChat(ALICE, "Possession claim");

    await reportMemoryUse(prisma, assistant, report(CONVERSATION_MEMORY_BYTES - 1));
    const view = await assistantMemory(prisma, ALICE.oid, assistant);

    expect(memoryPressure(view!.use, view!.openChats, view!.size)).toMatchObject({ openChats: 1, nextSize: { size: "medium" } });
  });

  it("should refuse someone else's assistant as if there were none", async () => {
    const assistant = await assistantOf(ALICE);
    await reportMemoryUse(prisma, assistant, report(0));

    expect(await assistantMemory(prisma, BOB.oid, assistant)).toBeUndefined();
  });

  it("should give the signed-in person their own assistant and nobody else's, through the page's read", async () => {
    await assistantOf(ALICE);
    await assistantOf(BOB);
    actAs("alice");

    const mine = await assistantSize(viewer(ALICE));

    expect(mine).toMatchObject({ size: "small", openChats: 0 });
    expect(mine?.use).toEqual({ reported: false, reason: "waiting" });
  });
});

describe("the memory route a pod reports on", () => {
  it("should take a report from the assistant's own launch token and store it", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    expect((await put(assistant, token, report(0))).status).toBe(204);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toMatchObject({ reported: true, peakBytes: LIMIT });
  });

  it("should refuse another virtual agent's launch token", async () => {
    const mine = await assistantOf(ALICE);
    const theirs = await assistantOf(BOB);
    const token = await launchToken(theirs);

    expect((await put(mine, token, report(0))).status).toBe(403);
    expect((await assistantMemory(prisma, ALICE.oid, mine))?.use).toEqual({ reported: false, reason: "waiting" });
  });

  it.each([
    ["a missing figure", { limit_bytes: LIMIT, current_bytes: 1 }],
    ["a figure that is not whole", { limit_bytes: LIMIT, current_bytes: 1.5, peak_bytes: 2, anon_bytes: 1 }],
    ["a negative figure", { limit_bytes: LIMIT, current_bytes: 1, peak_bytes: -1, anon_bytes: 1 }],
    // What a client from before `anon_bytes` sends. Refused rather than stored without it, because the warning is
    // computed from it and a report the warning cannot be computed from is not a weaker report.
    ["the three figures an older client sends", { limit_bytes: LIMIT, current_bytes: 1, peak_bytes: 2 }]
  ])("should refuse %s rather than store half a report", async (_what, body) => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    expect((await put(assistant, token, body)).status).toBe(400);
    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.use).toEqual({ reported: false, reason: "waiting" });
  });

  // `memory.peak` is resettable on newer kernels, so a peak below the live figure is odd and not a reason to lose the
  // live figure with it.
  it("should take a peak below the live figure", async () => {
    const assistant = await assistantOf(ALICE);
    const token = await launchToken(assistant);

    expect((await put(assistant, token, { limit_bytes: LIMIT, current_bytes: 2048, peak_bytes: 1024, anon_bytes: 1024 })).status).toBe(204);
  });
});

describe("how many chats an assistant says it runs", () => {
  // The figure the pod enforces, not the size's cap. A cap is in the pod template and `CONVERSATION_SESSIONS` is a
  // code constant, so a deploy that raises it bumps no agent's generation and every running pod keeps the figure it
  // booted with — and at its cap the pod stops an idle session to make room rather than queueing, so showing the
  // higher figure would invite someone to end a chat they never closed.
  it("should show what the pod reported, and what a restart would change it to", async () => {
    const assistant = await assistantOf(ALICE);

    await reportSessions(prisma, assistant, { sessions: [], max: 3 });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: 3, fromRestart: 4 });
  });

  it("should offer nothing about a restart once the pod reports its size's cap", async () => {
    const assistant = await assistantOf(ALICE);

    await reportSessions(prisma, assistant, { sessions: [], max: 4 });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: 4, fromRestart: undefined });
  });

  // No current figure before the first report: the hub cannot see a pod's supervisor, so the cap is what the pod
  // will be given rather than what it has, and the pod sends its own within a minute.
  it("should claim no current figure before the pod has reported", async () => {
    const assistant = await assistantOf(ALICE);

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: undefined, fromRestart: 4 });
  });

  it("should keep the newest figure when a pod rolls onto a different cap", async () => {
    const assistant = await assistantOf(ALICE);

    await reportSessions(prisma, assistant, { sessions: [], max: 3 });
    await reportSessions(prisma, assistant, { sessions: [], max: 4 });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: 4, fromRestart: undefined });
  });

  // A stopped pod runs no chats, so the figure it last reported is not a present-tense answer. Nothing clears
  // `sessions_max`, so it is still on the row.
  it("should claim no current figure once the pod is stopped, however recently it reported", async () => {
    const assistant = await assistantOf(ALICE, ["memory"], "stopped");

    await reportSessions(prisma, assistant, { sessions: [], max: 4 });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: undefined, fromRestart: 4 });
  });

  // And a size change made while stopped must not have the dead pod's cap read back as the new size's.
  it("should not attribute a stopped pod's cap to the size it was resized to", async () => {
    const assistant = await assistantOf(ALICE, ["memory"], "stopped");
    await reportSessions(prisma, assistant, { sessions: [], max: 4 });
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id: assistant, size: "medium" }))).toMatchObject({ ok: true });

    expect((await assistantMemory(prisma, ALICE.oid, assistant))?.capacity).toEqual({ now: undefined, fromRestart: 6 });
  });
});

describe("changing an assistant's size from its settings", () => {
  it("should change the size, replace the pod and say so, for the assistant's owner", async () => {
    const assistant = await assistantOf(ALICE);
    await launchToken(assistant);
    const before = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { podGeneration: true } });
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id: assistant, size: "medium" }))).toEqual({
      ok: true,
      confirmation: "Restarting at medium. Your chats are kept, and anything one of them was working on has stopped."
    });

    expect(await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { size: true, podGeneration: true } })).toEqual({
      size: "medium",
      podGeneration: before.podGeneration + 1
    });
    expect((await assistantSize(viewer(ALICE)))?.size).toBe("medium");
  });

  // The action re-reads the viewer and hands that one oid to the store; an id in the form names an agent and never
  // an owner.
  it("should refuse someone else's assistant as if there were none, and change nothing", async () => {
    const theirs = await assistantOf(BOB);
    await assistantOf(ALICE);
    actAs("alice");

    expect(await actions.resizeVirtualAgent(form({ id: theirs, size: "large" }))).toMatchObject({ ok: false });
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: theirs }, select: { size: true } })).size).toBe("small");
  });
});
