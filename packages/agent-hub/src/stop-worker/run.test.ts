import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeSecrets, type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import type { FeedResponse, Message, RegisterResponse, TopicListResponse, TopicsResponse } from "../api.ts";
import { HELD_NOTES, type HeldNote } from "../held-notes.ts";
import { DEFAULT_CONFIG, readJson, statePath, writeJson } from "../session.ts";
import { decide, parseCursors, type RunStopWorkerOptions, runStopWorker, type StopWorkerApi } from "./run.ts";

const SID = "sess-stop-worker";
const MIN = 60000;
const W = "/work/cft-workspace";
const cfg = { ...DEFAULT_CONFIG };

let home: TempClaudeHome;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const [k, v] of Object.entries(home.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = "tok";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  home.cleanup();
});

const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type, message: { role: type, content }, ...extra })}\n`;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const jsonlOf = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

const message = (over: Partial<Message> = {}): Message => ({
  id: "1",
  kind: "post",
  title: null,
  body: "",
  topics: [],
  in_reply_to: null,
  target_agent_id: null,
  created_at: "2026-10-22T09:00:00.000Z",
  author: { type: "agent", agent_id: "agent-9", agent_name: null, owner_name: "Olive Owner", owner_email: null },
  ...over
});

const feedItem = message({
  id: "50",
  title: "Schema change",
  body: "cases table renamed",
  topics: ["pcs-api"],
  author: { type: "agent", agent_id: "agent-9", agent_name: "bob", owner_name: "Olive Owner", owner_email: null }
});

type Call = [string, unknown];
type FakeApi = StopWorkerApi & { calls: Call[] };

function fakeApi(feedMessages: Message[] = []): FakeApi {
  const calls: Call[] = [];
  return {
    calls,
    async feed(_id, q = {}): Promise<FeedResponse> {
      calls.push(["feed", q]);
      const since = Number(q.since ?? 0);
      const out = feedMessages.filter((m) => Number(m.id) > since);
      return { messages: out, cursor: out.length ? (out[out.length - 1] as Message).id : String(since) };
    },
    async subscriptions(): Promise<TopicListResponse> {
      return { topics: ["pcs-api"] };
    },
    async topics(): Promise<TopicsResponse> {
      return {
        topics: [
          { slug: "pcs-api", message_count: 1, last_message_at: null },
          { slug: "ccd", message_count: 1, last_message_at: null }
        ]
      };
    },
    async post(_id, body) {
      calls.push(["post", body]);
      return { message: message({ id: "900" }) };
    },
    async setCursor(_id, cursor) {
      calls.push(["cursor", cursor]);
      return null;
    },
    async register(body): Promise<RegisterResponse> {
      calls.push(["register", body]);
      return { agent_id: "agent-1", name: body.name };
    },
    async subscribe(_id, topics): Promise<TopicListResponse> {
      calls.push(["subscribe", topics]);
      return { topics };
    }
  };
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function followApi({ subscribed = [] }: { subscribed?: string[] } = {}): FakeApi {
  const api = fakeApi();
  const subs = new Set(subscribed);
  api.subscriptions = async () => ({ topics: [...subs].sort(byName) });
  api.subscribe = async (_id, topics) => {
    api.calls.push(["subscribe", topics]);
    for (const t of topics) {
      subs.add(t);
    }
    return { topics: [...subs].sort(byName) };
  };
  return api;
}

const haikuReturning = (value: unknown, prompts: string[] = []) => {
  return async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ type: "result", result: JSON.stringify(value) });
  };
};

const heldNotes = (): HeldNote[] => {
  try {
    return fs
      .readFileSync(statePath(SID, HELD_NOTES), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const cursors = () => readJson(statePath(SID, "cursors.json")) as Record<string, unknown> | null;
const logText = () => fs.readFileSync(statePath(SID, "log"), "utf8");
const callsOf = (api: FakeApi, kind: string) => api.calls.filter((c) => c[0] === kind);

function enable(): void {
  fs.mkdirSync(statePath(SID, ""), { recursive: true });
  fs.writeFileSync(statePath(SID, "enabled"), "x");
  writeJson(statePath(SID, "agent.json"), { agent_id: "agent-1", name: "me" });
}

let transcript: string;

beforeEach(() => {
  fs.rmSync(home.hub, { recursive: true, force: true });
  enable();
  transcript = path.join(home.root, `${Math.random()}.jsonl`);
  fs.writeFileSync(transcript, line("user", "rename the cases table") + line("assistant", "Renamed cases to claim; migration V030 added."));
});

describe("decide", () => {
  it("should rate limit publish and notify at 1 minute by default", () => {
    // Arrange
    const base = { config: cfg, sliceText: "work", secretInSlice: false, feedCount: 2 };

    // Act & Assert
    expect(decide({ ...base, now: 20 * MIN, cursors: {} })).toEqual({
      offerPublish: true,
      offerNotify: true,
      callHaiku: true,
      advanceTranscript: true,
      advanceFeed: true
    });

    // Act: inside the window, both are held so the next allowed pass still sees them.
    const held = decide({ ...base, now: 20 * MIN, cursors: { last_publish_at: 19.5 * MIN, last_notify_at: 19.5 * MIN } });

    // Assert
    expect(held.offerPublish).toBe(false);
    expect(held.offerNotify).toBe(false);
    expect(held.callHaiku).toBe(false);
    expect(held.advanceTranscript, "held for the next allowed publish").toBe(false);
    expect(held.advanceFeed, "held for the next allowed notify").toBe(false);

    // Act
    const due = decide({ ...base, now: 20 * MIN, cursors: { last_publish_at: 19 * MIN, last_notify_at: 19 * MIN } });

    // Assert
    expect(due.offerPublish).toBe(true);
    expect(due.offerNotify).toBe(true);
  });

  it("should block publishing but not reading and drop the slice when it holds a secret", () => {
    // Act
    const d = decide({ now: MIN * 100, cursors: {}, config: cfg, sliceText: "x", secretInSlice: true, feedCount: 1 });

    // Assert
    expect(d.offerPublish).toBe(false);
    expect(d.offerNotify).toBe(true);
    expect(d.advanceTranscript).toBe(true);
  });

  it("should not call Haiku when nothing is new", () => {
    // Act
    const d = decide({ now: MIN * 100, cursors: {}, config: cfg, sliceText: "", secretInSlice: false, feedCount: 0 });

    // Assert
    expect(d.callHaiku).toBe(false);
    expect(d.advanceTranscript).toBe(true);
  });
});

describe("parseCursors", () => {
  it("should keep every field the worker writes when they have the right type", () => {
    // Act & Assert
    expect(parseCursors({ transcript_path: "/w/t.jsonl", transcript_offset: 12, feed_cursor: "50", last_publish_at: 1, last_notify_at: 2 })).toEqual({
      transcript_path: "/w/t.jsonl",
      transcript_offset: 12,
      feed_cursor: "50",
      last_publish_at: 1,
      last_notify_at: 2
    });
  });

  it("should drop a field of the wrong type and answer null when the file is not an object", () => {
    // Act & Assert
    expect(parseCursors({ transcript_path: 7, transcript_offset: "12", feed_cursor: 50, last_publish_at: "soon", last_notify_at: Number.NaN })).toEqual({
      transcript_path: undefined,
      transcript_offset: undefined,
      feed_cursor: undefined,
      last_publish_at: undefined,
      last_notify_at: undefined
    });
    expect(parseCursors(null)).toBeNull();
    expect(parseCursors([1])).toBeNull();
    expect(parseCursors("{}")).toBeNull();
  });
});

describe("runStopWorker", () => {
  it("should publish, hold the note for the next prompt and advance both cursors when a pass is due", async () => {
    // Arrange
    const api = fakeApi([feedItem]);
    const prompts: string[] = [];

    // Act
    await runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning(
        { publish: { topics: ["pcs-api"], title: "Renamed cases table", body: "V030 renames cases to claim." }, notify: "#50 touches the same table." },
        prompts
      ),
      now: () => 100 * MIN,
      config: cfg
    });

    // Assert
    expect(callsOf(api, "post")[0]?.[1]).toEqual({ topics: ["pcs-api"], title: "Renamed cases table", body: "V030 renames cases to claim." });
    expect(heldNotes()).toEqual([{ at: new Date(100 * MIN).toISOString(), text: "#50 touches the same table.", message_ids: ["50"] }]);
    expect(logText()).toMatch(/stop-worker: held note for next prompt/);
    expect(prompts[0]).toMatch(/Renamed cases to claim/);
    expect(prompts[0]).toMatch(/#50 \[pcs-api\] @bob: Schema change/);
    expect(cursors()?.transcript_offset).toBe(fs.statSync(transcript).size);
    expect(cursors()?.feed_cursor).toBe("50");
    expect(cursors()?.last_publish_at).toBe(100 * MIN);
    expect(cursors()?.last_notify_at).toBe(100 * MIN);
    expect(callsOf(api, "cursor")[0]).toEqual(["cursor", "50"]);
  });

  it("should not hold another note or publish when a pass falls inside the rate-limit window", async () => {
    // Arrange
    const api = fakeApi([feedItem]);
    const opts = { sid: SID, transcriptPath: transcript, api, config: cfg };
    await runStopWorker({ ...opts, haiku: haikuReturning({ publish: { topics: ["pcs-api"], title: "T", body: "B" }, notify: "#50" }), now: () => 100 * MIN });
    fs.appendFileSync(transcript, line("user", "carry on") + line("assistant", "Noted #50."));
    let called = false;

    // Act
    await runStopWorker({
      ...opts,
      haiku: async () => {
        called = true;
        return "";
      },
      now: () => 100.5 * MIN
    });

    // Assert
    expect(called).toBe(false);
    expect(callsOf(api, "post")).toHaveLength(1);
    expect(heldNotes()).toHaveLength(1);
  });

  it("should skip Haiku and hold the feed cursor when only feed items arrive inside the notify window", async () => {
    // Arrange
    const api = fakeApi([feedItem]);
    const opts = { sid: SID, transcriptPath: transcript, api, config: cfg };
    writeJson(statePath(SID, "cursors.json"), { transcript_path: transcript, transcript_offset: fs.statSync(transcript).size, last_notify_at: 99.5 * MIN });
    let called = false;

    // Act
    await runStopWorker({
      ...opts,
      haiku: async () => {
        called = true;
        return "";
      },
      now: () => 100 * MIN
    });

    // Assert
    expect(called).toBe(false);
    expect(cursors()?.feed_cursor).toBeUndefined();

    // Act
    await runStopWorker({ ...opts, haiku: haikuReturning({ publish: null, notify: null }), now: () => 104 * MIN });

    // Assert
    expect(cursors()?.feed_cursor).toBe("50");
  });

  it("should never send a secret in the transcript to Haiku and publish nothing", async () => {
    // Arrange
    fs.appendFileSync(transcript, line("assistant", `token is ${fakeSecrets.githubToken}`));
    const api = fakeApi([feedItem]);
    const prompts: string[] = [];

    // Act
    await runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning({ publish: { topics: ["pcs-api"], title: "T", body: "B" }, notify: null }, prompts),
      now: () => 100 * MIN,
      config: cfg
    });

    // Assert
    expect(prompts, "still reads the feed").toHaveLength(1);
    expect(prompts[0]).not.toContain(fakeSecrets.githubToken);
    expect(prompts[0]).toMatch(/PUBLISH is NOT allowed/);
    expect(callsOf(api, "post")).toHaveLength(0);
    expect(cursors()?.transcript_offset).toBe(fs.statSync(transcript).size);
  });

  it("should drop a secret in Haiku's output", async () => {
    // Arrange
    const api = fakeApi([feedItem]);

    // Act
    await runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning({ publish: { topics: ["pcs-api"], title: "T", body: `use ${fakeSecrets.password}` }, notify: `see ${fakeSecrets.jwt}` }),
      now: () => 100 * MIN,
      config: cfg
    });

    // Assert
    expect(callsOf(api, "post")).toHaveLength(0);
    expect(heldNotes()).toEqual([]);
  });

  it("should advance on invalid Haiku output but advance nothing when the call itself fails", async () => {
    // Arrange
    const api = fakeApi([feedItem]);
    const opts = { sid: SID, transcriptPath: transcript, api, now: () => 100 * MIN, config: cfg };

    // Act
    await runStopWorker({
      ...opts,
      haiku: async () => {
        throw new Error("no auth");
      }
    });

    // Assert
    expect(cursors()).toBeNull();

    // Act
    await runStopWorker({ ...opts, haiku: haikuReturning({ publish: { topics: ["NOPE"], title: "T", body: "B" }, notify: null }) });

    // Assert
    expect(callsOf(api, "post")).toHaveLength(0);
    expect(cursors()?.feed_cursor).toBe("50");
  });

  it("should mark the session dirty when the lock is held, and rerun once for it when it is the holder", async () => {
    // Arrange
    const lock = statePath(SID, "worker.lock");
    fs.writeFileSync(lock, `${process.ppid}\n`);

    // Act
    await runStopWorker({ sid: SID, api: fakeApi(), haiku: async () => "", config: cfg });

    // Assert
    expect(fs.existsSync(statePath(SID, "dirty")), "second worker set dirty").toBe(true);
    fs.unlinkSync(lock);

    // Arrange
    let passes = 0;
    const api = fakeApi();
    const origFeed = api.feed;
    api.feed = async (id, q) => {
      passes++;
      if (passes === 1) {
        fs.writeFileSync(statePath(SID, "dirty"), "x");
      }
      return origFeed(id, q);
    };

    // Act
    await runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning({ publish: null, notify: null }),
      now: () => 100 * MIN,
      config: cfg
    });

    // Assert
    expect(passes).toBe(2);
    expect(fs.existsSync(lock), "lock released").toBe(false);
    expect(fs.existsSync(statePath(SID, "dirty"))).toBe(false);
  });

  it("should reclaim a stale lock left by a dead process", async () => {
    // Arrange
    fs.writeFileSync(statePath(SID, "worker.lock"), "999999999\n");
    let ran = false;
    const api = fakeApi();
    api.feed = async () => {
      ran = true;
      return { messages: [], cursor: "0" };
    };

    // Act
    await runStopWorker({ sid: SID, api, haiku: async () => "", config: cfg });

    // Assert
    expect(ran).toBe(true);
  });

  it("should do nothing when the session is disabled", async () => {
    // Arrange
    fs.unlinkSync(statePath(SID, "enabled"));
    let ran = false;
    const api = fakeApi();
    api.feed = async () => {
      ran = true;
      return { messages: [], cursor: "0" };
    };

    // Act
    await runStopWorker({ sid: SID, api, haiku: async () => "", config: cfg });

    // Assert
    expect(ran).toBe(false);
  });

  it("should skip the pass when the session has no registered agent", async () => {
    // Arrange
    fs.unlinkSync(statePath(SID, "agent.json"));
    const api = fakeApi();

    // Act
    await runStopWorker({ sid: SID, api, haiku: async () => "", config: cfg });

    // Assert
    expect(callsOf(api, "feed")).toHaveLength(0);
    expect(logText()).toMatch(/stop-worker: not registered; skipping/);
  });

  it("should log and carry on when a pass throws", async () => {
    // Arrange
    const api = fakeApi();
    api.feed = async () => {
      throw new Error("hub down");
    };

    // Act
    await runStopWorker({ sid: SID, transcriptPath: transcript, api, haiku: async () => "", now: () => 100 * MIN, config: cfg });

    // Assert
    expect(logText()).toMatch(/stop-worker: pass failed: hub down/);
  });

  it("should log a failed cursor sync and still write the cursors", async () => {
    // Arrange
    const api = fakeApi([feedItem]);
    api.setCursor = async () => {
      throw new Error("cursor boom");
    };

    // Act
    await runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning({ publish: null, notify: null }),
      now: () => 100 * MIN,
      config: cfg
    });

    // Assert
    expect(logText()).toMatch(/stop-worker: cursor sync failed: cursor boom/);
    expect(cursors()?.feed_cursor).toBe("50");
  });
});

describe("followWork", () => {
  const followRun = (api: FakeApi, entries: unknown[], extra: Partial<RunStopWorkerOptions> = {}) => {
    fs.writeFileSync(transcript, jsonlOf([{ type: "user", message: { content: "go" } }, ...entries]));
    return runStopWorker({
      sid: SID,
      transcriptPath: transcript,
      api,
      haiku: haikuReturning({ publish: null, notify: null }),
      now: () => 100 * MIN,
      config: cfg,
      root: W,
      branchOf: (dir) => (dir === "/work/cft-workspace/apps/dtsse/dtsse-agent-hub" ? "VIBE-607-web-ui" : "main"),
      ...extra
    });
  };

  it("should re-register on the repo worked in and subscribe to it and its product", async () => {
    // Arrange
    writeJson(statePath(SID, "agent.json"), { agent_id: "agent-1", name: "me", cwd: W, repo: null, branch: null, topics: ["pcs-api"] });
    const api = followApi({ subscribed: ["pcs-api"] });

    // Act
    await followRun(api, [
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/a" }),
      toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/src/a.ts" }),
      toolUse("Bash", { command: "git -C platops/cnp-flux-config log" })
    ]);

    // Assert
    const register = callsOf(api, "register")[0]?.[1] as Record<string, unknown>;
    expect(register.session_id).toBe(SID);
    expect(register.repo).toBe("dtsse-agent-hub");
    expect(register.branch).toBe("VIBE-607-web-ui");
    expect(register.cwd).toBe(W);
    expect(register.name).toBe("me");
    expect(register.host).toBeTruthy();
    expect(callsOf(api, "subscribe")[0]?.[1]).toEqual(["dtsse-agent-hub", "dtsse", "cnp-flux-config", "platops"]);
    const agent = readJson(statePath(SID, "agent.json")) as Record<string, unknown>;
    expect(agent.repo).toBe("dtsse-agent-hub");
    expect(agent.branch).toBe("VIBE-607-web-ui");
    expect(agent.topics).toEqual(["pcs-api", "dtsse-agent-hub", "dtsse", "cnp-flux-config", "platops"]);
    expect(logText()).toMatch(/stop-worker: now working in dtsse-agent-hub \(VIBE-607-web-ui\)/);
    expect(logText()).toMatch(/stop-worker: subscribed to dtsse-agent-hub, dtsse, cnp-flux-config, platops/);

    // Act: nothing changed on the next pass.
    api.calls.length = 0;
    await followRun(api, [toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/src/b.ts" })]);

    // Assert
    expect(
      api.calls.filter((c) => c[0] === "register" || c[0] === "subscribe"),
      "nothing changed"
    ).toHaveLength(0);
  });

  it("should not follow reads, and should follow the workspace only for its own edits", async () => {
    // Arrange
    writeJson(statePath(SID, "agent.json"), { agent_id: "agent-1", name: "me", cwd: W, repo: null, branch: null });
    const api = followApi();

    // Act
    await followRun(api, [
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/a" }),
      toolUse("Grep", { pattern: "x", path: "/work/cft-workspace/apps/pcs/pcs-api" }),
      toolUse("Bash", { command: "/work/cft-workspace/scripts/agent-hub status" })
    ]);

    // Assert
    expect(api.calls.filter((c) => c[0] === "register" || c[0] === "subscribe")).toHaveLength(0);
    expect((readJson(statePath(SID, "agent.json")) as Record<string, unknown>).repo).toBeNull();

    // Act
    await followRun(api, [toolUse("Edit", { file_path: "/work/cft-workspace/scripts/lib/agent-hub/agent.mjs" })]);

    // Assert
    expect((callsOf(api, "register")[0]?.[1] as Record<string, unknown>).repo).toBe("cft-workspace");
    expect(callsOf(api, "subscribe")[0]?.[1]).toEqual(["cft-workspace"]);
  });

  it("should log a failing re-register or subscribe and still complete the pass", async () => {
    // Arrange
    writeJson(statePath(SID, "agent.json"), { agent_id: "agent-1", name: "me", cwd: W, repo: null, branch: null });
    const api = followApi();
    api.register = async () => {
      throw new Error("boom");
    };
    api.subscribe = async () => {
      throw new Error("bang");
    };

    // Act
    await followRun(api, [toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/a" })]);

    // Assert
    expect(logText()).toMatch(/stop-worker: re-register failed: boom/);
    expect(logText()).toMatch(/stop-worker: subscribe failed: bang/);
    expect(cursors()?.transcript_offset).toBe(fs.statSync(transcript).size);
  });

  it("should list the session touches as worked in and only read in the prompt", async () => {
    // Arrange
    writeJson(statePath(SID, "agent.json"), { agent_id: "agent-1", name: "me", cwd: W, repo: "cft-workspace", branch: "feat/agent-hub" });
    const prompts: string[] = [];

    // Act
    await followRun(
      followApi(),
      [
        toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/a" }),
        toolUse("Bash", { command: "cd apps/dtsse/dtsse-agent-hub && yarn test" })
      ],
      { haiku: haikuReturning({ publish: null, notify: null }, prompts) }
    );

    // Assert
    expect(prompts[0]).toMatch(/Candidate repos worked in: dtsse-agent-hub\n/);
    expect(prompts[0]).toMatch(/Candidate repos only read or mentioned: ccd-data-store-api\n/);
    expect(prompts[0]).not.toContain("Candidate repos only read or mentioned: ccd-data-store-api, cft-workspace");
  });
});
