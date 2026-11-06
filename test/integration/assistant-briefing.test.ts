// Whether the sidebar offers the morning briefing, read from the pod's client-features claim as it is stored: the
// pod's own claim, and its main-session agent's once a stop or start has cleared that.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assistantClaims, ensureAssistant } from "../../src/assistant/assistant-store.ts";
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

async function offered(id: string): Promise<boolean> {
  return offersBriefing(CONNECTED, await assistantClaims(prisma, id));
}

describe("morning briefing offer", () => {
  it("should offer the briefing when only the pod's main session has registered and claims it", async () => {
    const id = await claimingBriefing(ALICE);

    expect(await offered(id)).toBe(true);
  });

  it("should follow the pod's own claim when it has reported one", async () => {
    const id = await claimingBriefing(ALICE);
    await prisma.virtualAgent.update({ where: { id }, data: { clientFeatures: ["files"] } });

    expect(await offered(id)).toBe(false);
  });

  it("should still offer the briefing when the pod has been stopped and opening the Assistant starts it again", async () => {
    const id = await claimingBriefing(ALICE);
    await prisma.virtualAgent.update({ where: { id }, data: { clientFeatures: ["morning-briefing"] } });
    await setDesired(prisma, ALICE.oid, id, "stopped");
    await ensureAssistant(prisma, viewer(ALICE));

    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id }, select: { clientFeatures: true } })).clientFeatures).toBeNull();
    expect(await offered(id)).toBe(true);
  });

  it("should not offer the briefing when the pod's client predates the claim", async () => {
    const id = await claimingBriefing(ALICE, null);

    expect(await offered(id)).toBe(false);
  });

  it("should not offer the briefing when no session of the pod has registered yet", async () => {
    const id = await claimingBriefing(ALICE, ["morning-briefing"], "running", { session: false });

    expect(await offered(id)).toBe(false);
  });
});
