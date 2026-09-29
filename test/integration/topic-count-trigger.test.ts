import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, insertUser, person, prisma, resetDatabase } from "./database.ts";

const AUTHOR = person("alice");
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  await insertUser(AUTHOR);
  await client.query(`INSERT INTO topic (slug) SELECT 't' || n FROM generate_series(1, 6) n`);
});

afterEach(async () => {
  await client.query("ROLLBACK").catch(() => undefined);
});

/** Inserts a message and `topics` of its topics in one transaction, and commits. */
async function write(kind: "post" | "direct", topics: number): Promise<void> {
  await client.query("BEGIN");
  const { rows } = await client.query<{ id: string }>(`INSERT INTO message (kind, author_oid, body) VALUES ($1, $2, 'body') RETURNING id`, [kind, AUTHOR.oid]);
  const id = rows[0]!.id;
  if (topics > 0) {
    await client.query(`INSERT INTO message_topic (message_id, topic_id) SELECT $1, id FROM topic ORDER BY id LIMIT $2`, [id, topics]);
  }
  await client.query("COMMIT");
}

describe("the topic-count constraint trigger", () => {
  it.each([1, 5])("should accept a post with %i topics inserted in the same transaction", async (count) => {
    await expect(write("post", count)).resolves.toBeUndefined();
  });

  it.each([0, 6])("should refuse a post with %i topics at commit", async (count) => {
    await expect(write("post", count)).rejects.toThrow(/a post needs between 1 and 5/);
    expect((await client.query("SELECT 1 FROM message")).rowCount).toBe(0);
  });

  it("should accept a direct message with no topics", async () => {
    await expect(write("direct", 0)).resolves.toBeUndefined();
  });

  it("should refuse a direct message with a topic", async () => {
    await expect(write("direct", 1)).rejects.toThrow(/a direct message has none/);
  });

  it("should refuse removing a post's last topic", async () => {
    await write("post", 1);

    await expect(client.query("DELETE FROM message_topic")).rejects.toThrow(/has 0 topics/);
  });

  it("should refuse adding a sixth topic to an existing post", async () => {
    await write("post", 5);

    await expect(
      client.query(`INSERT INTO message_topic (message_id, topic_id) SELECT m.id, t.id FROM message m, topic t WHERE t.slug = 't6'`)
    ).rejects.toThrow(/has 6 topics/);
  });

  it("should refuse turning a direct message into a post with no topics", async () => {
    await write("direct", 0);

    await expect(client.query(`UPDATE message SET kind = 'post'`)).rejects.toThrow(/has 0 topics/);
  });

  it("should allow deleting a post, whose topics go with it", async () => {
    await write("post", 3);

    await expect(client.query("DELETE FROM message")).resolves.toBeDefined();
    expect((await client.query("SELECT 1 FROM message_topic")).rowCount).toBe(0);
  });

  it("should refuse a slug the API would also refuse", async () => {
    await expect(client.query(`INSERT INTO topic (slug) VALUES ('Not A Slug')`)).rejects.toThrow(/topic_slug_format/);
  });
});
