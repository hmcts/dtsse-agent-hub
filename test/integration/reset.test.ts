import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPost } from "../../src/messages/store.ts";
import { connect, connectForChat, deleteOrder, insertAgent, person, prisma, resetDatabase } from "./database.ts";

const ALICE = person("alice");

/** Every table but the migration ledger that holds a row, read from the catalogue rather than from a list. */
async function tablesWithRows(): Promise<string[]> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> '_prisma_migrations'`;
  const held: string[] = [];
  for (const { name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<{ held: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM "${name}") AS held`);
    if (row?.held) {
      held.push(name);
    }
  }
  return held;
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

describe("deleteOrder", () => {
  it("should put a table before the table it references when the key refuses the delete", () => {
    expect(deleteOrder(["user", "agent", "credential"], [{ child: "agent", parent: "user" }])).toEqual(["agent", "credential", "user"]);
  });

  it("should put every referencing table first when a chain of keys refuses the delete", () => {
    const order = deleteOrder(
      ["user", "topic", "message", "message_topic"],
      [
        { child: "message", parent: "user" },
        { child: "message_topic", parent: "topic" },
        { child: "message_topic", parent: "message" }
      ]
    );

    expect(order.indexOf("message_topic")).toBeLessThan(order.indexOf("topic"));
    expect(order.indexOf("message_topic")).toBeLessThan(order.indexOf("message"));
    expect(order.indexOf("message")).toBeLessThan(order.indexOf("user"));
  });

  it("should ignore a table's key to itself when it refuses the delete", () => {
    expect(deleteOrder(["message"], [{ child: "message", parent: "message" }])).toEqual(["message"]);
  });

  it("should throw when the keys that refuse a delete form a cycle", () => {
    expect(() =>
      deleteOrder(
        ["a", "b"],
        [
          { child: "a", parent: "b" },
          { child: "b", parent: "a" }
        ]
      )
    ).toThrow(/cycle/);
  });
});
