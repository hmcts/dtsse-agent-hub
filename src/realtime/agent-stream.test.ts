import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiMessage } from "../messages/shape.ts";
import { agentStream, directFrame, RECONNECT_FRAME } from "./agent-stream.ts";
import { createEventHub } from "./hub.ts";

const AGENT = "agent-b";

function message(id: string): ApiMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null }
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function direct(id: string, target: string | null = AGENT) {
  return { type: "direct" as const, message_id: id, target_agent_id: target, author_agent_id: null };
}

const ready = async () => undefined;

function noFail(error: unknown): void {
  throw new Error(`the stream failed: ${String(error)}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directFrame", () => {
  it("should frame a direct message with its id and the contract's event name and body", () => {
    expect(directFrame(message("7"))).toBe(`id: 7\nevent: direct\ndata: ${JSON.stringify({ message: message("7") })}\n\n`);
  });
});

describe("RECONNECT_FRAME", () => {
  it("should be the documented reconnect event with an empty object as its data", () => {
    expect(RECONNECT_FRAME).toBe("event: reconnect\ndata: {}\n\n");
  });
});

describe("agentStream", () => {
  it("should replay queued deliveries oldest first, then send new direct messages as they are notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const queuedOne = vi.fn(async (id: bigint) => message(id.toString()));
    agentStream(AGENT, { hub, ready, queued: async () => [message("1"), message("2")], queuedOne })((frame) => frames.push(frame), noFail);
    await settle();

    hub.publish(direct("3"));
    await settle();

    expect(frames).toEqual([directFrame(message("1")), directFrame(message("2")), directFrame(message("3"))]);
    expect(queuedOne).toHaveBeenCalledWith(3n);
  });

  it("should ignore direct messages for other agents and posts", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const queuedOne = vi.fn(async (id: bigint) => message(id.toString()));
    agentStream(AGENT, { hub, ready, queued: async () => [], queuedOne })((frame) => frames.push(frame), noFail);
    await settle();

    hub.publish(direct("4", "agent-other"));
    hub.publish(direct("5", null));
    hub.publish({ type: "post", message_id: "6" });
    hub.publish({ type: "agent_status", agent_id: AGENT, owner_oid: "o", status: "idle" });
    await settle();

    expect(frames).toEqual([]);
    expect(queuedOne).not.toHaveBeenCalled();
  });

  it("should send a message once when it is both replayed and notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    agentStream(AGENT, { hub, ready, queued: async () => [message("8")], queuedOne: async (id) => message(id.toString()) })(
      (frame) => frames.push(frame),
      noFail
    );
    hub.publish(direct("8"));
    await settle();

    expect(frames).toEqual([directFrame(message("8"))]);
  });

  it("should not send a notified message that was acked before it could be read", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    agentStream(AGENT, { hub, ready, queued: async () => [], queuedOne: async () => undefined })((frame) => frames.push(frame), noFail);
    hub.publish(direct("9"));
    await settle();

    expect(frames).toEqual([]);
  });

  it("should replay again on a resync, sending only what this connection has not sent", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const queue = [message("10")];
    agentStream(AGENT, { hub, ready, queued: async () => [...queue], queuedOne: async () => undefined })((frame) => frames.push(frame), noFail);
    await settle();

    queue.push(message("11"));
    hub.publish({ type: "resync" });
    await settle();

    expect(frames).toEqual([directFrame(message("10")), directFrame(message("11"))]);
  });

  it("should stop listening and sending once closed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = await agentStream(AGENT, { hub, ready, queued: async () => [], queuedOne: async (id) => message(id.toString()) })(
      (frame) => frames.push(frame),
      noFail
    );

    close();
    hub.publish(direct("12"));
    await settle();

    expect(frames).toEqual([]);
    expect(hub.size()).toBe(0);
  });

  it("should subscribe before waiting for LISTEN, and read the replay only once it is active", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    let listening: () => void = () => undefined;
    const queued = vi.fn(async () => [message("13")]);
    agentStream(AGENT, {
      hub,
      ready: () => new Promise((resolve) => (listening = resolve)),
      queued,
      queuedOne: async (id) => message(id.toString())
    })((frame) => frames.push(frame), noFail);
    await settle();

    expect(hub.size()).toBe(1);
    expect(queued).not.toHaveBeenCalled();
    listening();
    hub.publish(direct("13"));
    hub.publish(direct("14"));
    await settle();

    expect(frames).toEqual([directFrame(message("13")), directFrame(message("14"))]);
  });

  it.each([
    ["the replay", { queued: () => Promise.reject(new Error("connection reset")), queuedOne: async (id: bigint) => message(id.toString()) }],
    ["a notified message", { queued: async () => [], queuedOne: () => Promise.reject(new Error("connection reset")) }]
  ])("should end the stream, and send nothing more, when reading %s fails", async (_label, reads) => {
    const hub = createEventHub();
    const frames: string[] = [];
    const fail = vi.fn();
    agentStream(AGENT, { hub, ready, ...reads })((frame) => frames.push(frame), fail);
    hub.publish(direct("15"));
    await settle();
    hub.publish(direct("16"));
    await settle();

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("connection reset") }));
    expect(frames).toEqual([]);
  });
});
