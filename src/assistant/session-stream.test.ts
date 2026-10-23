import { describe, expect, it, vi } from "vitest";
import { createEventHub } from "../realtime/hub.ts";
import { closeFrame, sessionStream, wakeFrame } from "./session-stream.ts";
import type { Wake } from "./store.ts";

const ASSISTANT = "va-1";

function wake(conversation: string, session = `s-${conversation}`): Wake {
  return { conversation_id: conversation, session_id: session, resume: false, product: "other" };
}

function changed(conversation: string, virtualAgent = ASSISTANT) {
  return { type: "assistant_conversation" as const, conversation_id: conversation, virtual_agent_id: virtualAgent, owner_oid: "o" };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ready = async () => undefined;

function noFail(error: unknown): void {
  throw new Error(`the stream failed: ${String(error)}`);
}

describe("frames", () => {
  it("should frame a wake and a close as the contract's events when written", () => {
    expect(wakeFrame(wake("c1"))).toBe(`event: wake\ndata: ${JSON.stringify(wake("c1"))}\n\n`);
    expect(closeFrame("c1")).toBe(`event: close\ndata: {"conversation_id":"c1"}\n\n`);
  });
});

describe("sessionStream", () => {
  it("should replay pending wakes oldest first, then send each new one as it is notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const one = vi.fn(async (id: string) => wake(id));
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [wake("c1"), wake("c2")], wake: one })((frame) => frames.push(frame), noFail);
    await settle();

    hub.publish(changed("c3"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1")), wakeFrame(wake("c2")), wakeFrame(wake("c3"))]);
    expect(one).toHaveBeenCalledWith("c3");
  });

  it("should send a wake once per connection when it is both replayed and notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [wake("c1")], wake: async (id) => wake(id) })((frame) => frames.push(frame), noFail);
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1"))]);
  });

  it("should send a wake again when a /clear gave the conversation a new session id", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [wake("c1", "old")], wake: async (id) => wake(id, "new") })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1", "old")), wakeFrame(wake("c1", "new"))]);
  });

  it("should send a close when the conversation has gone", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => null })((frame) => frames.push(frame), noFail);
    hub.publish(changed("c9"));
    await settle();

    expect(frames).toEqual([closeFrame("c9")]);
  });

  it("should send nothing when a change leaves the conversation without a pending wake", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined })((frame) => frames.push(frame), noFail);
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([]);
  });

  it("should ignore other assistants' conversations and other events", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const one = vi.fn(async (id: string) => wake(id));
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: one })((frame) => frames.push(frame), noFail);
    hub.publish(changed("c1", "va-other"));
    hub.publish({ type: "post", message_id: "1" });
    await settle();

    expect(frames).toEqual([]);
    expect(one).not.toHaveBeenCalled();
  });

  it("should replay again on a resync, sending only what this connection has not sent", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const pending = [wake("c1")];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [...pending], wake: async () => undefined })((frame) => frames.push(frame), noFail);
    await settle();
    pending.push(wake("c2"));
    hub.publish({ type: "resync" });
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1")), wakeFrame(wake("c2"))]);
  });

  it("should stop listening and sending once closed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = await sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => null })((frame) => frames.push(frame), noFail);
    close();
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([]);
    expect(hub.size()).toBe(0);
  });

  it("should end the stream, and send nothing more, when reading its wakes fails", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const fail = vi.fn();
    sessionStream(ASSISTANT, { hub, ready, wakes: () => Promise.reject(new Error("connection reset")), wake: async (id) => wake(id) })(
      (frame) => frames.push(frame),
      fail
    );
    await settle();
    hub.publish(changed("c1"));
    await settle();

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("connection reset") }));
    expect(frames).toEqual([]);
  });
});
