import { describe, expect, it, vi } from "vitest";
import type { Grant, MessageRef } from "../access/rules.ts";
import type { LoadedThreadMessage } from "../messages/direct-thread.ts";
import type { ApiMessage } from "../messages/shape.ts";
import type { HubEvent } from "./events.ts";
import { createEventHub } from "./hub.ts";
import { matchesTopics, selectFrame, type UiStreamSources, type UiWatch, uiStream } from "./ui-stream.ts";

const VIEWER = "oid-viewer";
const OWNER = "oid-owner";
const STRANGER = "oid-stranger";
const AGENT = { id: "agent-owned", ownerOid: OWNER };

function post(id: string, topics: string[]): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body: `post ${id}`,
    topics,
    in_reply_to: null,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "agent", agent_id: "agent-x", agent_name: "x", owner_name: "X", owner_email: null }
  };
}

function direct(id: string, ref: Partial<MessageRef> = {}): LoadedThreadMessage {
  return {
    message: { ...post(id, []), kind: "direct", target_agent_id: AGENT.id, delivery: "queued" },
    ref: { kind: "direct", authorOid: STRANGER, authorAgent: null, targetAgent: AGENT, parentAuthorOid: null, ...ref }
  };
}

function sources(grants: Grant[], messages: { posts?: ApiMessage[]; directs?: LoadedThreadMessage[] } = {}): Omit<UiStreamSources, "hub"> {
  return {
    viewerOid: VIEWER,
    grants: async () => grants,
    post: async (id) => messages.posts?.find((message) => message.id === id.toString()),
    direct: async (id) => messages.directs?.find((loaded) => loaded.message.id === id.toString())
  };
}

const READ: Grant[] = [{ ownerOid: OWNER, granteeOid: VIEWER, level: "read" }];
const TOPICS: UiWatch = { topics: ["pcs-api", "database"], match: "any", agent: null };
const THREAD: UiWatch = { topics: [], match: "any", agent: AGENT };

describe("matchesTopics", () => {
  it.each<[string, string[], UiWatch["match"], boolean]>([
    ["one watched topic in any mode", ["pcs-api"], "any", true],
    ["no watched topic in any mode", ["ccd"], "any", false],
    ["some but not all watched topics in all mode", ["pcs-api"], "all", false],
    ["every watched topic in all mode", ["database", "pcs-api", "ccd"], "all", true]
  ])("should decide %s", (_label, topics, match, expected) => {
    expect(matchesTopics(topics, { topics: ["pcs-api", "database"], match })).toBe(expected);
  });

  it("should match nothing when no topics are watched", () => {
    expect(matchesTopics(["pcs-api"], { topics: [], match: "any" })).toBe(false);
  });
});

describe("selectFrame", () => {
  it("should send a post on a watched topic when the page watches it", async () => {
    const frame = await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources([], { posts: [post("5", ["pcs-api"])] }));

    expect(frame).toBe(`id: 5\nevent: post\ndata: ${JSON.stringify({ message: post("5", ["pcs-api"]) })}\n\n`);
  });

  it("should not send a post on other topics when the page watches different ones", async () => {
    expect(await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources([], { posts: [post("5", ["ccd"])] }))).toBeUndefined();
  });

  it("should not read a post at all when the page watches no topics", async () => {
    const loaded = sources([], { posts: [post("5", ["pcs-api"])] });
    const read = vi.spyOn(loaded, "post");

    expect(await selectFrame({ type: "post", message_id: "5" }, THREAD, loaded)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("should not send a post that has gone when it is read", async () => {
    expect(await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources([]))).toBeUndefined();
  });

  it.each<[string, string, Grant[], boolean]>([
    ["the viewer's own agent", VIEWER, [], true],
    ["an agent the viewer holds a read grant for", OWNER, READ, true],
    ["an agent the viewer has no grant for", STRANGER, READ, false]
  ])("should decide whether to send the status of %s", async (_label, owner, grants, sent) => {
    const event: HubEvent = { type: "agent_status", agent_id: "agent-1", owner_oid: owner, status: "busy" };

    const frame = await selectFrame(event, TOPICS, sources(grants));

    expect(frame).toBe(sent ? `event: agent_status\ndata: ${JSON.stringify({ agent_id: "agent-1", status: "busy" })}\n\n` : undefined);
  });

  it("should send a direct message in the watched agent's thread when the viewer can see the agent", async () => {
    const frame = await selectFrame(
      { type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null },
      THREAD,
      sources(READ, { directs: [direct("7")] })
    );

    expect(frame).toBe(`id: 7\nevent: direct\ndata: ${JSON.stringify({ message: direct("7").message })}\n\n`);
  });

  it("should send a message the watched agent wrote when the viewer can see the agent", async () => {
    const sent = direct("8", { authorOid: OWNER, authorAgent: AGENT, targetAgent: null, parentAuthorOid: STRANGER });

    const frame = await selectFrame(
      { type: "direct", message_id: "8", target_agent_id: null, author_agent_id: AGENT.id },
      THREAD,
      sources(READ, { directs: [sent] })
    );

    expect(frame).toContain("event: direct");
  });

  it("should not send a direct message once the viewer's grant is revoked", async () => {
    expect(
      await selectFrame({ type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null }, THREAD, sources([], { directs: [direct("7")] }))
    ).toBeUndefined();
  });

  it("should not send a direct message for another agent's thread", async () => {
    expect(
      await selectFrame(
        { type: "direct", message_id: "7", target_agent_id: "agent-other", author_agent_id: null },
        THREAD,
        sources(READ, { directs: [direct("7")] })
      )
    ).toBeUndefined();
  });

  it("should not send a direct message when the page watches no agent", async () => {
    expect(
      await selectFrame(
        { type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null },
        TOPICS,
        sources(READ, { directs: [direct("7")] })
      )
    ).toBeUndefined();
  });

  it("should not send a message the viewer may not read when it is in the watched thread", async () => {
    // The watched agent's message to someone else's agent: its grantees cannot read it.
    const overheard = direct("9", { authorOid: OWNER, authorAgent: AGENT, targetAgent: { id: "agent-elsewhere", ownerOid: STRANGER } });

    expect(
      await selectFrame(
        { type: "direct", message_id: "9", target_agent_id: "agent-elsewhere", author_agent_id: AGENT.id },
        THREAD,
        sources(READ, { directs: [overheard] })
      )
    ).toBeUndefined();
  });

  it("should not send a direct message that has gone when it is read", async () => {
    expect(await selectFrame({ type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null }, THREAD, sources(READ))).toBeUndefined();
  });

  it("should send a delivery change on the watched agent when the viewer can see it", async () => {
    const frame = await selectFrame({ type: "delivery", message_id: "7", agent_id: AGENT.id, state: "delivered" }, THREAD, sources(READ));

    expect(frame).toBe(`event: delivery\ndata: ${JSON.stringify({ message_id: "7", state: "delivered" })}\n\n`);
  });

  it.each<[string, UiWatch, Grant[]]>([
    ["no agent is watched", TOPICS, READ],
    ["another agent is watched", { ...THREAD, agent: { id: "agent-other", ownerOid: OWNER } }, READ],
    ["the viewer can no longer see the agent", THREAD, []]
  ])("should not send a delivery change when %s", async (_label, watch, grants) => {
    expect(await selectFrame({ type: "delivery", message_id: "7", agent_id: AGENT.id, state: "delivered" }, watch, sources(grants))).toBeUndefined();
  });

  it("should tell the page to re-read when the listener resyncs", async () => {
    expect(await selectFrame({ type: "resync" }, TOPICS, sources([]))).toBe("event: resync\ndata: {}\n\n");
  });
});

describe("uiStream", () => {
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("should send the frames it selects in the order the hub published them when events arrive together", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded = sources([], { posts: [post("1", ["pcs-api"]), post("2", ["pcs-api"])] });
    const close = uiStream(TOPICS, {
      hub,
      ...loaded,
      post: async (id) => {
        if (id === 1n) {
          await slow;
        }
        return loaded.post(id);
      }
    })((frame) => frames.push(frame)) as () => void;

    hub.publish({ type: "post", message_id: "1" });
    hub.publish({ type: "post", message_id: "2" });
    await settle();
    expect(frames).toEqual([]);
    release();
    await settle();
    await settle();

    expect(frames.map((frame) => frame.split("\n")[0])).toEqual(["id: 1", "id: 2"]);
    close();
  });

  it("should stop sending and unsubscribe when it closes", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = uiStream(TOPICS, { hub, ...sources([], { posts: [post("1", ["pcs-api"])] }) })((frame) => frames.push(frame)) as () => void;

    close();
    hub.publish({ type: "post", message_id: "1" });
    await settle();

    expect(frames).toEqual([]);
    expect(hub.size()).toBe(0);
  });

  it("should log and carry on when a loader fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = createEventHub();
    const frames: string[] = [];
    const close = uiStream(TOPICS, {
      hub,
      ...sources([]),
      post: async () => {
        throw new Error("database gone");
      }
    })((frame) => frames.push(frame)) as () => void;

    hub.publish({ type: "post", message_id: "1" });
    hub.publish({ type: "resync" });
    await settle();
    await settle();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database gone"));
    expect(frames).toEqual(["event: resync\ndata: {}\n\n"]);
    close();
    warn.mockRestore();
  });
});
