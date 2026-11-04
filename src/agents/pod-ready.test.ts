import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../store/prisma.ts";

const { setDesired } = vi.hoisted(() => ({ setDesired: vi.fn() }));
vi.mock("../virtual-agents/store.ts", () => ({ setDesired }));

const { podReady } = await import("./pod-ready.ts");

const prisma = {} as PrismaClient;
const NOW = new Date("2026-11-04T09:00:00.000Z");

function pod(overrides: Partial<{ desired: string; status: string; generation: number; observedGeneration: number }> = {}, features: unknown = ["welsh"]) {
  return {
    assistant: { id: "va-1", desired: "running", status: "running", generation: 2, observedGeneration: 2, ...overrides },
    claims: { clientFeatures: features }
  };
}

beforeEach(() => {
  setDesired.mockReset();
});

describe("podReady", () => {
  it("should answer ok for a running pod that claims the feature and has every change applied", async () => {
    expect(await podReady(prisma, "oid", pod(), "welsh", NOW)).toBe("ok");
    expect(setDesired).not.toHaveBeenCalled();
  });

  it("should start a stopped assistant as the actor and answer waking", async () => {
    expect(await podReady(prisma, "oid", pod({ desired: "stopped", status: "stopped" }), "welsh", NOW)).toBe("waking");
    expect(setDesired).toHaveBeenCalledWith(prisma, "oid", "va-1", "running", NOW);
  });

  it("should answer waking for a pod still booting, and unsupported for one whose client lacks the feature", async () => {
    expect(await podReady(prisma, "oid", pod({ status: "provisioning" }), "welsh", NOW)).toBe("waking");
    expect(await podReady(prisma, "oid", pod({}, ["lookups"]), "welsh", NOW)).toBe("unsupported");
    expect(setDesired).not.toHaveBeenCalled();
  });

  it("should answer waking when a change is not yet applied, since the pod running is about to be replaced", async () => {
    expect(await podReady(prisma, "oid", pod({ generation: 3 }, ["deck-build"]), "deck-build", NOW)).toBe("waking");
  });
});
