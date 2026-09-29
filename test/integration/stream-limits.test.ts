import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as agentStream } from "../../src/app/api/agent/[agentId]/stream/route.ts";
import { GET as uiStream } from "../../src/app/api/ui/stream/route.ts";
import { realtime } from "../../src/realtime/process.ts";
import { AGENT_STREAMS_PER_PERSON, streamLimits, UI_STREAMS_PER_PERSON } from "../../src/realtime/stream-slots.ts";
import { devIdentity } from "../../src/viewer/identity.ts";
import { insertAgent, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

const ALICE = person("alice");
const BOB = person("bob");

const open: { abort: AbortController; response: Response }[] = [];

async function openAgentStream(as: Person, agentId: string): Promise<Response> {
  const abort = new AbortController();
  const response = await call(agentStream, {
    as,
    path: `/api/agent/${agentId}/stream`,
    params: { agentId },
    signal: abort.signal,
    headers: { accept: "text/event-stream" }
  });
  open.push({ abort, response });
  return response;
}

async function openUiStream(as: string): Promise<Response> {
  const abort = new AbortController();
  const response = await uiStream(
    new NextRequest("http://localhost:3000/api/ui/stream", { headers: { cookie: `ah_dev_persona=${as}` }, signal: abort.signal })
  );
  open.push({ abort, response });
  return response;
}

function closeLastOk(): void {
  const index = open.findLastIndex(({ response }) => response.status === 200);
  const [stream] = open.splice(index, 1);
  stream!.abort.abort();
}

beforeAll(async () => {
  await realtime().listener.ready();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  for (const { abort, response } of open.splice(0)) {
    abort.abort();
    await response.body?.cancel().catch(() => undefined);
  }
});

afterAll(async () => {
  await realtime().listener.stop();
  await prisma.$disconnect();
});

describe("agent stream limits", () => {
  it("should refuse with the JSON error shape when the owner holds the limit across all their agents", async () => {
    const first = await insertAgent(ALICE, "alice-one");
    const second = await insertAgent(ALICE, "alice-two");
    for (let opened = 0; opened < AGENT_STREAMS_PER_PERSON; opened += 1) {
      expect((await openAgentStream(ALICE, opened % 2 === 0 ? first : second)).status).toBe(200);
    }

    const refused = await openAgentStream(ALICE, first);

    expect(refused.status).toBe(429);
    expect(await jsonOf(refused)).toEqual({ error: "too many open streams for this person" });
    expect(streamLimits().agent.held(ALICE.oid)).toBe(AGENT_STREAMS_PER_PERSON);
  });

  it("should accept another stream when one at the limit closes", async () => {
    const agent = await insertAgent(ALICE, "alice-one");
    for (let opened = 0; opened < AGENT_STREAMS_PER_PERSON; opened += 1) {
      await openAgentStream(ALICE, agent);
    }
    expect((await openAgentStream(ALICE, agent)).status).toBe(429);

    closeLastOk();

    expect((await openAgentStream(ALICE, agent)).status).toBe(200);
  });

  it("should not count a request against the owner when it is refused before streaming", async () => {
    const bobsAgent = await insertAgent(BOB, "bob-one");
    await insertUser(ALICE);

    expect((await openAgentStream(ALICE, bobsAgent)).status).toBe(403);

    expect(streamLimits().agent.held(ALICE.oid)).toBe(0);
  });

  it("should give every slot back when all the owner's streams close", async () => {
    const agent = await insertAgent(ALICE, "alice-one");
    await openAgentStream(ALICE, agent);
    await openAgentStream(ALICE, agent);

    for (const { abort } of open.splice(0)) {
      abort.abort();
    }

    expect(streamLimits().agent.held(ALICE.oid)).toBe(0);
  });
});

describe("UI stream limits", () => {
  it("should refuse with a plain 429 when the viewer holds the limit, leaving other viewers alone", async () => {
    for (let opened = 0; opened < UI_STREAMS_PER_PERSON; opened += 1) {
      expect((await openUiStream("alice")).status).toBe(200);
    }

    const refused = await openUiStream("alice");

    expect(refused.status).toBe(429);
    expect(refused.headers.get("content-type")).not.toContain("json");
    expect((await openUiStream("bob")).status).toBe(200);
  });

  it("should accept another stream when one at the limit closes", async () => {
    for (let opened = 0; opened < UI_STREAMS_PER_PERSON; opened += 1) {
      await openUiStream("alice");
    }

    closeLastOk();

    expect(streamLimits().ui.held(devIdentity("alice").oid)).toBe(UI_STREAMS_PER_PERSON - 1);
    expect((await openUiStream("alice")).status).toBe(200);
  });
});
