import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGrant } from "../../src/access/load.ts";
import { POST as direct } from "../../src/app/api/agent/[agentId]/direct/route.ts";
import { GET as agentStream } from "../../src/app/api/agent/[agentId]/stream/route.ts";
import { GET as uiStream } from "../../src/app/api/ui/stream/route.ts";
import { createPost } from "../../src/messages/store.ts";
import { createEventHub } from "../../src/realtime/hub.ts";
import { type Listener, startListener } from "../../src/realtime/listener.ts";
import { type Realtime, realtime } from "../../src/realtime/process.ts";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";
import { frames } from "./sse-reader.ts";

/**
 * Streams opened before the pod's `LISTEN` is active. Unlike the other suites, nothing here waits for
 * `listener.ready()` first: the point is that the streams do.
 */

const ALICE = person("alice");
const BOB = person("bob");

const globalForRealtime = globalThis as unknown as { agentHubRealtime?: Realtime };

/** Holds `LISTEN` back until `listen()` is called, so a message can be committed while nothing is listening. */
function gatedRealtime() {
  const hub = createEventHub();
  let real: Listener | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listener: Listener = {
    ready: async () => {
      await gate;
      await real?.ready();
    },
    connected: () => real?.connected() ?? false,
    stop: async () => {
      await real?.stop();
    }
  };
  globalForRealtime.agentHubRealtime = { hub, listener };
  return {
    listen: () => {
      real = startListener({ connectionString: resolveDatabaseUrl(), hub });
      release();
    }
  };
}

const open: { abort: AbortController; reader: ReturnType<typeof frames> }[] = [];

async function openAgentStream(as: Person, agentId: string) {
  const abort = new AbortController();
  const response = await call(agentStream, { as, path: `/api/agent/${agentId}/stream`, params: { agentId }, signal: abort.signal });
  const reader = frames(response);
  open.push({ abort, reader });
  return reader;
}

async function openUiStream(persona: string, query: string) {
  const abort = new AbortController();
  const response = await uiStream(
    new NextRequest(`http://localhost:3000/api/ui/stream?${query}`, { headers: { cookie: `ah_dev_persona=${persona}` }, signal: abort.signal })
  );
  expect(response.status).toBe(200);
  const reader = frames(response);
  open.push({ abort, reader });
  return reader;
}

async function sendDirect(from: string, to: string, body: string): Promise<string> {
  const response = await call(direct, {
    as: ALICE,
    path: `/api/agent/${from}/direct`,
    method: "POST",
    params: { agentId: from },
    body: { to_agent: to, body }
  });
  expect(response.status).toBe(201);
  return (await jsonOf(response)).message.id;
}

let alicesAgent: string;
let bobsAgent: string;

beforeEach(async () => {
  await resetDatabase();
  alicesAgent = await insertAgent(ALICE, "alice-pcs-api");
  bobsAgent = await insertAgent(BOB, "bob-ccd");
  await setGrant(prisma, BOB.oid, ALICE.oid, "write");
});

afterEach(async () => {
  for (const { abort, reader } of open.splice(0)) {
    abort.abort();
    await reader.cancel();
  }
  await globalForRealtime.agentHubRealtime?.listener.stop();
  delete globalForRealtime.agentHubRealtime;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a stream opened before LISTEN is active", () => {
  it("should deliver a direct message sent the moment the pod's first stream opens", async () => {
    expect(globalForRealtime.agentHubRealtime).toBeUndefined();
    const reader = await openAgentStream(BOB, bobsAgent);
    const sent = await sendDirect(alicesAgent, bobsAgent, "straight away");

    expect((await reader.directs(1)).map((event) => event.id)).toEqual([sent]);
    expect(realtime().listener.connected()).toBe(true);
  });

  it("should replay a direct message committed while nothing was listening, then stream live ones, each once", async () => {
    const { listen } = gatedRealtime();
    const reader = await openAgentStream(BOB, bobsAgent);
    await reader.drain(300);

    const missed = await sendDirect(alicesAgent, bobsAgent, "while nothing listened");
    listen();
    expect((await reader.directs(1)).map((event) => event.id)).toEqual([missed]);

    const live = await sendDirect(alicesAgent, bobsAgent, "once listening");
    expect((await reader.directs(2)).map((event) => event.id)).toEqual([missed, live]);
    await reader.drain(300);
    expect(reader.received.filter((frame) => frame.event === "direct")).toHaveLength(2);
  });

  it("should tell a UI stream to re-read once LISTEN is active, then stream live posts", async () => {
    const identity = devIdentity("bob");
    await insertUser({ oid: identity.oid, name: identity.name, email: identity.email! });
    const { listen } = gatedRealtime();
    const reader = await openUiStream("bob", "topics=pcs-api");
    await reader.drain(300);

    await createPost(prisma, { author: { oid: ALICE.oid, agentId: null }, topics: ["pcs-api"], title: null, body: "while nothing listened", inReplyTo: null });
    listen();
    expect(await reader.named("resync", 1)).toHaveLength(1);

    await createPost(prisma, { author: { oid: ALICE.oid, agentId: null }, topics: ["pcs-api"], title: null, body: "once listening", inReplyTo: null });
    const posts = await reader.named("post", 1);
    expect(posts.map((frame) => JSON.parse(frame.data!).message.body)).toEqual(["once listening"]);
    expect(reader.received.filter((frame) => frame.event !== undefined).map((frame) => frame.event)).toEqual(["resync", "post"]);
  });
});
