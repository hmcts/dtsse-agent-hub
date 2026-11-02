import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * The enum rebuilds in `20261120090000_credential_kind_rebuilt` and `20261121090000_virtual_agent_enums_rebuilt` are
 * safe beside a build still serving only because nothing it runs is a named prepared statement: a named one keeps a
 * plan, and a plan made against the old type fails with `cached plan must not change result type` once the type is
 * rebuilt. A `statementNameGenerator` in src/store/prisma.ts, or an adapter release that names statements itself,
 * fails this test.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the queries Prisma sends", () => {
  it("should leave every statement unnamed when it runs model queries on an enum column and a raw query", async () => {
    await resetDatabase();
    const ALICE = person("alice");
    await insertUser(ALICE);
    const sent = vi.spyOn(pg.Client.prototype, "query");

    await prisma.credential.findMany({ where: { ownerOid: ALICE.oid, kind: "github" } });
    await prisma.virtualAgent.findMany({ where: { ownerOid: ALICE.oid, modelRoute: "gateway" } });
    await prisma.$queryRaw`SELECT 1`;

    const configs = sent.mock.calls.map(([config]) => config).filter((config) => typeof config === "object" && config !== null);
    expect(configs.length).toBeGreaterThanOrEqual(3);
    for (const config of configs) {
      expect((config as { name?: unknown }).name).toBeUndefined();
    }
  });
});
