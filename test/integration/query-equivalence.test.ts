import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { channelFeed, type Match } from "../../src/messages/feed.ts";
import { listTopics, mostActiveTopics, type TopicSummary } from "../../src/topics/store.ts";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * The topic and channel reads are written to walk indexes and stop early. These compare them with the plain
 * aggregate over every row, which is obviously right and does not scale, on one board built to hit the edges: posts
 * on up to six topics, topics never posted on, a topic whose posts were all deleted, tied activity times, directs
 * between posts, and creation times that do not follow id order.
 */

const WRITER = person("writer");
const POSTS = 600;

async function seed(): Promise<void> {
  await resetDatabase();
  await insertUser(WRITER);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO topic (slug, last_message_at)
      SELECT slug, now() - (ordinality || ' minutes')::interval
      FROM unnest(ARRAY['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'emptied']) WITH ORDINALITY AS listed (slug, ordinality)
    `;
    await tx.$executeRaw`INSERT INTO topic (slug) VALUES ('quiet'), ('quiet-too'), ('a-quiet')`;
    await tx.$executeRaw`
      INSERT INTO message (id, kind, author_oid, body, created_at)
      SELECT g, CASE WHEN g % 13 = 0 THEN 'direct'::message_kind ELSE 'post'::message_kind END, ${WRITER.oid}, 'b',
             now() - make_interval(hours => (g * 37) % (14 * 24))
      FROM generate_series(1, ${POSTS}::int) AS g
    `;
    await tx.$executeRaw`
      INSERT INTO message_topic (message_id, topic_id)
      SELECT m.id, t.id
      FROM message m
      CROSS JOIN LATERAL (
        VALUES ('a', m.id % 2 = 0), ('b', m.id % 3 = 0), ('c', m.id % 5 = 0), ('d', m.id % 7 = 0), ('e', m.id % 11 = 0),
               ('h', m.id % 97 = 0), ('g', m.id % 4 = 1),
               ('f', m.id % 2 <> 0 AND m.id % 3 <> 0 AND m.id % 5 <> 0 AND m.id % 7 <> 0 AND m.id % 11 <> 0 AND m.id % 4 <> 1)
      ) AS rule (slug, applies)
      JOIN topic t ON t.slug = rule.slug
      WHERE m.kind = 'post' AND rule.applies
    `;
    await tx.$executeRaw`SELECT setval('message_id_seq', ${POSTS}::int)`;
  });
  // Ties on last activity, for the slug tie-break; and a topic whose only posts are gone, which keeps its time.
  await prisma.$executeRaw`UPDATE topic SET last_message_at = (SELECT last_message_at FROM topic WHERE slug = 'a') WHERE slug IN ('b', 'd')`;
  const emptied = await prisma.$queryRaw<{ id: bigint }[]>`
    WITH m AS (INSERT INTO message (kind, author_oid, body) VALUES ('post', ${WRITER.oid}, 'gone') RETURNING id)
    INSERT INTO message_topic (message_id, topic_id) SELECT m.id, t.id FROM m, topic t WHERE t.slug = 'emptied' RETURNING message_id AS id
  `;
  await prisma.message.delete({ where: { id: emptied[0]!.id } });
  await prisma.$executeRaw`
    WITH
      t AS (INSERT INTO topic (slug, last_message_at) VALUES ('stale', now() - interval '30 days') RETURNING id),
      m AS (INSERT INTO message (kind, author_oid, body, created_at) VALUES ('post', ${WRITER.oid}, 'old', now() - interval '30 days') RETURNING id)
    INSERT INTO message_topic (message_id, topic_id) SELECT m.id, t.id FROM m, t
  `;
}

type Row = { slug: string; message_count: bigint; last_message_at: Date | null };

function summaries(rows: Row[]): TopicSummary[] {
  return rows.map((row) => ({ slug: row.slug, message_count: Number(row.message_count), last_message_at: row.last_message_at?.toISOString() ?? null }));
}

async function allTopicsCounted(prefix: string, limit: number): Promise<TopicSummary[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return summaries(
    await prisma.$queryRaw<Row[]>`
      SELECT t.slug, count(mt.message_id) AS message_count, t.last_message_at
      FROM topic t
      LEFT JOIN message_topic mt ON mt.topic_id = t.id
      WHERE t.slug LIKE ${pattern}
      GROUP BY t.id
      ORDER BY t.last_message_at DESC NULLS LAST, t.slug
      LIMIT ${limit}
    `
  );
}

async function everyPostJoined(limit: number): Promise<TopicSummary[]> {
  return summaries(
    await prisma.$queryRaw<Row[]>`
      SELECT t.slug, count(*) AS message_count, t.last_message_at
      FROM topic t
      JOIN message_topic mt ON mt.topic_id = t.id
      JOIN message m ON m.id = mt.message_id
      WHERE m.kind = 'post' AND m.created_at > now() - make_interval(days => 7)
      GROUP BY t.id
      ORDER BY count(*) DESC, t.last_message_at DESC NULLS LAST, t.slug
      LIMIT ${limit}
    `
  );
}

async function everyPostGrouped(topics: string[], match: Match, before: bigint | undefined, limit: number): Promise<string[]> {
  const unique = [...new Set(topics)];
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT mt.message_id AS id
    FROM topic t
    JOIN message_topic mt ON mt.topic_id = t.id AND mt.message_id < ${before ?? BigInt("9223372036854775807")}
    WHERE t.slug = ANY(${unique}::text[])
    GROUP BY mt.message_id
    HAVING count(*) >= ${match === "all" ? unique.length : 1}
    ORDER BY mt.message_id DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id.toString()).sort((left, right) => Number(BigInt(left) - BigInt(right)));
}

async function channelIds(topics: string[], match: Match, before: bigint | undefined, limit: number): Promise<string[]> {
  return (await channelFeed(prisma, { topics, match, limit, ...(before === undefined ? {} : { before }) })).map((message) => message.id);
}

const TOPIC_SETS: string[][] = [
  ["a"],
  ["h"],
  ["a", "b"],
  ["b", "c", "d"],
  ["a", "h"],
  ["e", "h"],
  ["d", "e", "h"],
  ["a", "b", "c", "d", "e"],
  ["a", "quiet"],
  ["a", "missing"],
  ["a", "a", "b"],
  ["quiet"],
  ["missing"],
  ["f", "a"]
];
const BEFORES: (bigint | undefined)[] = [undefined, 601n, 600n, 462n, 231n, 97n, 2n, 1n, 0n];
const MATCHES: Match[] = ["any", "all"];

beforeAll(seed);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("listTopics", () => {
  it.each([
    ["", 50],
    ["", 1],
    ["", 4],
    ["", 9],
    ["a", 50],
    ["a", 1],
    ["q", 50],
    ["quiet", 1],
    ["e", 50],
    ["zz", 50],
    ["%", 50],
    ["_", 50]
  ])("should list what counting every topic's posts listed when the prefix is %j and the limit %i", async (prefix, limit) => {
    expect(await listTopics(prisma, prefix, limit)).toEqual(await allTopicsCounted(prefix, limit));
  });

  it("should break ties on last activity by slug, count an emptied topic as zero and put never-posted topics last when listing all", async () => {
    const listed = (await listTopics(prisma, "", 50)).map((topic) => [topic.slug, topic.message_count, topic.last_message_at === null]);

    expect(listed.slice(0, 3).map(([slug]) => slug)).toEqual(["a", "b", "d"]);
    expect(listed).toContainEqual(["emptied", 0, false]);
    expect(listed.slice(-3)).toEqual([
      ["a-quiet", 0, true],
      ["quiet", 0, true],
      ["quiet-too", 0, true]
    ]);
  });
});

describe("mostActiveTopics", () => {
  it.each([1, 3, 8, 50])("should rank what joining every post ranked when the limit is %i", async (limit) => {
    expect(await mostActiveTopics(prisma, limit)).toEqual(await everyPostJoined(limit));
  });

  it("should leave out a topic when all its posts are older than the window", async () => {
    expect((await mostActiveTopics(prisma, 50)).map((topic) => topic.slug)).not.toContain("stale");
    expect((await listTopics(prisma, "stale", 1))[0]?.message_count).toBe(1);
  });
});

describe("channelFeed", () => {
  it.each(
    TOPIC_SETS.flatMap((topics) => MATCHES.flatMap((match) => BEFORES.flatMap((before) => [1, 7, 31].map((limit) => [topics, match, before, limit] as const))))
  )("should return what grouping every post returned for %j matching %s before %s with limit %i", async (topics, match, before, limit) => {
    expect(await channelIds([...topics], match, before, limit)).toEqual(await everyPostGrouped([...topics], match, before, limit));
  });

  it.each(
    TOPIC_SETS.flatMap((topics) => MATCHES.map((match) => [topics, match] as const))
  )("should page through every post exactly once when %j matching %s is read with before cursors", async (topics, match) => {
    const seen: string[] = [];
    let before: bigint | undefined;
    for (;;) {
      const page = await channelIds([...topics], match, before, 9);
      if (page.length === 0) {
        break;
      }
      seen.unshift(...page);
      before = BigInt(page[0]!);
    }

    expect(seen).toEqual(await everyPostGrouped([...topics], match, undefined, 10_000));
  });
});
