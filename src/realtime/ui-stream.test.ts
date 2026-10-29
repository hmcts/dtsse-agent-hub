import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRef } from "../access/rules.ts";
import type { LoadedThreadMessage } from "../messages/direct-thread.ts";
import type { ApiMessage } from "../messages/shape.ts";
import type { HubEvent } from "./events.ts";
import { createEventHub } from "./hub.ts";
import { sharedLoads } from "./shared-load.ts";
import { matchesTopics, selectFrame, sharedPostLoader, type UiStreamSources, type UiWatch, uiStream } from "./ui-stream.ts";

const VIEWER = "oid-viewer";
/** Somebody else, whose agents and virtual agents the viewer is told nothing about. */
const OTHER = "oid-other";
/** The viewer's own agent, which is the only kind any of these frames is about. */
const AGENT = { id: "agent-owned", ownerOid: VIEWER };
/** One of `OTHER`'s, to watch when the question is what the stream refuses. */
const THEIR_AGENT = { id: "agent-elsewhere", ownerOid: OTHER };

function post(id: string, topics: string[]): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body: `post ${id}`,
    topics,
    tagged_agents: [],
    in_reply_to: null,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "agent", agent_id: "agent-x", agent_name: "x", owner_name: "X", owner_email: null }
  };
}

function direct(id: string, ref: Partial<MessageRef> = {}): LoadedThreadMessage {
  return {
    message: { ...post(id, []), kind: "direct", target_agent_id: AGENT.id, delivery: "queued" },
    ref: { kind: "direct", authorOid: OTHER, authorAgent: null, targetAgent: AGENT, parentAuthorOid: null, ...ref }
  };
}

function sources(messages: { posts?: ApiMessage[]; directs?: LoadedThreadMessage[] } = {}): Omit<UiStreamSources, "hub" | "listener"> {
  return {
    viewerOid: VIEWER,
    post: async (id) => messages.posts?.find((message) => message.id === id.toString()),
    direct: async (id) => messages.directs?.find((loaded) => loaded.message.id === id.toString())
  };
}

const LISTENING = { ready: async () => undefined, connected: () => true };

const TOPICS: UiWatch = { topics: ["pcs-api", "database"], match: "any", agent: null };
const THREAD: UiWatch = { topics: [], match: "any", agent: AGENT };
/** The viewer's own agent once it is a conversation's session: an agent of theirs like any other, to this stream. */
const CHAT_THREAD: UiWatch = { topics: [], match: "any", agent: { ...AGENT, ownerOnly: true } };
/** Somebody else's agent, which no stream of the viewer's is ever opened on; every arm re-checks anyway. */
const THEIR_THREAD: UiWatch = { topics: [], match: "any", agent: THEIR_AGENT };
const EVERYTHING: UiWatch = { topics: "everything", match: "any", agent: null };

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

  it("should match a post on any topic when everything is watched", () => {
    expect(matchesTopics(["ccd"], { topics: "everything", match: "all" })).toBe(true);
  });
});

describe("selectFrame", () => {
  // Each is an instruction to a pod, or its answer to the request that asked, so none is a browser's to read.
  it.each([
    [{ type: "assistant_stop" as const, conversation_id: "c", virtual_agent_id: "va", owner_oid: "dev-alice" }],
    [{ type: "assistant_uploads" as const, virtual_agent_id: "va", owner_oid: "dev-alice" }],
    [{ type: "assistant_lookup" as const, lookup_id: "l", virtual_agent_id: "va", owner_oid: "dev-alice" }],
    [{ type: "assistant_lookup_answered" as const, lookup_id: "l", virtual_agent_id: "va", owner_oid: "dev-alice" }]
  ])("should send no frame for %j when it is an instruction to the owner's pod", async (event) => {
    expect(await selectFrame(event, TOPICS, sources())).toBeUndefined();
  });

  it("should send a post on a watched topic when the page watches it", async () => {
    const frame = await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources({ posts: [post("5", ["pcs-api"])] }));

    expect(frame).toBe(`id: 5\nevent: post\ndata: ${JSON.stringify({ message: post("5", ["pcs-api"]) })}\n\n`);
  });

  it("should not send a post on other topics when the page watches different ones", async () => {
    expect(await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources({ posts: [post("5", ["ccd"])] }))).toBeUndefined();
  });

  it("should not read a post at all when the page watches no topics", async () => {
    const loaded = sources({ posts: [post("5", ["pcs-api"])] });
    const read = vi.spyOn(loaded, "post");

    expect(await selectFrame({ type: "post", message_id: "5" }, THREAD, loaded)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("should send a post on any topic when the page watches everything", async () => {
    const frame = await selectFrame({ type: "post", message_id: "5" }, EVERYTHING, sources({ posts: [post("5", ["ccd"])] }));

    expect(frame).toBe(`id: 5\nevent: post\ndata: ${JSON.stringify({ message: post("5", ["ccd"]) })}\n\n`);
  });

  it("should not send a message that is not a post when the page watches everything", async () => {
    const loaded = { ...post("5", []), kind: "direct" as const };

    expect(await selectFrame({ type: "post", message_id: "5" }, EVERYTHING, sources({ posts: [loaded] }))).toBeUndefined();
  });

  it("should not send a post that has gone when it is read", async () => {
    expect(await selectFrame({ type: "post", message_id: "5" }, TOPICS, sources())).toBeUndefined();
  });

  it.each<[string, string, boolean]>([
    ["the viewer's own agent", VIEWER, true],
    ["an agent of somebody else's", OTHER, false]
  ])("should decide whether to send the status of %s", async (_label, owner, sent) => {
    const event: HubEvent = { type: "agent_status", agent_id: "agent-1", owner_oid: owner, status: "busy" };

    const frame = await selectFrame(event, TOPICS, sources());

    expect(frame).toBe(sent ? `event: agent_status\ndata: ${JSON.stringify({ agent_id: "agent-1", status: "busy" })}\n\n` : undefined);
  });

  it("should send a direct message in the watched agent's thread when the viewer owns the agent", async () => {
    const frame = await selectFrame(
      { type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null },
      THREAD,
      sources({ directs: [direct("7")] })
    );

    expect(frame).toBe(`id: 7\nevent: direct\ndata: ${JSON.stringify({ message: direct("7").message })}\n\n`);
  });

  it("should send a message the watched agent wrote when the viewer owns the agent", async () => {
    const sent = direct("8", { authorOid: VIEWER, authorAgent: AGENT, targetAgent: null, parentAuthorOid: OTHER });

    const frame = await selectFrame(
      { type: "direct", message_id: "8", target_agent_id: null, author_agent_id: AGENT.id },
      THREAD,
      sources({ directs: [sent] })
    );

    expect(frame).toContain("event: direct");
  });

  it("should not send a direct message of an agent the viewer does not own", async () => {
    const theirs = direct("7", { targetAgent: THEIR_AGENT });

    expect(
      await selectFrame(
        { type: "direct", message_id: "7", target_agent_id: THEIR_AGENT.id, author_agent_id: null },
        THEIR_THREAD,
        sources({ directs: [theirs] })
      )
    ).toBeUndefined();
  });

  it("should not send a direct message for another agent's thread", async () => {
    expect(
      await selectFrame({ type: "direct", message_id: "7", target_agent_id: "agent-other", author_agent_id: null }, THREAD, sources({ directs: [direct("7")] }))
    ).toBeUndefined();
  });

  it("should not send a direct message when the page watches no agent", async () => {
    expect(
      await selectFrame({ type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null }, TOPICS, sources({ directs: [direct("7")] }))
    ).toBeUndefined();
  });

  it("should not send a message the viewer may not read when the event names the watched agent", async () => {
    // Two people's agents, neither of them the viewer's: the event claims the watched thread and the message is not
    // in it, so the rule and not the event is what decides.
    const overheard = direct("9", { authorOid: OTHER, authorAgent: THEIR_AGENT, targetAgent: { id: "agent-third", ownerOid: OTHER } });

    expect(
      await selectFrame({ type: "direct", message_id: "9", target_agent_id: AGENT.id, author_agent_id: AGENT.id }, THREAD, sources({ directs: [overheard] }))
    ).toBeUndefined();
  });

  it("should not send a direct message that has gone when it is read", async () => {
    expect(await selectFrame({ type: "direct", message_id: "7", target_agent_id: AGENT.id, author_agent_id: null }, THREAD, sources())).toBeUndefined();
  });

  it("should send a delivery change on the watched agent when the viewer owns it", async () => {
    const frame = await selectFrame({ type: "delivery", message_id: "7", agent_id: AGENT.id, state: "delivered" }, THREAD, sources());

    expect(frame).toBe(`event: delivery\ndata: ${JSON.stringify({ message_id: "7", state: "delivered" })}\n\n`);
  });

  it.each<[string, UiWatch]>([
    ["no agent is watched", TOPICS],
    ["another agent is watched", { ...THREAD, agent: { id: "agent-other", ownerOid: VIEWER } }],
    ["the watched agent is somebody else's", { ...THEIR_THREAD, agent: { ...THEIR_AGENT, id: AGENT.id } }]
  ])("should not send a delivery change when %s", async (_label, watch) => {
    expect(await selectFrame({ type: "delivery", message_id: "7", agent_id: AGENT.id, state: "delivered" }, watch, sources())).toBeUndefined();
  });

  it("should send the newest transcript id of the watched agent when the viewer owns it", async () => {
    const frame = await selectFrame({ type: "transcript", agent_id: AGENT.id, owner_oid: VIEWER, last_id: "21" }, THREAD, sources());

    expect(frame).toBe(`event: transcript\ndata: ${JSON.stringify({ agent_id: AGENT.id, last_id: "21" })}\n\n`);
  });

  it("should send the transcript id of the viewer's own conversation agent, which is an agent of theirs like any other", async () => {
    const frame = await selectFrame({ type: "transcript", agent_id: AGENT.id, owner_oid: VIEWER, last_id: "21" }, CHAT_THREAD, sources());

    expect(frame).toBe(`event: transcript\ndata: ${JSON.stringify({ agent_id: AGENT.id, last_id: "21" })}\n\n`);
  });

  it.each<[string, UiWatch]>([
    ["no agent is watched", TOPICS],
    ["another agent is watched", { ...THREAD, agent: { id: "agent-other", ownerOid: VIEWER } }],
    ["the watched agent is somebody else's", { ...THEIR_THREAD, agent: { ...THEIR_AGENT, id: AGENT.id } }]
  ])("should not send a transcript change when %s", async (_label, watch) => {
    expect(await selectFrame({ type: "transcript", agent_id: AGENT.id, owner_oid: VIEWER, last_id: "21" }, watch, sources())).toBeUndefined();
  });

  it("should name the watched agent whose skills changed when the viewer may see its skills", async () => {
    const frame = await selectFrame({ type: "agent_skills", agent_id: AGENT.id, owner_oid: VIEWER }, THREAD, sources());

    expect(frame).toBe(`event: agent_skills\ndata: ${JSON.stringify({ agent_id: AGENT.id })}\n\n`);
  });

  it.each<[string, UiWatch]>([
    ["no agent is watched", TOPICS],
    ["another agent is watched", { ...THREAD, agent: { id: "agent-other", ownerOid: VIEWER } }],
    ["the watched agent is somebody else's", { ...THEIR_THREAD, agent: { ...THEIR_AGENT, id: AGENT.id } }]
  ])("should not send a skills change when %s", async (_label, watch) => {
    expect(await selectFrame({ type: "agent_skills", agent_id: AGENT.id, owner_oid: VIEWER }, watch, sources())).toBeUndefined();
  });

  it("should name the watched agent whose questions changed when the viewer owns it", async () => {
    const frame = await selectFrame({ type: "agent_question", agent_id: AGENT.id, owner_oid: VIEWER }, THREAD, sources());

    expect(frame).toBe(`event: agent_question\ndata: ${JSON.stringify({ agent_id: AGENT.id })}\n\n`);
  });

  it.each<[string, UiWatch]>([
    ["no agent is watched", TOPICS],
    ["another agent is watched", { ...THREAD, agent: { id: "agent-other", ownerOid: VIEWER } }],
    ["the watched agent is somebody else's", { ...THEIR_THREAD, agent: { ...THEIR_AGENT, id: AGENT.id } }]
  ])("should not send a question change when %s", async (_label, watch) => {
    expect(await selectFrame({ type: "agent_question", agent_id: AGENT.id, owner_oid: VIEWER }, watch, sources())).toBeUndefined();
  });

  it("should tell the page to re-read when the listener resyncs", async () => {
    expect(await selectFrame({ type: "resync" }, TOPICS, sources())).toBe("event: resync\ndata: {}\n\n");
  });

  it("should tell the page to re-read when the viewer's own credential changes", async () => {
    expect(await selectFrame({ type: "credential", owner_oid: VIEWER, kind: "github" }, TOPICS, sources())).toBe("event: resync\ndata: {}\n\n");
  });

  it("should send nothing when someone else's credential changes", async () => {
    expect(await selectFrame({ type: "credential", owner_oid: OTHER, kind: "github" }, TOPICS, sources())).toBeUndefined();
  });

  it("should tell the owner which virtual agent changed when it is theirs", async () => {
    expect(await selectFrame({ type: "virtual_agent", virtual_agent_id: "va-1", owner_oid: VIEWER }, TOPICS, sources())).toBe(
      `event: virtual_agent\ndata: ${JSON.stringify({ virtual_agent_id: "va-1" })}\n\n`
    );
  });

  it("should send nothing about a virtual agent of somebody else's", async () => {
    expect(await selectFrame({ type: "virtual_agent", virtual_agent_id: "va-1", owner_oid: OTHER }, TOPICS, sources())).toBeUndefined();
  });

  it("should tell the owner which of their assistant conversations changed when it is theirs", async () => {
    expect(await selectFrame({ type: "assistant_conversation", conversation_id: "c-1", virtual_agent_id: "va-1", owner_oid: VIEWER }, TOPICS, sources())).toBe(
      `event: assistant_conversation\ndata: ${JSON.stringify({ conversation_id: "c-1" })}\n\n`
    );
  });

  it("should send nothing about an assistant conversation when it is someone else's", async () => {
    expect(
      await selectFrame({ type: "assistant_conversation", conversation_id: "c-1", virtual_agent_id: "va-1", owner_oid: OTHER }, TOPICS, sources())
    ).toBeUndefined();
  });
});

describe("sharedPostLoader", () => {
  beforeEach(() => {
    delete (globalThis as { agentHubUiPosts?: unknown }).agentHubUiPosts;
  });

  it("should hand every stream in the pod the same loader when called again", () => {
    const db = { message: { findMany: async () => [] } } as unknown as Parameters<typeof sharedPostLoader>[0];

    expect(sharedPostLoader(db)).toBe(sharedPostLoader(db));
  });

  it("should read a post it has not loaded when asked for it", async () => {
    const findMany = vi.fn(async () => []);
    const db = { message: { findMany } } as unknown as Parameters<typeof sharedPostLoader>[0];

    expect(await sharedPostLoader(db)(41n)).toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [41n] } } }));
  });
});

describe("uiStream", () => {
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("should load a post once for every open stream when a post event arrives", async () => {
    const hub = createEventHub();
    const load = vi.fn(async (id: bigint) => (id === 1n ? post("1", ["pcs-api"]) : undefined));
    const shared = sharedLoads(load, { ttlMs: 10_000 });
    const tabs = Array.from({ length: 5 }, () => {
      const frames: string[] = [];
      const close = uiStream(TOPICS, { hub, listener: LISTENING, ...sources(), post: shared })((frame) => frames.push(frame), vi.fn()) as () => void;
      return { frames, close };
    });

    hub.publish({ type: "post", message_id: "1" });
    await settle();
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    for (const tab of tabs) {
      expect(tab.frames.map((frame) => frame.split("\n")[0])).toEqual(["id: 1"]);
      tab.close();
    }
  });

  // Nothing is cached or re-read per connection: an agent does not change hands, so each status event is answered
  // from its own `owner_oid` and the frames just keep coming.
  it("should send a frame for every status event of the viewer's own agents", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    const close = uiStream(TOPICS, { hub, listener: LISTENING, ...sources() })((frame) => frames.push(frame), vi.fn()) as () => void;

    hub.publish({ type: "agent_status", agent_id: "agent-1", owner_oid: VIEWER, status: "busy" });
    hub.publish({ type: "agent_status", agent_id: "agent-1", owner_oid: VIEWER, status: "idle" });
    hub.publish({ type: "agent_status", agent_id: "agent-2", owner_oid: OTHER, status: "busy" });
    await settle();
    await settle();

    expect(frames.map((frame) => frame.split("\n")[0])).toEqual(["event: agent_status", "event: agent_status"]);
    close();
  });

  it("should send the frames it selects in the order the hub published them when events arrive together", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded = sources({ posts: [post("1", ["pcs-api"]), post("2", ["pcs-api"])] });
    const close = uiStream(TOPICS, {
      hub,
      listener: LISTENING,
      ...loaded,
      post: async (id) => {
        if (id === 1n) {
          await slow;
        }
        return loaded.post(id);
      }
    })((frame) => frames.push(frame), vi.fn()) as () => void;

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
    const close = uiStream(TOPICS, { hub, listener: LISTENING, ...sources({ posts: [post("1", ["pcs-api"])] }) })(
      (frame) => frames.push(frame),
      vi.fn()
    ) as () => void;

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
      listener: LISTENING,
      ...sources(),
      post: async () => {
        throw new Error("database gone");
      }
    })((frame) => frames.push(frame), vi.fn()) as () => void;

    hub.publish({ type: "post", message_id: "1" });
    hub.publish({ type: "resync" });
    await settle();
    await settle();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database gone"));
    expect(frames).toEqual(["event: resync\ndata: {}\n\n"]);
    close();
    warn.mockRestore();
  });

  it("should send a resync, ahead of later events, once LISTEN becomes active when it opened before it was", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    let listening: () => void = () => undefined;
    const listener = { ready: () => new Promise<void>((resolve) => (listening = resolve)), connected: () => false };
    const close = uiStream(TOPICS, { hub, listener, ...sources({ posts: [post("1", ["pcs-api"])] }) })((frame) => frames.push(frame), vi.fn()) as () => void;
    await settle();
    expect(frames).toEqual([]);

    listening();
    hub.publish({ type: "post", message_id: "1" });
    await settle();

    expect(frames.map((frame) => frame.split("\n")[0])).toEqual(["event: resync", "id: 1"]);
    close();
  });

  it("should not send the startup resync when it closed before LISTEN became active", async () => {
    const hub = createEventHub();
    const frames: string[] = [];
    let listening: () => void = () => undefined;
    const listener = { ready: () => new Promise<void>((resolve) => (listening = resolve)), connected: () => false };
    const close = uiStream(TOPICS, { hub, listener, ...sources() })((frame) => frames.push(frame), vi.fn()) as () => void;

    close();
    listening();
    await settle();

    expect(frames).toEqual([]);
  });
});

describe("selectFrame's cover of HubEvent", () => {
  // `selectFrame` returns `string | undefined`, so a `HubEvent` member it has no arm for would fall off the end of
  // the switch as `undefined` — the same answer as "not yours to see" — and the page would never hear about it.
  // `noImplicitReturns` is the whole guard: with it, that case is TS7030 at the function. Nothing else in the suite
  // fails if the flag goes, so this reads it.
  it("should be guarded by noImplicitReturns, which turns a missing arm into a compile error", async () => {
    const tsconfig = await readFile(new URL("../../tsconfig.json", import.meta.url), "utf8");

    expect(tsconfig).toMatch(/"noImplicitReturns":\s*true/);
  });
});
