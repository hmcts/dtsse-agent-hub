// Whether the sidebar offers the morning briefing, read from the pod's client-features claim as opening the Assistant
// reads it: the pod's own claim, and its main-session agent's once a stop has cleared that.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureAssistantWithClaims } from "../../src/assistant/assistant-store.ts";
import { offersBriefing } from "../../src/assistant/briefing.ts";
import type { CredentialKind } from "../../src/credentials/names.ts";
import { setDesired } from "../../src/virtual-agents/store.ts";
import { ALICE, podFixture, viewer } from "./assistant-pod.ts";
import { prisma, resetDatabase } from "./database.ts";

const claimingBriefing = podFixture(["morning-briefing"]);
const CONNECTED = new Set<CredentialKind>(["microsoft"]);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Whether opening the Assistant offers the briefing, which starts a stopped pod as it reads the claims. */
async function offered(): Promise<boolean> {
  return offersBriefing(CONNECTED, (await ensureAssistantWithClaims(prisma, viewer(ALICE))).claims);
}

async function pod(id: string): Promise<{ desired: string; clientFeatures: unknown }> {
  return await prisma.virtualAgent.findUniqueOrThrow({ where: { id }, select: { desired: true, clientFeatures: true } });
}

async function claimOwn(id: string, features: string[]): Promise<void> {
  await prisma.virtualAgent.update({ where: { id }, data: { clientFeatures: features } });
}

describe("morning briefing offer", () => {
  it("should offer the briefing when only the pod's main session has registered and claims it", async () => {
    await claimingBriefing(ALICE);

    expect(await offered()).toBe(true);
  });

  it("should follow the pod's own claim over its main session's while it is running", async () => {
    const id = await claimingBriefing(ALICE);
    await claimOwn(id, ["files"]);

    expect(await offered()).toBe(false);
  });

  it("should offer the briefing on the main session's claim when a stop has cleared the pod's own claim that left it out", async () => {
    const id = await claimingBriefing(ALICE);
    await claimOwn(id, ["files"]);
    expect(await offered()).toBe(false);

    await setDesired(prisma, ALICE.oid, id, "stopped");
    expect(await pod(id)).toEqual({ desired: "stopped", clientFeatures: null });

    expect(await offered()).toBe(true);
    expect(await pod(id)).toEqual({ desired: "running", clientFeatures: null });
  });

  it("should stop offering the briefing when a stop has cleared the pod's own claim and its main session never claimed it", async () => {
    const id = await claimingBriefing(ALICE, ["files"]);
    await claimOwn(id, ["files", "morning-briefing"]);
    expect(await offered()).toBe(true);

    await setDesired(prisma, ALICE.oid, id, "stopped");

    expect(await offered()).toBe(false);
    expect(await pod(id)).toEqual({ desired: "running", clientFeatures: null });
  });

  it("should not offer the briefing when the pod's main session claims other features but not the briefing", async () => {
    await claimingBriefing(ALICE, ["files", "welsh"]);

    expect(await offered()).toBe(false);
  });

  it("should not offer the briefing when no session of the pod has registered yet", async () => {
    await claimingBriefing(ALICE, ["morning-briefing"], "running", { session: false });

    expect(await offered()).toBe(false);
  });
});
