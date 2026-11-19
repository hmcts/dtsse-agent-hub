import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import type { PrismaClient } from "../store/prisma.ts";

const deleteCredential = vi.hoisted(() => vi.fn());
const restartVirtualAgent = vi.hoisted(() => vi.fn());

vi.mock("../credentials/store.ts", () => ({ deleteCredential }));
vi.mock("./store.ts", () => ({ restartVirtualAgent }));

const { removeCredential } = await import("./credential-removal.ts");

const STORE = {} as never;
const OWNER = "an-oid";

function database(stored: number, running: string[]) {
  const findMany = vi.fn().mockResolvedValue(running.map((id) => ({ id })));
  const prisma = { credential: { count: vi.fn().mockResolvedValue(stored) }, virtualAgent: { findMany } } as unknown as PrismaClient;
  return { prisma, findMany };
}

beforeEach(() => {
  deleteCredential.mockReset().mockResolvedValue(undefined);
  restartVirtualAgent.mockReset().mockResolvedValue({});
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("removeCredential", () => {
  it("should restart every running agent when a sign-in each holds is removed", async () => {
    const { prisma, findMany } = database(1, ["a", "b"]);

    expect(await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "github" })).toEqual({ notRestarted: 0 });

    expect(deleteCredential).toHaveBeenCalledWith(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "github" });
    expect(findMany.mock.calls[0]?.[0].where).toEqual({ ownerOid: OWNER, desired: "running" });
    expect(restartVirtualAgent.mock.calls.map((call) => call[2])).toEqual(["a", "b"]);
  });

  it("should restart only agents on their own licence when a Claude token is removed", async () => {
    const { prisma, findMany } = database(1, ["a"]);

    await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "claude" });

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ ownerOid: OWNER, desired: "running", modelRoute: "own_licence" });
  });

  it.each([
    ["nothing was stored", 0, "github"],
    ["no pod holds the kind", 1, "microsoft"]
  ] as const)("should restart nothing when %s", async (_when, stored, kind) => {
    const { prisma } = database(stored, ["a"]);

    expect(await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind })).toEqual({ notRestarted: 0 });

    expect(deleteCredential).toHaveBeenCalled();
    expect(restartVirtualAgent).not.toHaveBeenCalled();
  });

  it("should count an agent it could not restart and still restart the rest when one restart fails", async () => {
    const { prisma } = database(1, ["a", "b"]);
    restartVirtualAgent.mockRejectedValueOnce(new HttpError(404, "no such virtual agent")).mockRejectedValueOnce("down");

    expect(await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "jenkins" })).toEqual({ notRestarted: 2 });

    expect(restartVirtualAgent).toHaveBeenCalledTimes(2);
  });
});
