import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../store/prisma.ts";
import { restartsOnRemoval } from "./held-credentials.ts";

const deleteCredential = vi.hoisted(() => vi.fn());
const restartVirtualAgent = vi.hoisted(() => vi.fn());

vi.mock("../credentials/store.ts", () => ({ deleteCredential }));
vi.mock("./store.ts", () => ({ restartVirtualAgent }));

const { removeCredential } = await import("./credential-removal.ts");

const STORE = {} as never;
const OWNER = "an-oid";
const POD_UP = { in: ["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running"] };

function database(stored: number, up: string[]) {
  const findMany = vi.fn().mockResolvedValue(up.map((id) => ({ id })));
  const prisma = { credential: { count: vi.fn().mockResolvedValue(stored) }, virtualAgent: { findMany } } as unknown as PrismaClient;
  return { prisma, findMany };
}

beforeEach(() => {
  deleteCredential.mockReset().mockResolvedValue(undefined);
  restartVirtualAgent.mockReset().mockResolvedValue({});
});

describe("removeCredential", () => {
  it("should restart every agent with a pod up when a sign-in each holds is removed", async () => {
    const { prisma, findMany } = database(1, ["a", "b"]);

    await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "github" });

    expect(deleteCredential).toHaveBeenCalledWith(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "github" });
    expect(findMany.mock.calls[0]?.[0].where).toEqual({ ownerOid: OWNER, desired: "running", status: POD_UP });
    expect(restartVirtualAgent.mock.calls.map((call) => call[2])).toEqual(["a", "b"]);
  });

  it("should restart only agents on their own licence when a Claude token is removed", async () => {
    const { prisma, findMany } = database(1, ["a"]);

    await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "claude" });

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ ownerOid: OWNER, desired: "running", status: POD_UP, modelRoute: "own_licence" });
  });

  it.each([
    ["nothing was stored", 0, "github"],
    ["no pod holds the kind", 1, "microsoft"]
  ] as const)("should restart nothing when %s", async (_when, stored, kind) => {
    const { prisma } = database(stored, ["a"]);

    await removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind });

    expect(deleteCredential).toHaveBeenCalled();
    expect(restartVirtualAgent).not.toHaveBeenCalled();
  });

  it("should fail with the restart's error when an agent cannot be restarted, the sign-in already removed", async () => {
    const { prisma } = database(1, ["a"]);
    restartVirtualAgent.mockRejectedValueOnce(new Error("down"));

    await expect(removeCredential(prisma, STORE, { actorOid: OWNER, ownerOid: OWNER, kind: "jenkins" })).rejects.toThrow("down");

    expect(deleteCredential).toHaveBeenCalled();
  });
});

describe("restartsOnRemoval", () => {
  it.each([
    ["github", "gateway", true],
    ["claude", "own-licence", true],
    ["claude", "gateway", false],
    ["microsoft", "own-licence", false]
  ] as const)("should say whether removing %s restarts an agent on the %s route", (kind, route, expected) => {
    expect(restartsOnRemoval(kind, route)).toBe(expected);
  });
});
