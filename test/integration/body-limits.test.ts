import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_REQUEST_BYTES } from "../../src/agent-api/http.ts";
import { MAX_REQUEST_TOPICS } from "../../src/agent-api/schemas.ts";
import { PUT as subscribe } from "../../src/app/api/agent/[agentId]/subscriptions/route.ts";
import { POST as register } from "../../src/app/api/agent/register/route.ts";
import { devUser, person, prisma, resetDatabase } from "./database.ts";
import { call, jsonOf } from "./routes.ts";

const ALICE = person("alice");
const PATH = "/api/agent/register";

function registerRequest(init: RequestInit & { duplex?: "half" }): Request {
  return new Request(`http://localhost:3000${PATH}`, { method: "POST", ...init, headers: { "x-dev-user": devUser(ALICE), ...init.headers } });
}

async function send(request: Request): Promise<Response> {
  return await register(request, { params: Promise.resolve({}) });
}

function chunks(chunk: Uint8Array, count: number): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
      if (pulled === count) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    }
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("agent API request body limits", () => {
  it("should refuse with a 413 before reading when the declared content length is over the cap", async () => {
    const response = await send(registerRequest({ body: "{}", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } }));

    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toEqual({ error: `the request body is larger than ${MAX_REQUEST_BYTES} bytes` });
    expect(await prisma.agent.count()).toBe(0);
  });

  it("should refuse with a 413 and stop reading when a chunked body grows past the cap", async () => {
    const body = chunks(new Uint8Array(64 * 1024).fill(0x20), 16);

    const response = await send(registerRequest({ body: body.stream, duplex: "half" }));

    expect(response.status).toBe(413);
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(16);
  });

  it("should register when a chunked body under the cap splits a multibyte character across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ session_id: "s-1", name: "café" }));
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      }
    });

    const response = await send(registerRequest({ body: stream, duplex: "half" }));

    expect(response.status).toBe(200);
    expect((await jsonOf(response)).name).toBe("café");
  });

  it("should validate an absent body as an empty object when the request has no body", async () => {
    const response = await send(registerRequest({}));

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toMatch(/^session_id: /);
  });
});

describe("PUT /api/agent/{agent_id}/subscriptions topic cap", () => {
  it("should refuse with a 400 when the request has more topics than the cap", async () => {
    const { agent_id } = await jsonOf(await call(register, { as: ALICE, path: PATH, method: "POST", body: { session_id: "s-1", name: "alice" } }));
    const topics = Array.from({ length: MAX_REQUEST_TOPICS + 1 }, (_, i) => `t${i}`);

    const response = await call(subscribe, {
      as: ALICE,
      path: `/api/agent/${agent_id}/subscriptions`,
      params: { agentId: agent_id },
      method: "PUT",
      body: { topics }
    });

    expect(response.status).toBe(400);
    expect((await jsonOf(response)).error).toBe(`topics: at most ${MAX_REQUEST_TOPICS} topics per request`);
    expect(await prisma.subscription.count()).toBe(0);
  });
});
