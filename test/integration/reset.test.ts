import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPost } from "../../src/messages/store.ts";
import { connect, connectForChat, insertAgent, person, prisma, quoted, resetDatabase, resetStatement, schemaTables } from "./database.ts";

const ALICE = person("alice");

/** Every table but the migration ledger that holds a row. */
async function tablesWithRows(): Promise<string[]> {
  const held: string[] = [];
  for (const name of await schemaTables()) {
    const [row] = await prisma.$queryRawUnsafe<{ held: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM ${quoted(name)}) AS held`);
    if (row?.held) {
      held.push(name);
    }
  }
  return held;
}

/**
 * Adds tables or sequences of the test's own for one reset built while they exist, and drops them afterwards. The
 * reset `resetDatabase` caches was built before they existed, so the other tests in this file never see them.
 */
async function withProbe(create: readonly string[], drop: readonly string[], run: (reset: () => Promise<void>) => Promise<void>): Promise<void> {
  try {
    for (const statement of create) {
      await prisma.$executeRawUnsafe(statement);
    }
    await run(async () => {
      await prisma.$executeRawUnsafe(await resetStatement());
    });
  } finally {
    for (const statement of drop) {
      await prisma.$executeRawUnsafe(statement);
    }
  }
}

async function seed(): Promise<{ topicId: number; messageId: string }> {
  const agentId = await insertAgent(ALICE, "alice-agent");
  await connectForChat(ALICE);
  const posted = await createPost(prisma, { author: { oid: ALICE.oid, agentId }, topics: ["reset"], title: null, body: "x", inReplyTo: null });
  const topic = await prisma.topic.findUniqueOrThrow({ where: { slug: "reset" }, select: { id: true } });
  return { topicId: topic.id, messageId: posted.id };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("resetDatabase", () => {
  it("should leave every table empty when a test wrote to several of them", async () => {
    await seed();
    expect(await tablesWithRows()).not.toEqual([]);

    await resetDatabase();

    expect(await tablesWithRows()).toEqual([]);
  });

  it("should restart every sequence when earlier tests took ids from them", async () => {
    await seed();
    await seed();
    await resetDatabase();

    const { topicId, messageId } = await seed();

    expect(topicId).toBe(1);
    expect(messageId).toBe("1");
  });

  it("should wait for a transaction a previous test left open and remove what it wrote when that commits", async () => {
    const straggler = await connect();
    try {
      await straggler.query("BEGIN");
      await straggler.query(`INSERT INTO "user" (oid, tid, name, email) VALUES ('dev-late', 'dev', 'Late Tester', 'late@example.com')`);
      const reset = resetDatabase();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await straggler.query("COMMIT");
      await reset;
    } finally {
      await straggler.end();
    }

    expect(await tablesWithRows()).toEqual([]);
  });
});

describe("resetDatabase's order", () => {
  // `reset_probe_a` sorts first, so a delete in name order empties it first and its cascade reaches `reset_probe_b`,
  // whose row `reset_probe_c` refuses to lose.
  it("should empty every table when a cascade would empty a parent before a table that refuses the delete", async () => {
    await withProbe(
      [
        "CREATE TABLE reset_probe_a (id int PRIMARY KEY)",
        "CREATE TABLE reset_probe_b (id int PRIMARY KEY, a_id int NOT NULL REFERENCES reset_probe_a ON DELETE CASCADE)",
        "CREATE TABLE reset_probe_c (id int PRIMARY KEY, b_id int NOT NULL REFERENCES reset_probe_b ON DELETE RESTRICT)",
        "INSERT INTO reset_probe_a VALUES (1)",
        "INSERT INTO reset_probe_b VALUES (1, 1)",
        "INSERT INTO reset_probe_c VALUES (1, 1)"
      ],
      ["DROP TABLE IF EXISTS reset_probe_c, reset_probe_b, reset_probe_a"],
      async (reset) => {
        await reset();

        expect(await tablesWithRows()).toEqual([]);
      }
    );
  });

  it("should empty every table when two tables refuse to lose rows the other references", async () => {
    await withProbe(
      [
        "CREATE TABLE reset_probe_a (id int PRIMARY KEY, b_id int)",
        "CREATE TABLE reset_probe_b (id int PRIMARY KEY, a_id int REFERENCES reset_probe_a)",
        "ALTER TABLE reset_probe_a ADD FOREIGN KEY (b_id) REFERENCES reset_probe_b",
        "INSERT INTO reset_probe_a VALUES (1, NULL)",
        "INSERT INTO reset_probe_b VALUES (1, 1)",
        "UPDATE reset_probe_a SET b_id = 1"
      ],
      ["DROP TABLE IF EXISTS reset_probe_a, reset_probe_b CASCADE"],
      async (reset) => {
        await reset();

        expect(await tablesWithRows()).toEqual([]);
      }
    );
  });

  it("should restart a sequence at its own start value when that is not 1", async () => {
    await withProbe(
      ["CREATE SEQUENCE reset_probe_seq START 100", "SELECT nextval('reset_probe_seq')"],
      ["DROP SEQUENCE IF EXISTS reset_probe_seq"],
      async (reset) => {
        await prisma.$queryRawUnsafe("SELECT nextval('reset_probe_seq')");
        await reset();

        expect(await prisma.$queryRawUnsafe("SELECT nextval('reset_probe_seq') AS next")).toEqual([{ next: 100n }]);
      }
    );
  });
});
