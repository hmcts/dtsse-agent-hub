import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPost } from "../../src/messages/store.ts";
import { subscribe } from "../../src/topics/store.ts";
import { insertAgent, insertUser, person, prisma, resetDatabase } from "./database.ts";

const ALICE = person("alice");
const TOPICS = ["pcs-api", "ccd", "a-b", "ab", "z", "pcs", "0", "m", "b", "a"];
// Below the pool's 10 connections, so every failure is a lock conflict rather than a checkout timeout.
const WAVE_SIZE = 8;
const WAVES = 10;

/** Runs `WAVES` rounds of `WAVE_SIZE` concurrent calls, every other call naming the topics in reverse, and collects what failed. */
async function crossed(write: (topics: string[], index: number) => Promise<unknown>): Promise<unknown[]> {
  const failed: unknown[] = [];
  for (let wave = 0; wave < WAVES; wave++) {
    const results = await Promise.allSettled(
      Array.from({ length: WAVE_SIZE }, (_, slot) => write(slot % 2 === 0 ? [...TOPICS] : [...TOPICS].reverse(), wave * WAVE_SIZE + slot))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        failed.push(result.reason);
      }
    }
  }
  return failed;
}

function post(topics: string[]) {
  return createPost(prisma, { author: { oid: ALICE.oid, agentId: null }, topics, title: null, body: "x", inReplyTo: null });
}

beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("topic row locking", () => {
  it("should commit every post when concurrent posts name existing topics in opposite orders", async () => {
    await post(TOPICS);

    expect(await crossed(post)).toEqual([]);
    expect(await prisma.message.count()).toBe(WAVES * WAVE_SIZE + 1);
  });

  it("should commit every post when concurrent posts create the same topics in opposite orders", async () => {
    expect(await crossed(post)).toEqual([]);
    expect(await prisma.topic.count()).toBe(TOPICS.length);
  });

  it("should apply every subscription when subscribes race posts creating the same topics in opposite orders", async () => {
    const agents = await Promise.all(Array.from({ length: WAVES * WAVE_SIZE }, (_, index) => insertAgent(ALICE, `agent-${index}`)));

    const failed = await crossed((topics, index) => (index % 4 < 2 ? post(topics) : subscribe(prisma, agents[index]!, topics)));

    expect(failed).toEqual([]);
    expect(await prisma.subscription.count()).toBe(((WAVES * WAVE_SIZE) / 2) * TOPICS.length);
  });

  it("should return a post's topics in code-point order when it names them in another", async () => {
    const message = await post(["pcs-api", "ab", "a-b", "pcs"]);

    expect(message.topics).toEqual(["a-b", "ab", "pcs", "pcs-api"]);
  });
});
