import { describe, expect, it, vi } from "vitest";
import { createEventHub } from "../realtime/hub.ts";
import type { LookupFrame } from "./lookup-store.ts";
import { closeFrame, deleteUploadsFrame, interruptFrame, lookupFrame, sessionStream, wakeFrame, welshFrame } from "./session-stream.ts";
import type { Wake } from "./store.ts";
import type { WelshFrame } from "./welsh-store.ts";

const ASSISTANT = "va-1";

function wake(conversation: string, session = `s-${conversation}`): Wake {
  return { conversation_id: conversation, session_id: session, resume: false, product: "general", model: "sonnet" };
}

function changed(conversation: string, virtualAgent = ASSISTANT) {
  return { type: "assistant_conversation" as const, conversation_id: conversation, virtual_agent_id: virtualAgent, owner_oid: "o" };
}

function stopped(conversation: string, virtualAgent = ASSISTANT) {
  return { type: "assistant_stop" as const, conversation_id: conversation, virtual_agent_id: virtualAgent, owner_oid: "o" };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ready = async () => undefined;

/** No file deletions outstanding, which is every test but the ones about them. */
const none = async () => [];

/** No lookup to send, which is every test but the ones about lookups. */
const noLookup = async () => undefined;
/** No Welsh job to send, which is every test but the one about Welsh jobs. */
const noWelsh = async () => undefined;

function noFail(error: unknown): void {
  throw new Error(`the stream failed: ${String(error)}`);
}

describe("frames", () => {
  it("should frame a wake, an interrupt and a close as the contract's events when written", () => {
    expect(wakeFrame(wake("c1"))).toBe(`event: wake\ndata: ${JSON.stringify(wake("c1"))}\n\n`);
    expect(interruptFrame("c1")).toBe(`event: interrupt\ndata: {"conversation_id":"c1"}\n\n`);
    expect(closeFrame("c1")).toBe(`event: close\ndata: {"conversation_id":"c1"}\n\n`);
  });
});

describe("sessionStream", () => {
  it("should replay pending wakes oldest first, then send each new one as it is notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const one = vi.fn(async (id: string) => wake(id));
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [wake("c1"), wake("c2")], wake: one })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();

    hub.publish(changed("c3"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1")), wakeFrame(wake("c2")), wakeFrame(wake("c3"))]);
    expect(one).toHaveBeenCalledWith("c3");
  });

  it("should send a wake once per connection when it is both replayed and notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [wake("c1")], wake: async (id) => wake(id) })(
      (frame) => frames.push(frame),
      noFail
    );
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1"))]);
  });

  it("should send a wake again when a /clear gave the conversation a new session id", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, {
      hub,
      ready,
      deletions: none,
      lookup: noLookup,
      welsh: noWelsh,
      wakes: async () => [wake("c1", "old")],
      wake: async (id) => wake(id, "new")
    })((frame) => frames.push(frame), noFail);
    await settle();
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1", "old")), wakeFrame(wake("c1", "new"))]);
  });

  it("should send a close when the conversation has gone", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [], wake: async () => null })(
      (frame) => frames.push(frame),
      noFail
    );
    hub.publish(changed("c9"));
    await settle();

    expect(frames).toEqual([closeFrame("c9")]);
  });

  it("should send nothing when a change leaves the conversation without a pending wake", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [], wake: async () => undefined })(
      (frame) => frames.push(frame),
      noFail
    );
    hub.publish(changed("c1"));
    await settle();

    expect(frames).toEqual([]);
  });

  it("should send an interrupt when the person stops the answer, without reading the conversation", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const one = vi.fn(async (id: string) => wake(id));
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [], wake: one })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();
    hub.publish(stopped("c1"));
    await settle();

    expect(frames).toEqual([interruptFrame("c1")]);
    expect(one, "an interrupt names a turn to end, not a row to re-read").not.toHaveBeenCalled();
  });

  it("should ignore an interrupt for another assistant's conversation", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [], wake: async () => undefined })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();
    hub.publish(stopped("c1", "va-other"));
    await settle();

    expect(frames).toEqual([]);
  });

  // The turn a replayed interrupt would end is over, and sending it again would interrupt whatever came after.
  it("should not replay an interrupt on a resync or send one after the stream is closed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = await sessionStream(ASSISTANT, {
      hub,
      ready,
      deletions: none,
      lookup: noLookup,
      welsh: noWelsh,
      wakes: async () => [],
      wake: async () => undefined
    })((frame) => frames.push(frame), noFail);
    hub.publish(stopped("c1"));
    await settle();
    hub.publish({ type: "resync" });
    await settle();
    close();
    hub.publish(stopped("c1"));
    await settle();

    expect(frames).toEqual([interruptFrame("c1")]);
  });

  it("should ignore other assistants' conversations and other events", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const one = vi.fn(async (id: string) => wake(id));
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [], wake: one })(
      (frame) => frames.push(frame),
      noFail
    );
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
    sessionStream(ASSISTANT, { hub, ready, deletions: none, lookup: noLookup, welsh: noWelsh, wakes: async () => [...pending], wake: async () => undefined })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();
    pending.push(wake("c2"));
    hub.publish({ type: "resync" });
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1")), wakeFrame(wake("c2"))]);
  });

  it("should stop listening and sending once closed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = await sessionStream(ASSISTANT, {
      hub,
      ready,
      deletions: none,
      lookup: noLookup,
      welsh: noWelsh,
      wakes: async () => [],
      wake: async () => null
    })((frame) => frames.push(frame), noFail);
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
    sessionStream(ASSISTANT, {
      hub,
      ready,
      deletions: none,
      lookup: noLookup,
      welsh: noWelsh,
      wakes: () => Promise.reject(new Error("connection reset")),
      wake: async (id) => wake(id)
    })((frame) => frames.push(frame), fail);
    await settle();
    hub.publish(changed("c1"));
    await settle();

    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("connection reset") }));
    expect(frames).toEqual([]);
  });
});

const DELETION = { conversation_id: "c1", upload_ids: ["u1", "u2"] };

function uploadsChanged(virtualAgent = ASSISTANT) {
  return { type: "assistant_uploads" as const, virtual_agent_id: virtualAgent, owner_oid: "o" };
}

describe("sessionStream deletions", () => {
  it("should frame a deletion as the contract's event when written", () => {
    expect(deleteUploadsFrame(DELETION)).toBe(`event: delete_uploads\ndata: ${JSON.stringify(DELETION)}\n\n`);
  });

  // Replayed on connect, unlike an interrupt: a file somebody asked to delete while the pod was restarting still has
  // to go, and deleting a file that is already gone is a deletion that has already happened.
  it("should send every outstanding deletion on connect, after the wakes, when a pod connects", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, {
      hub,
      ready,
      wakes: async () => [wake("c1")],
      wake: async (id) => wake(id),
      deletions: async () => [DELETION],
      lookup: noLookup,
      welsh: noWelsh
    })((frame) => frames.push(frame), noFail);
    await settle();

    expect(frames).toEqual([wakeFrame(wake("c1")), deleteUploadsFrame(DELETION)]);
  });

  it("should send the outstanding deletions again when the person asks for another", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const deletions = vi.fn(async () => [DELETION]);
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined, deletions, lookup: noLookup, welsh: noWelsh })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();

    hub.publish(uploadsChanged());
    await settle();

    expect(frames).toEqual([deleteUploadsFrame(DELETION), deleteUploadsFrame(DELETION)]);
    expect(deletions).toHaveBeenCalledTimes(2);
  });

  // The request is a row, so nothing is lost by replaying it, and a NOTIFY sent while the listener was down would
  // otherwise leave the pod holding files somebody asked it to delete until its next reconnect.
  it("should read the deletions again on a resync, when NOTIFYs may have been missed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, {
      hub,
      ready,
      wakes: async () => [],
      wake: async () => undefined,
      deletions: async () => [DELETION],
      lookup: noLookup,
      welsh: noWelsh
    })((frame) => frames.push(frame), noFail);
    await settle();

    hub.publish({ type: "resync" });
    await settle();

    expect(frames).toEqual([deleteUploadsFrame(DELETION), deleteUploadsFrame(DELETION)]);
  });

  it("should ignore another assistant's deletion request when it is notified", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const deletions = vi.fn(async () => [DELETION]);
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined, deletions, lookup: noLookup, welsh: noWelsh })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();
    frames.length = 0;

    hub.publish(uploadsChanged("va-2"));
    await settle();

    expect(frames).toEqual([]);
    expect(deletions).toHaveBeenCalledTimes(1);
  });

  it("should send nothing when no deletion is outstanding", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined, deletions: none, lookup: noLookup, welsh: noWelsh })(
      (frame) => frames.push(frame),
      noFail
    );
    await settle();

    expect(frames).toEqual([]);
  });

  it("should end the stream, rather than go on silently, when the deletions cannot be read", async () => {
    const hub = createEventHub();
    let failure: unknown;
    sessionStream(ASSISTANT, {
      hub,
      ready,
      wakes: async () => [],
      wake: async () => undefined,
      lookup: noLookup,
      welsh: noWelsh,
      deletions: async () => {
        throw new Error("no database");
      }
    })(
      () => {},
      (error) => {
        failure = error;
      }
    );
    await settle();

    expect((failure as Error).message).toContain("no database");
  });

  it("should send no deletion once the stream has been closed", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = await sessionStream(ASSISTANT, {
      hub,
      ready,
      wakes: async () => [],
      wake: async () => undefined,
      deletions: async () => [DELETION],
      lookup: noLookup,
      welsh: noWelsh
    })((frame) => frames.push(frame), noFail);
    await settle();
    frames.length = 0;
    close();

    hub.publish(uploadsChanged());
    await settle();

    expect(frames).toEqual([]);
  });
});

describe("sessionStream lookups", () => {
  const LOOKUP: LookupFrame = { lookup_id: "l1", kind: "confluence_page", query: "case flags", space: "CCD", sign_in: false };

  function asked(lookupId: string, virtualAgent = ASSISTANT) {
    return { type: "assistant_lookup" as const, lookup_id: lookupId, virtual_agent_id: virtualAgent, owner_oid: "o" };
  }

  function open(lookup: (id: string) => Promise<LookupFrame | undefined>, frames: string[], hub = createEventHub()) {
    const close = sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined, deletions: none, lookup, welsh: noWelsh })(
      (frame) => frames.push(frame),
      noFail
    );
    return { hub, close };
  }

  it("should send the pod a lookup as soon as its owner asks for one", async () => {
    // Arrange
    const frames: string[] = [];
    const { hub } = open(async (id) => (id === "l1" ? LOOKUP : undefined), frames);
    await settle();

    // Act
    hub.publish(asked("l1"));
    await settle();

    // Assert
    expect(frames).toEqual([lookupFrame(LOOKUP)]);
    expect(lookupFrame(LOOKUP)).toBe(`event: lookup\ndata: ${JSON.stringify(LOOKUP)}\n\n`);
  });

  it("should send nothing for another assistant's lookup, one already answered, or after a resync", async () => {
    // Arrange
    const frames: string[] = [];
    const read = vi.fn(async () => undefined);
    const { hub } = open(read, frames);
    await settle();

    // Act
    hub.publish(asked("l1", "va-other"));
    hub.publish(asked("l2"));
    hub.publish({ type: "resync" });
    await settle();

    // Assert
    expect(read).toHaveBeenCalledTimes(1);
    expect(frames.filter((frame) => frame.startsWith("event: lookup"))).toEqual([]);
  });

  it("should keep the stream open when reading a lookup fails", async () => {
    // Arrange
    const frames: string[] = [];
    const { hub } = open(async () => {
      throw new Error("no database");
    }, frames);
    await settle();

    // Act
    hub.publish(asked("l1"));
    await settle();
    hub.publish(stopped("c1"));

    // Assert
    expect(frames).toEqual([interruptFrame("c1")]);
  });
});

describe("sessionStream Welsh jobs", () => {
  const JOB: WelshFrame = { job_id: "w1", kind: "search", product: "cath", args: { query: "back to top", mode: "contains" } };

  function started(jobId: string, virtualAgent = ASSISTANT) {
    return { type: "assistant_welsh" as const, job_id: jobId, virtual_agent_id: virtualAgent, owner_oid: "o" };
  }

  function open(welsh: (id: string) => Promise<WelshFrame | undefined>, frames: string[], hub = createEventHub()) {
    sessionStream(ASSISTANT, { hub, ready, wakes: async () => [], wake: async () => undefined, deletions: none, lookup: noLookup, welsh })(
      (frame) => frames.push(frame),
      noFail
    );
    return hub;
  }

  it("should send the pod a Welsh job as soon as its owner starts one", async () => {
    // Arrange
    const frames: string[] = [];
    const hub = open(async (id) => (id === "w1" ? JOB : undefined), frames);
    await settle();

    // Act
    hub.publish(started("w1"));
    await settle();

    // Assert
    expect(frames).toEqual([welshFrame(JOB)]);
    expect(welshFrame(JOB)).toBe(`event: welsh\ndata: ${JSON.stringify(JOB)}\n\n`);
  });

  it("should send nothing for another assistant's job, one already answered, or after a resync", async () => {
    // Arrange
    const frames: string[] = [];
    const read = vi.fn(async () => undefined);
    const hub = open(read, frames);
    await settle();

    // Act
    hub.publish(started("w1", "va-other"));
    hub.publish(started("w2"));
    hub.publish({ type: "resync" });
    await settle();

    // Assert
    expect(read).toHaveBeenCalledTimes(1);
    expect(frames.filter((frame) => frame.startsWith("event: welsh"))).toEqual([]);
  });

  it("should keep the stream open when reading a Welsh job fails", async () => {
    // Arrange
    const frames: string[] = [];
    const hub = open(async () => {
      throw new Error("no database");
    }, frames);
    await settle();

    // Act
    hub.publish(started("w1"));
    await settle();
    hub.publish(stopped("c1"));

    // Assert
    expect(frames).toEqual([interruptFrame("c1")]);
  });
});
