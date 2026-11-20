import { describe, expect, it, vi } from "vitest";
import { readAssistantSchedule, saveAssistantSchedule } from "../../src/assistant/schedule-store.ts";
import { dueEveningStop } from "../../src/virtual-agents/cleanup.ts";
import { completeLogin, startLogin, storePastedCode } from "../../src/virtual-agents/logins.ts";
import { reportStatus, setDesired, type VirtualAgentRow } from "../../src/virtual-agents/store.ts";
import { startVirtualAgentSweep, sweepVirtualAgents } from "../../src/virtual-agents/sweep.ts";
import { connect, insertAgent, type Person, prisma } from "./database.ts";
import { ALICE, BOB, CAROL, create, row, SECRET, started, status, virtualAgentSuite } from "./virtual-agent-suite.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

virtualAgentSuite();

describe("sweepVirtualAgents", () => {
  const NOW = new Date("2026-10-26T12:00:00.000Z");
  const OPTIONS = { now: NOW, idleMinutes: 120, awaitingOwnerMinutes: 30, eveningStop: { hour: 19, minute: 0 } };
  /** Long enough to have started on the Sunday evening, which no weekday evening stop reaches. */
  const OVERNIGHT = 18 * 60;

  function ago(minutes: number): Date {
    return new Date(NOW.getTime() - minutes * 60_000);
  }

  /** An agent whose pod reported `phase` overnight and has re-reported it every five minutes for the last hour. */
  async function waitingSince(owner: Person, name: string, phase: "awaiting_login" | "awaiting_credentials"): Promise<VirtualAgentRow> {
    const agent = await create(owner, name);
    await reportStatus(prisma, agent.id, phase, `${phase} 0`, { now: ago(OVERNIGHT) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(OVERNIGHT) } });
    for (let minutes = 60; minutes >= 0; minutes -= 5) {
      await reportStatus(prisma, agent.id, phase, `${phase} ${minutes}`, { now: ago(minutes) });
    }
    return await row(agent.id);
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

  it("should fail an agent no orchestrator has picked up for fifteen minutes, and leave a claimed or recent one", async () => {
    const stuck = await create(ALICE, "stuck");
    const recent = await create(ALICE, "recent");
    const claimed = await create(ALICE, "claimed");
    await prisma.virtualAgent.update({ where: { id: stuck.id }, data: { statusChangedAt: ago(16), startedAt: ago(16) } });
    await prisma.virtualAgent.update({ where: { id: recent.id }, data: { statusChangedAt: ago(5), startedAt: ago(5) } });
    await prisma.virtualAgent.update({
      where: { id: claimed.id },
      data: { statusChangedAt: ago(16), startedAt: ago(16), claimedBy: "orch", claimedAt: ago(1) }
    });
    // Between tries after apply errors, whose claim has lapsed: the apply-failure rule is the one to fail it.
    const retrying = await create(BOB, "retrying");
    await prisma.virtualAgent.update({ where: { id: retrying.id }, data: { statusChangedAt: ago(16), startedAt: ago(16), applyFailures: 2 } });

    expect(await sweepVirtualAgents(prisma, OPTIONS)).toMatchObject({ failed: [stuck.id] });
    expect(await row(stuck.id)).toMatchObject({ status: "failed", statusDetail: "no assistant could be started for 15 minutes" });
    expect((await row(recent.id)).status).toBe("requested");
    expect((await row(claimed.id)).status).toBe("requested");
    expect((await row(retrying.id)).status).toBe("requested");
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

  it.each(["awaiting_login", "awaiting_credentials"] as const)(
    "should stop an agent that has spent the night asking its owner for %s and getting nothing",
    async (phase) => {
      const stalled = await waitingSince(ALICE, "stalled", phase);
      expect(stalled).toMatchObject({ status: phase, desired: "running", statusDetail: `${phase} 0` });
      // The Sunday evening start is past every weekday stop, so the evening rule is not what catches this one.
      expect(dueEveningStop(stalled.startedAt, NOW, OPTIONS.eveningStop)).toBe(false);

      const result = await sweepVirtualAgents(prisma, OPTIONS);

      expect(result).toMatchObject({ awaitingOwner: [stalled.id], idle: [], evening: [] });
      expect(await row(stalled.id)).toMatchObject({ desired: "stopped", stopReason: "awaiting_owner" });
    }
  );

  it("should leave an agent its owner has just signed in to, where the pod's own prompts would not have saved it", async () => {
    const waiting = await waitingSince(ALICE, "signed-in", "awaiting_login");
    await startLogin(
      prisma,
      waiting,
      "github",
      { prompt: "device_code", verificationUri: "https://github.com/login/device", userCode: "A1B2-C3D4", expiresInSeconds: 900 },
      ago(5)
    );
    await completeLogin(prisma, undefined, await row(waiting.id), "github", { accountOid: null, accountLabel: "alice" }, ago(2));

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ awaitingOwner: [], idle: [] });
    expect(await row(waiting.id)).toMatchObject({ status: "running", desired: "running" });
  });

  it("should leave an agent whose owner has just pasted the code its pod is waiting to fetch", async () => {
    const waiting = await waitingSince(ALICE, "pasted", "awaiting_login");
    await startLogin(prisma, waiting, "claude", { prompt: "paste_code", verificationUri: "https://claude.ai/", userCode: null, expiresInSeconds: 900 }, ago(5));
    await storePastedCode(prisma, ALICE.oid, waiting.id, "claude", "the-code", SECRET, ago(2));

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ awaitingOwner: [], idle: [] });
    expect(await row(waiting.id)).toMatchObject({ status: "awaiting_login", desired: "running" });
  });

  it("should leave an agent waiting on a sign-in while one of its sessions is still busy", async () => {
    const waiting = await waitingSince(ALICE, "busy-signin", "awaiting_login");
    const session = await insertAgent(ALICE, "busy-session", { status: "busy" });
    await prisma.virtualAgent.update({ where: { id: waiting.id }, data: { agentId: session } });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ awaitingOwner: [], idle: [] });
    expect((await row(waiting.id)).desired).toBe("running");
  });

  it("should stop an agent waiting on its owner long before the idle period would have", async () => {
    const agent = await create(ALICE, "an-hour");
    await reportStatus(prisma, agent.id, "awaiting_login", "github: the owner must enter code A1B2-C3D4", { now: ago(60) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(65) } });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ awaitingOwner: [agent.id], idle: [] });
    expect(await row(agent.id)).toMatchObject({ desired: "stopped", stopReason: "awaiting_owner" });
  });

  it("should leave an agent whose pod reported its wait only minutes ago", async () => {
    const agent = await create(ALICE, "just-asked");
    await reportStatus(prisma, agent.id, "awaiting_login", "github: the owner must enter code A1B2-C3D4", { now: ago(20) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(25) } });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ awaitingOwner: [], idle: [] });
    expect((await row(agent.id)).desired).toBe("running");
  });

  it("should stop a failed agent whose pod is still watching for a credential nobody has stored when the sweep runs overnight", async () => {
    const agent = await create(ALICE, "token-watch");
    const detail = "github: three sign-in codes went unused; paste a token on the credentials page, or stop and start this agent";
    // The pod's budget runs out, it reports failed, and then watches for a stored token without reporting again.
    await reportStatus(prisma, agent.id, "failed", detail, { now: ago(OVERNIGHT) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(OVERNIGHT) } });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ afterFailure: [agent.id], idle: [], awaitingOwner: [], evening: [] });
    const stopped = await row(agent.id);
    expect(stopped).toMatchObject({ desired: "stopped", stopReason: "failed" });
    expect(stopped.statusDetail).toBeNull();
  });

  it("should leave a failed agent alone while its owner still has time to read the failure", async () => {
    const agent = await create(ALICE, "just-failed");
    await reportStatus(prisma, agent.id, "failed", "github: the sign-in budget ran out", { now: ago(60) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(70) } });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ afterFailure: [], idle: [], awaitingOwner: [] });
    expect(await row(agent.id)).toMatchObject({ desired: "running", status: "failed" });
  });

  it("should leave a failed agent alone once its owner stores the credential and its pod reports work again", async () => {
    const agent = await create(ALICE, "recovered");
    await reportStatus(prisma, agent.id, "failed", "github: the sign-in budget ran out", { now: ago(OVERNIGHT) });
    await prisma.virtualAgent.update({ where: { id: agent.id }, data: { startedAt: ago(OVERNIGHT) } });
    // A failed agent is left only by a pod starting again, which is a report of work and so is activity.
    await reportStatus(prisma, agent.id, "provisioning", "the owner stored a token", { now: ago(2) });

    const result = await sweepVirtualAgents(prisma, OPTIONS);

    expect(result).toMatchObject({ afterFailure: [], idle: [], awaitingOwner: [] });
    expect(await row(agent.id)).toMatchObject({ desired: "running", status: "provisioning" });
  });

  it("should shut a swept pod out, so it cannot report its way back out of the stop", async () => {
    const { id, token } = await started(ALICE, "swept");
    await reportStatus(prisma, id, "failed", "github: the sign-in budget ran out", { now: ago(OVERNIGHT) });
    await prisma.virtualAgent.update({ where: { id }, data: { startedAt: ago(OVERNIGHT) } });
    expect(await sweepVirtualAgents(prisma, OPTIONS)).toMatchObject({ afterFailure: [id] });

    // POD_TRANSITIONS lets a pod leave `stopping`, so what keeps it out is the stop dropping its launch token: the
    // pod is no longer anyone, hence 401 rather than the 403 another agent's valid token gets.
    expect((await status(id, token, { phase: "provisioning" })).status).toBe(401);
    expect(await row(id)).toMatchObject({ desired: "stopped", status: "stopping" });
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
      await sweeper.stop();
    }
  });
});

describe("the sweep's schedule for an Assistant", () => {
  const STOP = { hour: 19, minute: 0 };
  /** A Monday, in Greenwich Mean Time. */
  const MONDAY_0800 = new Date("2026-10-26T08:00:00.000Z");
  const OPTIONS = { idleMinutes: 120, awaitingOwnerMinutes: 30, eveningStop: STOP };

  /** A conversation on the agent, last active at `at`: the person using their Assistant. */
  async function usedAt(owner: Person, virtualAgentId: string, at: Date): Promise<void> {
    await prisma.assistantConversation.create({ data: { ownerOid: owner.oid, virtualAgentId, lastActiveAt: at } });
  }

  async function stoppedAssistant(owner: Person, name = "assistant", usedOn = new Date("2026-10-25T10:00:00.000Z")): Promise<string> {
    const agent = await create(owner, name);
    await setDesired(prisma, owner.oid, agent.id, "stopped");
    await usedAt(owner, agent.id, usedOn);
    return agent.id;
  }

  function schedule(owner: Person, autoStart: string, idleAfter = "default"): Promise<unknown> {
    return saveAssistantSchedule(prisma, owner.oid, { autoStart, idleAfter });
  }

  it("should start a stopped Assistant at its owner's auto start time, as an owner's start does, and leave everyone else's", async () => {
    const alice = await stoppedAssistant(ALICE);
    const bob = await stoppedAssistant(BOB);
    await schedule(ALICE, "08:00");
    await schedule(BOB, "09:00");
    const before = await row(alice);

    const result = await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 });

    expect(result).toMatchObject({ autoStarted: [alice], evening: [], idle: [] });
    expect(await row(alice)).toMatchObject({ desired: "running", status: "requested", stopReason: null, generation: before.generation + 1 });
    expect((await row(alice)).startedAt).toEqual(MONDAY_0800);
    expect(await row(bob)).toMatchObject({ desired: "stopped" });
  });

  it("should start it at the UK time of the slot when the date is in British Summer Time", async () => {
    const id = await stoppedAssistant(ALICE);
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-07-06T06:59:00.000Z") })).toMatchObject({ autoStarted: [] });
    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-07-06T07:00:00.000Z") })).toMatchObject({ autoStarted: [id] });
  });

  it("should not start it again the same UK day when it is stopped after its start", async () => {
    const id = await stoppedAssistant(ALICE);
    await schedule(ALICE, "08:00");
    await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 });
    await setDesired(prisma, ALICE.oid, id, "stopped");

    const later = await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-10-26T08:10:00.000Z") });

    expect(later).toMatchObject({ autoStarted: [] });
    expect((await row(id)).desired).toBe("stopped");
  });

  it("should start it again the next weekday when the day before already had its start", async () => {
    const id = await stoppedAssistant(ALICE);
    await schedule(ALICE, "08:00");
    await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 });
    await setDesired(prisma, ALICE.oid, id, "stopped");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-10-27T08:00:00.000Z") })).toMatchObject({ autoStarted: [id] });
  });

  it("should count its day when it was already running, so a stop a minute later is not undone", async () => {
    const agent = await create(ALICE, "assistant");
    await schedule(ALICE, "08:00");
    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [] });
    await setDesired(prisma, ALICE.oid, agent.id, "stopped");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-10-26T08:01:00.000Z") })).toMatchObject({ autoStarted: [] });
    expect((await row(agent.id)).desired).toBe("stopped");
  });

  it.each([
    ["at the weekend", "2026-10-24T08:00:00.000Z"],
    ["before its window", "2026-10-26T07:59:00.000Z"],
    ["after its window", "2026-10-26T08:30:00.000Z"]
  ])("should leave it stopped when the sweep runs %s", async (_when, at) => {
    const id = await stoppedAssistant(ALICE);
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date(at) })).toMatchObject({ autoStarted: [] });
    expect((await row(id)).desired).toBe("stopped");
  });

  it("should leave it stopped when its owner has not used it for 14 days, and start it again once they do", async () => {
    const id = await stoppedAssistant(ALICE, "assistant", new Date("2026-10-12T07:59:00.000Z"));
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [] });
    expect((await row(id)).desired).toBe("stopped");

    await usedAt(ALICE, id, new Date("2026-10-26T10:00:00.000Z"));
    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-10-27T08:00:00.000Z") })).toMatchObject({ autoStarted: [id] });
  });

  it("should start it when its owner last used it exactly 14 days ago", async () => {
    const id = await stoppedAssistant(ALICE, "assistant", new Date("2026-10-12T08:00:00.000Z"));
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [id] });
  });

  it("should not count a pod report, an auto start or a laptop conversation as use when deciding to start it", async () => {
    const id = await stoppedAssistant(ALICE, "assistant", new Date("2026-10-01T10:00:00.000Z"));
    await prisma.virtualAgent.update({
      where: { id },
      data: { lastActiveAt: new Date("2026-10-25T10:00:00.000Z"), startedAt: new Date("2026-10-25T08:00:00.000Z") }
    });
    await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: null, lastActiveAt: new Date("2026-10-25T10:00:00.000Z") } });
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [] });
  });

  it("should start only the first virtual agent, and never one being deleted", async () => {
    const first = await stoppedAssistant(ALICE, "assistant");
    const second = await stoppedAssistant(ALICE, "second");
    await schedule(ALICE, "08:00");
    await prisma.virtualAgent.update({ where: { id: first }, data: { desired: "deleted" } });

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [second] });
    expect((await row(first)).desired).toBe("deleted");
  });

  it("should not stop what it started, as idle or for the evening, in the same pass", async () => {
    const id = await stoppedAssistant(ALICE);
    await prisma.virtualAgent.update({ where: { id }, data: { lastActiveAt: new Date("2026-10-23T10:00:00.000Z") } });
    await schedule(ALICE, "08:00");

    expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: MONDAY_0800 })).toMatchObject({ autoStarted: [id], idle: [], evening: [] });
    expect((await row(id)).desired).toBe("running");
  });

  describe("idle shutdown", () => {
    const NOW = new Date("2026-10-26T12:00:00.000Z");

    async function runningIdleFor(owner: Person, name: string, minutes: number, agentStatus = "running"): Promise<string> {
      const agent = await create(owner, name);
      const at = new Date(NOW.getTime() - minutes * 60_000);
      await prisma.virtualAgent.update({
        where: { id: agent.id },
        data: { status: agentStatus as "running", statusChangedAt: at, lastActiveAt: at, startedAt: at }
      });
      return agent.id;
    }

    it("should stop an agent at its owner's idle period rather than the deployment's when they chose one", async () => {
      const short = await runningIdleFor(ALICE, "short", 70);
      const long = await runningIdleFor(BOB, "long", 150);
      await schedule(ALICE, "none", "1h");
      await schedule(BOB, "none", "4h");

      const result = await sweepVirtualAgents(prisma, { ...OPTIONS, now: NOW });

      expect(result).toMatchObject({ idle: [short] });
      expect((await row(long)).desired).toBe("running");
    });

    it("should use the deployment's idle period when the owner chose none", async () => {
      const idle = await runningIdleFor(ALICE, "idle", 130);
      const fresh = await runningIdleFor(BOB, "fresh", 110);

      expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: NOW })).toMatchObject({ idle: [idle] });
      expect((await row(fresh)).desired).toBe("running");
    });

    it("should leave an agent to the other rules when its owner chose never and it started on a weekday before the stop", async () => {
      const running = await runningIdleFor(ALICE, "running", 600);
      const waiting = await runningIdleFor(ALICE, "waiting", 45, "awaiting_login");
      const failed = await runningIdleFor(ALICE, "failed", 130, "failed");
      await schedule(ALICE, "none", "never");

      const result = await sweepVirtualAgents(prisma, { ...OPTIONS, now: NOW });

      expect(result).toMatchObject({ idle: [], awaitingOwner: [waiting], afterFailure: [failed] });
      expect((await row(running)).desired).toBe("running");
    });

    it.each([
      ["at the weekend", "2026-10-24T10:00:00.000Z"],
      ["after the evening stop", "2026-10-25T20:00:00.000Z"]
    ])("should use the deployment's idle period when its owner chose never and it started %s", async (_when, startedAt) => {
      const id = await runningIdleFor(ALICE, "late", 130);
      await prisma.virtualAgent.update({ where: { id }, data: { startedAt: new Date(startedAt) } });
      await prisma.virtualAgent.update({ where: { id }, data: { statusChangedAt: new Date(NOW.getTime() - 130 * 60_000) } });
      await schedule(ALICE, "none", "never");

      expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: NOW })).toMatchObject({ idle: [id] });
    });

    it("should still stop an agent that never idles out at the evening stop", async () => {
      const id = await runningIdleFor(ALICE, "never", 600);
      await schedule(ALICE, "none", "never");

      expect(await sweepVirtualAgents(prisma, { ...OPTIONS, now: new Date("2026-10-26T19:00:00.000Z") })).toMatchObject({ evening: [id] });
    });
  });
});

describe("saveAssistantSchedule", () => {
  it("should store both choices and read them back when they are offered", async () => {
    await create(ALICE, "assistant");

    await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "08:30", idleAfter: "3h" });

    expect(await readAssistantSchedule(prisma, ALICE.oid)).toEqual({ autoStartTime: "08:30", idleAfter: "3h" });
    expect(await readAssistantSchedule(prisma, BOB.oid)).toEqual({ autoStartTime: null, idleAfter: null });
  });

  it("should clear the choices when the person saves none and the default", async () => {
    await create(ALICE, "assistant");
    await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "08:30", idleAfter: "never" });

    await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "none", idleAfter: "default" });

    expect(await readAssistantSchedule(prisma, ALICE.oid)).toEqual({ autoStartTime: null, idleAfter: null });
  });

  it("should refuse a time the evening stop leaves no room for, and read a stored one it no longer leaves room for as none", async () => {
    await create(ALICE, "assistant");
    await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "18:30", idleAfter: "default" });
    vi.stubEnv("VIRTUAL_AGENT_EVENING_STOP", "17:00");
    try {
      expect(await readAssistantSchedule(prisma, ALICE.oid)).toEqual({ autoStartTime: null, idleAfter: null });
      await expect(saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "17:00", idleAfter: "default" })).rejects.toMatchObject({ status: 400 });
      await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "16:30", idleAfter: "default" });
      expect(await readAssistantSchedule(prisma, ALICE.oid)).toEqual({ autoStartTime: "16:30", idleAfter: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should refuse a time that is no slot and keep what was stored", async () => {
    await create(ALICE, "assistant");
    await saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "08:30", idleAfter: "3h" });

    await expect(saveAssistantSchedule(prisma, ALICE.oid, { autoStart: "19:00", idleAfter: "1h" })).rejects.toMatchObject({ status: 400 });

    expect(await readAssistantSchedule(prisma, ALICE.oid)).toEqual({ autoStartTime: "08:30", idleAfter: "3h" });
  });
});
