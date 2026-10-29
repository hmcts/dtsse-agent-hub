// `runBridge` in-process against the mock hub, with a fake inbox, to check how it reconnects, what it delivers
// and what it uploads.
//
// Restored here: "reconnect backoff doubles to a 60s ceiling", which `agent.test.ts` points at because it drives
// `nextBackoff`; and the three `runBridge` cases `inbound.test.ts` points at, which drive the real
// `inboundAccepted` against a live process's command line.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { createMockHub, type MockHubOptions, type RecordedCall } from "./__fixtures__/mock-hub.ts";
import { createApi } from "./api.ts";
import { modelPath } from "./assistant/models.ts";
import { tmuxName } from "./assistant/tmux.ts";
import {
  nextBackoff,
  parseAssistantFrame,
  parseAssistantProduct,
  parseConfluenceExportFrame,
  parseDirectEventMessage,
  parseJiraExportFrame,
  RAPID_CLOSE_MS,
  RAPID_CLOSES_BEFORE_BACKOFF,
  type RunBridgeOptions,
  reconnectDelay,
  runBridge
} from "./bridge.ts";
import type { Env } from "./env.ts";
import { CLIENT_FEATURES } from "./features.ts";
import { ensureStateDir, readText, statePath, writeJson } from "./session.ts";
import { type SkillListing, skillsHash } from "./skills.ts";
import { setTranscriptOff } from "./transcript-sync.ts";

const DEV_USER = "u-me|Me Tester|me@example.com";
const BYPASS = "--dangerously-skip-permissions";
const VIRTUAL = { AGENT_HUB_VIRTUAL_AGENT_ID: "0f8a6a1e-1234-4000-8000-000000000001", AGENT_HUB_LAUNCH_TOKEN: "lt-abc123" };
// A conversation id the bridge can name a tmux session after, as the supervisor names it.
const CONVERSATION = "0f8a6a1e-5555-4000-8000-000000000002";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
const children: ReturnType<typeof spawn>[] = [];
let nextSession = 0;

beforeAll(() => {
  home = tempClaudeHome();
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "CLAUDE_PID", "AGENT_HUB_CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET"]) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, home.env, { CLAUDE_PROJECT_DIR: home.root });
  delete process.env.CLAUDE_PID;
  delete process.env.AGENT_HUB_CLAUDE_PID;
  delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  // Every bridge registers its own SIGTERM and SIGINT handlers, and this file starts more than ten of them.
  process.setMaxListeners(0);
});

afterAll(() => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

const userSettings = () => path.join(home.claude, "settings.json");

// A stand-in for the Claude process: something alive whose command line carries `args`, in a directory with no
// repository settings of its own.
function fakeClaude(...args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore", cwd: home.root });
  children.push(child);
  return child.pid as number;
}

// The three restored `inbound` cases need the user settings absent, where every other case needs the fixture's
// "accept" so the bridge does not hold its messages.
async function withoutUserSettings(fn: () => Promise<void>): Promise<void> {
  const saved = fs.readFileSync(userSettings(), "utf8");
  fs.rmSync(userSettings(), { force: true });
  try {
    await fn();
  } finally {
    fs.writeFileSync(userSettings(), saved);
  }
}

async function waitUntil(fn: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const gaps = (calls: RecordedCall[]) => calls.slice(1).map((c, i) => (c.at ?? 0) - ((calls[i] as RecordedCall).at ?? 0));

type StartBridgeOptions = Omit<RunBridgeOptions, "sid" | "api" | "deliver"> & { env?: Env };

// Registers an agent on a fresh mock hub and runs a bridge for it until `stop` is called. `env` adds to the
// bridge's environment; `savedAgent` adds fields to the agent.json it starts from.
async function startBridge(hubOptions: MockHubOptions, { env: extraEnv, ...bridgeOptions }: StartBridgeOptions = {}, savedAgent: Record<string, unknown> = {}) {
  const hub = createMockHub({ pingMs: 5000, ...hubOptions });
  const url = await hub.listen();
  const api = createApi({ baseUrl: url, devUser: DEV_USER });
  const sid = `bridge-test-${++nextSession}`;
  const { agent_id: agentId } = await api.register({ session_id: sid, name: sid, client_features: [...CLIENT_FEATURES] });
  ensureStateDir(sid);
  fs.writeFileSync(statePath(sid, "enabled"), "");
  writeJson(statePath(sid, "agent.json"), { agent_id: agentId, session_id: sid, name: sid, ...savedAgent });
  const socketWrites: string[] = [];
  const deliver = async (_socketPath: string | null | undefined, _token: string | null | undefined, content: string) => {
    socketWrites.push(content);
  };
  const env = { ...process.env, AGENT_HUB_CLAUDE_PID: String(process.pid), CLAUDE_CODE_MESSAGING_TOKEN: "tok", ...extraEnv };
  const running = runBridge({ sid, env, api, deliver, heartbeatMs: 100, ...bridgeOptions });
  const streamOpens = () => hub.calls.filter((c) => c.method === "GET" && c.path === `/api/agent/${agentId}/stream`);
  return {
    hub,
    sid,
    agentId,
    socketWrites,
    streamOpens,
    logText: () => fs.readFileSync(statePath(sid, "log"), "utf8"),
    acks: (id: string) => hub.calls.filter((c) => c.path === `/api/agent/${agentId}/deliveries/${id}/ack`),
    async stop() {
      fs.rmSync(statePath(sid, "enabled"));
      await running;
      await hub.close();
    }
  };
}

describe("nextBackoff", () => {
  it("should double the delay up to a 60s ceiling when a stream keeps failing", () => {
    // Arrange
    const seq: number[] = [];
    let b = 0;

    // Act
    for (let i = 0; i < 9; i++) {
      b = nextBackoff(b);
      seq.push(b);
    }

    // Assert
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});

describe("reconnectDelay", () => {
  it("should reconnect at once and reset the backoff when a stream ended cleanly after a while", () => {
    // Act & Assert
    expect(reconnectDelay({ backoff: 8000, rapidCloses: 0 }, { clean: true, lastedMs: 25000 })).toEqual({ delay: 0, backoff: 0, rapidCloses: 0 });
    expect(reconnectDelay({ backoff: 0, rapidCloses: 2 }, { clean: true, lastedMs: RAPID_CLOSE_MS })).toEqual({ delay: 0, backoff: 0, rapidCloses: 0 });
  });

  it("should back off exponentially when streams end with an error", () => {
    // Arrange
    let state = reconnectDelay(undefined, { clean: false, lastedMs: 10 });
    const delays = [state.delay];

    // Act
    for (let i = 1; i < 8; i++) {
      state = reconnectDelay(state, { clean: false, lastedMs: 10 });
      delays.push(state.delay);
    }

    // Assert
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(reconnectDelay({ backoff: 32000 }, { clean: false, lastedMs: 60001 }).delay).toBe(1000);
  });

  it("should fall back to the backoff when streams keep ending just after they open", () => {
    // Arrange
    let state = reconnectDelay(undefined, { clean: true, lastedMs: RAPID_CLOSE_MS - 1 });
    const delays = [state.delay];

    // Act
    for (let i = 1; i < RAPID_CLOSES_BEFORE_BACKOFF + 2; i++) {
      state = reconnectDelay(state, { clean: true, lastedMs: RAPID_CLOSE_MS - 1 });
      delays.push(state.delay);
    }

    // Assert
    expect(delays).toEqual([0, 0, 1000, 2000, 4000]);
    expect(reconnectDelay(state, { clean: true, lastedMs: 25000 })).toEqual({ delay: 0, backoff: 0, rapidCloses: 0 });
  });
});

describe("parseDirectEventMessage", () => {
  it("should keep every field the delivery and the recorded entry read when the event is a direct message", () => {
    // Arrange
    const author = { type: "agent", agent_id: "a-1", agent_name: "pcs-api", owner_name: "Pat Peer", owner_email: "pat@example.com" };
    const sent = { id: "42", kind: "direct", title: null, topics: [], body: "hello", in_reply_to: "41", created_at: "2026-10-09T00:00:00.000Z", author };

    // Act
    const message = parseDirectEventMessage(sent);

    // Assert
    expect(message).toEqual(sent);
  });

  it("should keep the kind, title and topics that tell a tagged post from a direct message when the event is a post", () => {
    // Act
    const message = parseDirectEventMessage({ id: "42", kind: "post", title: "flaky E2E", topics: ["pcs-api", 7, "database"], body: "hello" });

    // Assert
    expect(message).toMatchObject({ kind: "post", title: "flaky E2E", topics: ["pcs-api", "database"] });
  });

  it("should be null when the event carries no message with an id", () => {
    // Act & Assert
    expect(parseDirectEventMessage(null)).toBeNull();
    expect(parseDirectEventMessage(["42"])).toBeNull();
    expect(parseDirectEventMessage({})).toBeNull();
    expect(parseDirectEventMessage({ id: "" })).toBeNull();
    expect(parseDirectEventMessage({ id: {} })).toBeNull();
  });

  it("should deliver an empty body rather than drop the message when a field is not what it should be", () => {
    // Act
    const message = parseDirectEventMessage({ id: 42, kind: 7, title: 7, topics: "pcs-api", body: 7, in_reply_to: 9, created_at: 0, author: "Pat" });

    // Assert
    expect(message).toEqual({
      id: "42",
      kind: undefined,
      title: undefined,
      topics: undefined,
      body: "",
      in_reply_to: undefined,
      created_at: undefined,
      author: undefined
    });
  });

  it("should keep a null author field as null when the hub sends one", () => {
    // Act
    const message = parseDirectEventMessage({
      id: "42",
      body: "x",
      in_reply_to: null,
      author: { type: "user", agent_id: null, agent_name: null, owner_name: "Me", owner_email: null }
    });

    // Assert
    expect(message?.in_reply_to).toBeNull();
    expect(message?.author).toEqual({ type: "user", agent_id: null, agent_name: null, owner_name: "Me", owner_email: null });
  });
});

describe("parseJiraExportFrame", () => {
  const pending = { export_id: "5b0e7c1a-1111-4222-8333-444455556666", project: "VIBE", issue_type: "Story", labels: ["hmcts-assistant"] };

  it("should keep a pending export when every value is one the hub would send", () => {
    // Act & Assert
    expect(parseJiraExportFrame(pending)).toEqual(pending);
    expect(parseAssistantFrame({ conversation_id: "c1", jira_export: pending })?.jira_export).toEqual(pending);
  });

  it.each([[{ export_id: "e1" }], [{ project: "VIBE; rm -rf /" }], [{ issue_type: "Story --yes" }], [{ labels: ["a,b"] }], [{ labels: "hmcts-assistant" }]])(
    "should drop the export when it has %j, since its values go into a command",
    (change) => {
      // Act & Assert
      expect(parseJiraExportFrame({ ...pending, ...change })).toBeNull();
    }
  );
});

describe("parseConfluenceExportFrame", () => {
  const pending = { export_id: "5b0e7c1a-1111-4222-8333-444455556666", space_id: "280952876", parent_id: "280959611" };

  it("should keep a pending export when every value is one the hub would send", () => {
    // Act & Assert
    expect(parseConfluenceExportFrame(pending)).toEqual(pending);
    expect(parseAssistantFrame({ conversation_id: "c1", confluence_export: pending })?.confluence_export).toEqual(pending);
  });

  it.each([[{ export_id: "e1" }], [{ space_id: "CCD" }], [{ parent_id: "1; rm -rf /" }], [{ parent_id: 280959611 }]])(
    "should drop the export when it has %j, since its values go into a command",
    (change) => {
      // Act & Assert
      expect(parseConfluenceExportFrame({ ...pending, ...change })).toBeNull();
    }
  );
});

describe("parseAssistantFrame", () => {
  it("should keep every field the envelope and the recorded product read when the frame is an assistant one", () => {
    // Arrange
    const sent = {
      conversation_id: "c1",
      product: "pcs",
      product_label: "Possession claims",
      model: "opus",
      artefact_version: 2,
      artefact_updated_by: "user"
    };

    // Act & Assert
    expect(parseAssistantFrame(sent)).toEqual({ ...sent, jira_export: null, confluence_export: null });
    expect(parseAssistantFrame({ conversation_id: "c1", product: null, product_label: null, artefact_version: 0, artefact_updated_by: null })).toEqual({
      conversation_id: "c1",
      product: null,
      product_label: null,
      model: null,
      artefact_version: 0,
      artefact_updated_by: null,
      jira_export: null,
      confluence_export: null
    });
  });

  it("should be null when the frame carries no assistant object, so the message is framed as the owner's", () => {
    // Act & Assert
    expect(parseAssistantFrame(undefined)).toBeNull();
    expect(parseAssistantFrame(null)).toBeNull();
    expect(parseAssistantFrame(5)).toBeNull();
    expect(parseAssistantFrame(["c1"])).toBeNull();
  });

  it("should drop a field that is not what it should be when the frame is malformed", () => {
    // Act
    const frame = parseAssistantFrame({
      conversation_id: 1,
      product: 2,
      product_label: 3,
      model: "opus --dangerously-skip-permissions",
      artefact_version: "4",
      artefact_updated_by: 5,
      jira_export: "VIBE"
    });

    // Assert
    expect(frame).toEqual({
      conversation_id: undefined,
      product: undefined,
      product_label: undefined,
      model: null,
      artefact_version: null,
      artefact_updated_by: undefined,
      jira_export: null,
      confluence_export: null
    });
  });
});

describe("parseAssistantProduct", () => {
  it("should keep the product and its label when the file is one the bridge wrote", () => {
    // Act & Assert
    expect(parseAssistantProduct({ product: "pcs", product_label: "Possession claims" })).toEqual({ product: "pcs", product_label: "Possession claims" });
    expect(parseAssistantProduct({ product: null, product_label: null })).toEqual({ product: null, product_label: null });
  });

  it("should be null for a file that is not an object, and drop a field that is not a string", () => {
    // Act & Assert
    expect(parseAssistantProduct(null)).toBeNull();
    expect(parseAssistantProduct("pcs")).toBeNull();
    expect(parseAssistantProduct({ product: 7, product_label: ["x"] })).toEqual({ product: null, product_label: null });
  });
});

describe("runBridge", () => {
  for (const reconnectEvent of [true, false]) {
    it(`should reopen the stream at once when the server ends it ${reconnectEvent ? "with a reconnect event" : "without one"}`, async () => {
      // Arrange
      const bridge = await startBridge({ maxLifetimeMs: 2200, reconnectEvent });

      try {
        // Act
        await waitUntil(() => bridge.streamOpens().length >= 3, "three streams");

        // Assert
        for (const gap of gaps(bridge.streamOpens())) {
          expect(gap).toBeLessThan(2200 + 500);
        }
      } finally {
        await bridge.stop();
      }
    });
  }

  it("should write a message to the inbox once and ack it again when it is replayed after it was acked", async () => {
    // Arrange
    const bridge = await startBridge({ maxLifetimeMs: 2200, replayAcked: true });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const msg = bridge.hub.sendDirectFromUser(bridge.agentId, "only once please");
      await waitUntil(() => bridge.streamOpens().length >= 3 && bridge.acks(msg.id).length >= 3, "two replays and their acks");

      // Assert
      expect(bridge.socketWrites.filter((w) => w.includes("only once please"))).toHaveLength(1);
    } finally {
      await bridge.stop();
    }
  });

  it("should replay, ack and write a message to the inbox once when its first ack failed", async () => {
    // Arrange
    const bridge = await startBridge({ maxLifetimeMs: 2200 });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");
      bridge.hub.failNextAcks(1);

      // Act
      const msg = bridge.hub.sendDirectFromUser(bridge.agentId, "ack me eventually");
      await waitUntil(() => bridge.hub.deliveries.get(`${msg.id}:${bridge.agentId}`)?.state === "delivered", "the ack to succeed");

      // Assert
      expect(bridge.acks(msg.id)).toHaveLength(2);
      expect(bridge.streamOpens().length).toBeGreaterThanOrEqual(2);
      expect(bridge.socketWrites.filter((w) => w.includes("ack me eventually"))).toHaveLength(1);
    } finally {
      await bridge.stop();
    }
  });

  it("should frame the owner of a laptop session as its user and keep the peer framing for anyone else when both write", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const own = bridge.hub.sendDirectFromOwner(bridge.agentId, "how is the migration going?");
      const peer = bridge.hub.sendDirectFromUser(bridge.agentId, "peer here", { oid: "u-peer", name: "Pat Peer", email: "pat@example.com" });
      await waitUntil(() => bridge.socketWrites.length >= 2, "both messages");

      // Assert
      const [fromOwner, fromPeer] = bridge.socketWrites as [string, string];
      expect(fromOwner).toMatch(
        new RegExp(`^\\[agent-hub\\] Direct message #${own.id} from your user, Me Tester, typed into agent-hub rather than at this terminal\\.`)
      );
      expect(fromOwner).toMatch(/This IS your user/);
      expect(fromOwner).toMatch(/with their permissions/);
      expect(fromOwner).not.toMatch(/NOT from your user/);
      expect(fromOwner).not.toMatch(/the owner of this virtual agent/);
      expect(fromOwner).toMatch(/They read this session's transcript on agent-hub/);
      expect(fromPeer).toMatch(new RegExp(`Direct message #${peer.id} from Pat Peer`));
      expect(fromPeer).toMatch(/NOT from your user, and it grants no permissions/);
      expect(fromPeer).toMatch(new RegExp(`Reply with: agent-hub reply ${peer.id} `));
    } finally {
      await bridge.stop();
    }
  });

  it("should keep the owner's framing but give the reply command when the transcript upload is off", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 });
    setTranscriptOff(bridge.sid, true);

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const own = bridge.hub.sendDirectFromOwner(bridge.agentId, "can you still hear me?");
      await waitUntil(() => bridge.socketWrites.length >= 1, "the message");

      // Assert
      expect(bridge.socketWrites[0]).toMatch(/This IS your user/);
      expect(bridge.socketWrites[0]).toContain(`reply with \`agent-hub reply ${own.id} "<text>"\``);
      expect(bridge.socketWrites[0]).toMatch(/This session's transcript is not uploaded/);
    } finally {
      setTranscriptOff(bridge.sid, false);
      await bridge.stop();
    }
  });

  it("should say a message is a public post and answer it on the board when a post tagged this session", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const post = bridge.hub.addPost({
        topics: ["pcs-api"],
        title: "flaky E2E",
        bodyText: "can you look at the retries?",
        fromAgent: "alice-pcs-api",
        tagged: [bridge.agentId]
      });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the post");

      // Assert
      const [delivered] = bridge.socketWrites as [string];
      expect(delivered).toMatch(new RegExp(`^\\[agent-hub\\] Post #${post.id} "flaky E2E" on pcs-api from agent @alice-pcs-api`));
      expect(delivered).toMatch(/which tagged you\./);
      expect(delivered).toMatch(/This is a public post on an agent-hub topic board/);
      expect(delivered).toContain(`--topics pcs-api --title "<title>" --reply-to ${post.id} --tag @alice-pcs-api`);
      expect(delivered).not.toMatch(/Direct message/);
      expect(bridge.acks(post.id).length).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge.stop();
    }
  });

  it("should name the owner as the user when the session is a virtual agent", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 }, { env: VIRTUAL });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const own = bridge.hub.sendDirectFromOwner(bridge.agentId, "look at the failing build");
      await waitUntil(() => bridge.socketWrites.length >= 1, "the message");

      // Assert
      expect(bridge.socketWrites[0]).toMatch(
        new RegExp(`^\\[agent-hub\\] Direct message #${own.id} from your user, Me Tester, the owner of this virtual agent`)
      );
      expect(bridge.socketWrites[0]).toMatch(/with their permissions/);
      expect(bridge.socketWrites[0]).toMatch(/Do not use SendMessage/);
    } finally {
      await bridge.stop();
    }
  });

  it("should retry with backoff when the stream is refused", async () => {
    // Arrange
    const bridge = await startBridge({});
    bridge.hub.failNextStreams(2);

    try {
      // Act
      await waitUntil(() => bridge.streamOpens().length >= 3, "three stream requests");

      // Assert
      const [first, second] = gaps(bridge.streamOpens()) as [number, number];
      expect(first).toBeGreaterThanOrEqual(1000);
      expect(first).toBeLessThan(1800);
      expect(second).toBeGreaterThanOrEqual(2000);
      expect(second).toBeLessThan(2800);
    } finally {
      await bridge.stop();
    }
  });

  it("should fall back to backoff when streams end just after opening", async () => {
    // Arrange
    const bridge = await startBridge({ maxLifetimeMs: 20 });

    try {
      // Act
      await waitUntil(() => bridge.streamOpens().length >= RAPID_CLOSES_BEFORE_BACKOFF + 1, "the stream after the rapid closes");

      // Assert
      const delays = gaps(bridge.streamOpens());
      for (const gap of delays.slice(0, RAPID_CLOSES_BEFORE_BACKOFF - 1)) {
        expect(gap).toBeLessThan(500);
      }
      expect(delays[RAPID_CLOSES_BEFORE_BACKOFF - 1]).toBeGreaterThanOrEqual(1000);
    } finally {
      await bridge.stop();
    }
  });

  it("should find the Claude pid later and stop when it exits, when it started before the registry entry", async () => {
    // Arrange
    const hub = createMockHub({ pingMs: 5000 });
    const url = await hub.listen();
    const api = createApi({ baseUrl: url, devUser: DEV_USER });
    const sid = `bridge-test-${++nextSession}`;
    const { agent_id: agentId } = await api.register({ session_id: sid, name: sid, client_features: [...CLIENT_FEATURES] });
    ensureStateDir(sid);
    fs.writeFileSync(statePath(sid, "enabled"), "");
    writeJson(statePath(sid, "agent.json"), { agent_id: agentId, session_id: sid, name: sid });
    const env: Env = { ...process.env, CLAUDE_CODE_MESSAGING_TOKEN: "tok" };
    delete env.AGENT_HUB_CLAUDE_PID;
    const running = runBridge({ sid, env, api, deliver: async () => {}, heartbeatMs: 100 });

    try {
      await waitUntil(() => fs.readFileSync(statePath(sid, "log"), "utf8").includes("no Claude pid found yet"), "the missing pid to be logged");

      // Act
      const exited = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      writeJson(path.join(home.claude, "sessions", `${exited}.json`), { pid: Number(exited), sessionId: sid, name: "late-entry", kind: "interactive" });
      await running;

      // Assert
      const log = fs.readFileSync(statePath(sid, "log"), "utf8");
      expect(log).toMatch(new RegExp(`found claude pid ${exited}`));
      expect(log).toMatch(new RegExp(`claude pid ${exited} exited`));
    } finally {
      fs.rmSync(statePath(sid, "enabled"), { force: true });
      await hub.close();
    }
  });

  it("should upload the transcript as lines are appended and once more as it stops, when it is running", async () => {
    // Arrange
    const line = (text: string) =>
      `${JSON.stringify({ type: "user", uuid: `u-${text}`, timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
    const bridge = await startBridge({ pingMs: 5000 }, { transcriptMs: 50 });
    const file = path.join(home.root, `${bridge.sid}.jsonl`);
    fs.writeFileSync(file, line("first"));
    fs.writeFileSync(statePath(bridge.sid, "transcript"), `${file}\n`);
    const uploaded = () => [...(bridge.hub.transcripts.get(bridge.agentId)?.keys() ?? [])];

    try {
      // Act
      await waitUntil(() => uploaded().includes("u-first:0"), "the existing line");
      fs.appendFileSync(file, line("second"));
      await waitUntil(() => uploaded().includes("u-second:0"), "the appended line");
    } finally {
      await bridge.stop();
    }

    // Assert
    expect(uploaded()).toEqual(["u-first:0", "u-second:0"]);
  });

  it("should send the last turn when it shuts down", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 }, { transcriptMs: 60000 });
    const file = path.join(home.root, `${bridge.sid}.jsonl`);
    const entry = {
      type: "assistant",
      uuid: "u-last",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "done" }] }
    };
    fs.writeFileSync(file, `${JSON.stringify(entry)}\n`);
    fs.writeFileSync(statePath(bridge.sid, "transcript"), `${file}\n`);
    await waitUntil(() => bridge.streamOpens().length >= 1, "the stream");

    // Act
    await bridge.stop();

    // Assert
    expect([...(bridge.hub.transcripts.get(bridge.agentId)?.keys() ?? [])]).toEqual(["u-last:0"]);
  });

  it("should send the skills only when they change from what the hub last took, on each heartbeat", async () => {
    // Arrange
    let skills: SkillListing[] = [{ name: "cft-explain", description: "Explain" }];
    const bridge = await startBridge({}, { skillsMs: 1, skills: () => skills });
    const beats = () => bridge.hub.calls.filter((c) => c.path === `/api/agent/${bridge.agentId}/heartbeat`);
    const withSkills = () => beats().filter((c) => c.body.skills !== undefined);

    try {
      // Act & Assert
      await waitUntil(() => withSkills().length >= 1, "a heartbeat with skills");
      expect(bridge.hub.agents.get(bridge.agentId)?.skills).toEqual(skills);
      const after = beats().length;
      await waitUntil(() => beats().length >= after + 3, "three more heartbeats");
      expect(withSkills()).toHaveLength(1);

      skills = [...skills, { name: "pcs:start-env", description: "Start" }];
      await waitUntil(() => withSkills().length >= 2, "a heartbeat with the changed skills");
      expect(withSkills()[1]?.body.skills).toEqual(skills);
      expect(bridge.hub.agents.get(bridge.agentId)?.skills).toEqual(skills);
    } finally {
      await bridge.stop();
    }
  });

  it("should send the skills on the first heartbeat when a saved agent's skills_hash differs from them", async () => {
    // Arrange
    const skills: SkillListing[] = [{ name: "pcs:start-env", description: "Start" }];
    const bridge = await startBridge({}, { skillsMs: 60 * 60 * 1000, skills: () => skills }, { skills_hash: skillsHash([]) });
    const beats = () => bridge.hub.calls.filter((c) => c.path === `/api/agent/${bridge.agentId}/heartbeat`);

    try {
      // Act
      await waitUntil(() => beats().length >= 1, "the first heartbeat");

      // Assert
      expect(beats()[0]?.body.skills).toEqual(skills);
      expect(bridge.hub.agents.get(bridge.agentId)?.skills).toEqual(skills);
    } finally {
      await bridge.stop();
    }
  });

  it("should send no skills when a saved agent's skills_hash matches them", async () => {
    // Arrange
    const skills: SkillListing[] = [{ name: "pcs:start-env", description: "Start" }];
    const bridge = await startBridge({}, { skillsMs: 60 * 60 * 1000, skills: () => skills }, { skills_hash: skillsHash(skills) });
    const beats = () => bridge.hub.calls.filter((c) => c.path === `/api/agent/${bridge.agentId}/heartbeat`);

    try {
      // Act
      await waitUntil(() => beats().length >= 3, "three heartbeats");

      // Assert
      expect(beats().filter((c) => c.body.skills !== undefined)).toHaveLength(0);
    } finally {
      await bridge.stop();
    }
  });

  it("should hold direct messages unacked, log it once and deliver them once accepted, when Claude Code would hold them", async () => {
    await withoutUserSettings(async () => {
      // Arrange
      const bridge = await startBridge({ pingMs: 5000 }, { env: { AGENT_HUB_CLAUDE_PID: String(fakeClaude(BYPASS)) } });
      const acks = () => bridge.hub.calls.filter((c) => c.path.startsWith(`/api/agent/${bridge.agentId}/deliveries/`));

      try {
        await bridge.hub.waitFor((c) => c.method === "GET" && c.path === `/api/agent/${bridge.agentId}/stream`);

        // Act
        const first = bridge.hub.sendDirectFromUser(bridge.agentId, "first while held");
        const second = bridge.hub.sendDirectFromUser(bridge.agentId, "second while held");
        await waitUntil(() => bridge.logText().includes(`holding direct #${first.id}`), "the hold to be logged");
        await new Promise((r) => setTimeout(r, 500));

        // Assert
        expect(bridge.socketWrites).toHaveLength(0);
        expect(acks()).toHaveLength(0);
        expect(bridge.logText().match(/holding direct/g)).toHaveLength(1);
        expect(bridge.logText()).toMatch(/Fix: run agent-hub setup inbound/);

        fs.writeFileSync(userSettings(), JSON.stringify({ crossSessionInbound: "accept" }));
        await waitUntil(
          () => [first, second].every((m) => bridge.hub.deliveries.get(`${m.id}:${bridge.agentId}`)?.state === "delivered"),
          "both to be delivered and acked"
        );
        expect(bridge.socketWrites.filter((w) => w.includes("first while held"))).toHaveLength(1);
        expect(bridge.socketWrites.filter((w) => w.includes("second while held"))).toHaveLength(1);
        expect(bridge.socketWrites.findIndex((w) => w.includes("first"))).toBeLessThan(bridge.socketWrites.findIndex((w) => w.includes("second")));
        expect(bridge.logText()).toMatch(/incoming messages: delivered .*reconnecting to replay the held ones/);
      } finally {
        await bridge.stop();
      }
    });
  });

  it("should deliver as before when it cannot tell whether Claude Code accepts messages", async () => {
    await withoutUserSettings(async () => {
      // Arrange
      const hub = createMockHub({ pingMs: 5000 });
      const url = await hub.listen();
      const api = createApi({ baseUrl: url, devUser: DEV_USER });
      const sid = `bridge-test-${++nextSession}`;
      const { agent_id: agentId } = await api.register({ session_id: sid, name: sid, client_features: [...CLIENT_FEATURES] });
      ensureStateDir(sid);
      fs.writeFileSync(statePath(sid, "enabled"), "");
      writeJson(statePath(sid, "agent.json"), { agent_id: agentId, session_id: sid, name: sid });
      const socketWrites: string[] = [];
      const running = runBridge({
        sid,
        env: { ...process.env, CLAUDE_CODE_MESSAGING_TOKEN: "tok" },
        api,
        deliver: async (_s, _t, c) => {
          socketWrites.push(c);
        },
        heartbeatMs: 100
      });

      try {
        await hub.waitFor((c) => c.method === "GET" && c.path === `/api/agent/${agentId}/stream`);

        // Act
        const msg = hub.sendDirectFromUser(agentId, "no pid known");
        await waitUntil(() => hub.deliveries.get(`${msg.id}:${agentId}`)?.state === "delivered", "the ack");

        // Assert
        expect(socketWrites).toHaveLength(1);
      } finally {
        fs.rmSync(statePath(sid, "enabled"));
        await running;
        await hub.close();
      }
    });
  });

  it("should frame messages for the assistant, and say when the product changed, when direct frames carry assistant", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 }, { env: { ...VIRTUAL, AGENT_HUB_CONVERSATION_ID: "c1" } });
    const assistant = { conversation_id: "c1", product: "pcs", product_label: "Possession claims", artefact_version: 0, artefact_updated_by: null };

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      const first = bridge.hub.sendDirectFromOwner(bridge.agentId, "what is a possession claim?", { assistant });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the first message");
      bridge.hub.sendDirectFromOwner(bridge.agentId, "and in CCD?", {
        assistant: { ...assistant, product: "ccd", product_label: "Core Case Data", artefact_version: 2, artefact_updated_by: "user" }
      });
      await waitUntil(() => bridge.socketWrites.length >= 2, "the second message");

      // Assert
      const [one, two] = bridge.socketWrites as [string, string];
      expect(one).toMatch(new RegExp(`^\\[agent-hub\\] Direct message #${first.id} from your user, Me Tester, `));
      expect(one).toMatch(/\nProduct area: Possession claims\.\n/);
      expect(one).not.toMatch(/switched/);
      expect(two).toMatch(/\nProduct area: Core Case Data\.\n/);
      expect(two).toMatch(/switched the product context from Possession claims to Core Case Data/);
      expect(two).toMatch(/edited the conversation's document \(version 2\)/);
      expect(JSON.parse(fs.readFileSync(statePath(bridge.sid, "assistant-product.json"), "utf8"))).toEqual({
        product: "ccd",
        product_label: "Core Case Data"
      });
    } finally {
      await bridge.stop();
    }
  });

  it("should switch the session to the frame's model before delivering the message when the person picked another", async () => {
    // Arrange: a session started on Sonnet, and a tmux that records when it was asked, against the deliveries.
    const order: string[] = [];
    const tmux = {
      sendKeys: async (name: string, ...keys: string[]) => {
        order.push(`keys ${name} ${keys.join(" ")}`);
      }
    };
    const bridge = await startBridge(
      { pingMs: 5000 },
      { env: { ...VIRTUAL, AGENT_HUB_CONVERSATION_ID: CONVERSATION, AGENT_HUB_MODEL_ROUTE: "own_licence" }, tmux, modelSettleMs: 0 }
    );
    fs.writeFileSync(modelPath(bridge.sid), "sonnet\n");
    const assistant = { conversation_id: CONVERSATION, product: "pcs", product_label: "Possession claims", artefact_version: 0, artefact_updated_by: null };

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      bridge.hub.sendDirectFromOwner(bridge.agentId, "same model", { assistant: { ...assistant, model: "sonnet" } });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the first message");
      order.push("delivered 1");
      bridge.hub.sendDirectFromOwner(bridge.agentId, "think harder", { assistant: { ...assistant, model: "opus" } });
      await waitUntil(() => bridge.socketWrites.length >= 2, "the second message");
      order.push("delivered 2");

      // Assert
      const name = tmuxName(CONVERSATION);
      expect(order).toEqual(["delivered 1", `keys ${name} -l /model opus`, `keys ${name} Enter`, "delivered 2"]);
      expect(readText(modelPath(bridge.sid))).toBe("opus");
    } finally {
      await bridge.stop();
    }
  });

  /** One upload as the mock hub holds it, and as `held` below takes it. */
  type HeldUpload = [uploadId: string, upload: { parts: Uint8Array[]; fetched: boolean }];

  /**
   * Starts a bridge on an assistant conversation, sends the owner's one message carrying `attachments`, and answers
   * the envelope it was delivered as, with the directory it was given and what the hub was left holding.
   *
   * The attachment cases below differ only in what the hub holds and what the frame says about the file, so
   * everything around that is here. `frame` overrides a field of the `assistant` object, which is how the case of a
   * frame with no `conversation_id` is written: the field is serialised away, as it would be by a hub that sent none.
   */
  async function deliverWithAttachments({
    conversationId,
    attachments,
    held = [],
    frame = {}
  }: {
    conversationId: string;
    attachments: unknown[];
    held?: readonly HeldUpload[];
    frame?: Record<string, unknown>;
  }): Promise<{ delivered: string; uploads: string; stillHeld: Map<string, { parts: Uint8Array[]; fetched: boolean }> }> {
    const uploads = fs.mkdtempSync(path.join(home.root, "uploads-"));
    const bridge = await startBridge({ pingMs: 5000 }, { env: { ...VIRTUAL, AGENT_HUB_CONVERSATION_ID: conversationId, AGENT_HUB_UPLOADS_DIR: uploads } });
    for (const [uploadId, upload] of held) {
      bridge.hub.attachments.set(uploadId, upload);
    }
    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");
      bridge.hub.sendDirectFromOwner(bridge.agentId, "what does this say?", {
        assistant: {
          conversation_id: conversationId,
          product: "pcs",
          product_label: "Possession claims",
          artefact_version: 0,
          artefact_updated_by: null,
          attachments,
          ...frame
        }
      });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the message");
      return { delivered: bridge.socketWrites[0] as string, uploads, stillHeld: bridge.hub.attachments };
    } finally {
      await bridge.stop();
    }
  }

  it("should write an attached file to disk, report it fetched and name its path when the frame carries attachments", async () => {
    // Arrange
    const conversationId = "1dc5f5a0-1234-4000-8000-00000000000c";
    const uploadId = "2dc5f5a0-1234-4000-8000-00000000000d";

    // Act
    const { delivered, uploads, stillHeld } = await deliverWithAttachments({
      conversationId,
      attachments: [{ upload_id: uploadId, name: "letter.pdf", bytes: 6, media_type: "application/pdf", part_bytes: 4, parts: 2 }],
      held: [[uploadId, { parts: [new Uint8Array(4).fill(1), new Uint8Array(2).fill(2)], fetched: false }]]
    });

    // Assert
    const file = path.join(uploads, conversationId, `${uploadId}-letter.pdf`);
    expect([...fs.readFileSync(file)]).toEqual([1, 1, 1, 1, 2, 2]);
    expect(stillHeld.get(uploadId)).toEqual({ parts: [], fetched: true });
    expect(delivered).toMatch(/already saved on this machine at the absolute path below/);
    expect(delivered).toContain(`- ${file} (application/pdf,`);
  });

  it("should still deliver the message, saying the file could not be retrieved, when the attachment cannot be fetched", async () => {
    // Act: the hub knows nothing of this upload, so every part is a 404.
    const { delivered } = await deliverWithAttachments({
      conversationId: "3dc5f5a0-1234-4000-8000-00000000000e",
      attachments: [{ upload_id: "4dc5f5a0-1234-4000-8000-00000000000f", name: "scan.png", bytes: 6, media_type: "image/png", part_bytes: 4, parts: 2 }]
    });

    // Assert
    expect(delivered).toMatch(/could not be retrieved and is not on this machine: scan\.png/);
    expect(delivered).toMatch(/\n---\nwhat does this say\?$/);
  });

  it("should say the file could not be retrieved when the frame names one but no conversation to fetch it for", async () => {
    // Act: a frame carrying attachments and no `conversation_id`, which is the shape a hub this client does not fully
    // understand would send. Without it there is no directory to write to, so nothing can be fetched.
    const { delivered } = await deliverWithAttachments({
      conversationId: "5dc5f5a0-1234-4000-8000-000000000010",
      attachments: [{ upload_id: "6dc5f5a0-1234-4000-8000-000000000011", name: "scan.png", bytes: 6, media_type: "image/png", part_bytes: 4, parts: 2 }],
      frame: { conversation_id: undefined }
    });

    // Assert: the message is delivered and names the file as one that could not be retrieved. Delivering it with the
    // file left out would read as though nothing had been attached, which is the one thing this must not do.
    expect(delivered).toMatch(/could not be retrieved and is not on this machine: scan\.png/);
    expect(delivered).toMatch(/ask them to attach it again/);
    expect(delivered).toMatch(/\n---\nwhat does this say\?$/);
  });

  it("should ask the assistant conversation to run the skill when the user's message starts with one the session has", async () => {
    // Arrange
    const bridge = await startBridge(
      { pingMs: 5000 },
      { env: { ...VIRTUAL, AGENT_HUB_CONVERSATION_ID: "c1" }, skills: () => [{ name: "cft-explain", description: "Explain" }] }
    );
    const assistant = { conversation_id: "c1", product: "pcs", product_label: "Possession claims", artefact_version: 0, artefact_updated_by: null };

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");

      // Act
      bridge.hub.sendDirectFromOwner(bridge.agentId, "/cft-explain what is CDAM?", { assistant });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the message");
      bridge.hub.sendDirectFromOwner(bridge.agentId, "/pcs:start-env aat", { assistant });
      await waitUntil(() => bridge.socketWrites.length >= 2, "the second message");

      // Assert
      expect(bridge.socketWrites[0]).toMatch(/\nIt starts with \/cft-explain: run the cft-explain skill with the rest of the message as its arguments/);
      expect(bridge.socketWrites[1]).not.toMatch(/skill/);
    } finally {
      await bridge.stop();
    }
  });

  it("should keep the peer framing when an assistant frame comes from someone other than the owner", async () => {
    // Arrange
    const bridge = await startBridge({ pingMs: 5000 }, { env: VIRTUAL });

    try {
      await waitUntil(() => bridge.streamOpens().length >= 1, "the first stream");
      const assistant = { conversation_id: "c1", product: "pcs", product_label: "Possession claims", artefact_version: 0, artefact_updated_by: null };

      // Act
      bridge.hub.sendDirectFromUser(bridge.agentId, "peer here", { oid: "u-peer", name: "Pat Peer", email: "pat@example.com" }, { assistant });
      await waitUntil(() => bridge.socketWrites.length >= 1, "the message");

      // Assert
      expect(bridge.socketWrites[0]).toMatch(/NOT from your user/);
      expect(bridge.socketWrites[0]).not.toMatch(/Product area/);
    } finally {
      await bridge.stop();
    }
  });

  it("should send a heartbeat at once when the session turns busy or idle between heartbeats", async () => {
    // Arrange: the short stream lifetime lets the bridge see it is stopped without waiting for a heartbeat.
    const bridge = await startBridge({ pingMs: 5000, maxLifetimeMs: 500 }, { heartbeatMs: 60000, transcriptMs: 50 });
    const beats = () => bridge.hub.calls.filter((c) => c.path === `/api/agent/${bridge.agentId}/heartbeat`);

    try {
      await waitUntil(() => beats().length >= 1, "the heartbeat on connect");

      // Act
      fs.writeFileSync(statePath(bridge.sid, "status"), "busy\n");
      await waitUntil(() => beats().length >= 2, "a heartbeat for busy", 2000);

      // Assert
      expect(beats()[1]?.body.status).toBe("busy");

      // Act
      fs.writeFileSync(statePath(bridge.sid, "status"), "idle\n");
      await waitUntil(() => beats().length >= 3, "a heartbeat for idle", 2000);

      // Assert
      expect(beats()[2]?.body.status).toBe("idle");
      await new Promise((r) => setTimeout(r, 300));
      expect(beats(), "heartbeats sent with no change of status").toHaveLength(3);
    } finally {
      await bridge.stop();
    }
  });

  it("should deliver as before when inbound is unset outside bypass-permissions mode", async () => {
    await withoutUserSettings(async () => {
      // Arrange
      const bridge = await startBridge({ pingMs: 5000 }, { env: { AGENT_HUB_CLAUDE_PID: String(fakeClaude()) } });

      try {
        await bridge.hub.waitFor((c) => c.method === "GET" && c.path === `/api/agent/${bridge.agentId}/stream`);

        // Act
        const msg = bridge.hub.sendDirectFromUser(bridge.agentId, "default mode");
        await waitUntil(() => bridge.hub.deliveries.get(`${msg.id}:${bridge.agentId}`)?.state === "delivered", "the ack");

        // Assert
        expect(bridge.socketWrites).toHaveLength(1);
        expect(bridge.logText()).not.toMatch(/holding direct/);
      } finally {
        await bridge.stop();
      }
    });
  });
});
