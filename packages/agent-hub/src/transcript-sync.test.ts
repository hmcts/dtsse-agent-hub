// The incremental transcript upload: what a JSONL line becomes, what the secret scanner takes out of it, how
// batches are sized, and how the saved byte offset moves. Every case from the workspace suite is here — none of
// them needed the CLI or a hook.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeSecrets, type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { createMockHub } from "./__fixtures__/mock-hub.ts";
import { type Api, ApiError, createApi, type RequestOptions, type TranscriptBody, type TranscriptResponse } from "./api.ts";
import type { Env } from "./env.ts";
import { directEnvelope } from "./envelope.ts";
import { CLIENT_FEATURES } from "./features.ts";
import { ensureStateDir, readJson, statePath } from "./session.ts";
import {
  BACKFILL_BYTES,
  backfillStart,
  batchItems,
  createTranscriptSync,
  fastForward,
  MAX_BATCH_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_CONTENT_BYTES,
  parseEntries,
  parseLines,
  type ScrubbedEntry,
  scrub,
  setTranscriptOff,
  syncStatePath,
  toEntries,
  transcriptOff,
  transcriptOffByEnv,
  transcriptOffBySession,
  UNAVAILABLE_PAUSE_MS
} from "./transcript-sync.ts";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
let nextSession = 0;
let nextUuid = 0;

beforeAll(() => {
  home = tempClaudeHome();
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "AGENT_HUB_TRANSCRIPT", "CLAUDE_PROJECT_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = home.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_PROJECT_DIR = home.root;
  delete process.env.AGENT_HUB_TRANSCRIPT;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

const uuid = () => `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, "0")}`;
const SESSION = "7b2adff5-dd59-41b6-ad25-1c9d2a1962dd";

const base = (extra: Record<string, unknown>) => ({
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  entrypoint: "cli",
  cwd: "/workspace",
  sessionId: SESSION,
  version: "2.1.270",
  gitBranch: "master",
  uuid: uuid(),
  timestamp: "2026-10-01T15:32:38.112Z",
  ...extra
});

const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  base({ type: "user", promptId: "p1", message: { role: "user", content }, permissionMode: "default", ...extra });

const assistantLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  base({
    type: "assistant",
    requestId: "req_1",
    message: {
      model: "claude-opus-5-5",
      id: "msg_1",
      type: "message",
      role: "assistant",
      content,
      stop_reason: "tool_use",
      usage: { input_tokens: 2, output_tokens: 112 }
    },
    ...extra
  });

const jsonl = (...lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

describe("toEntries", () => {
  it("should map a realistic transcript, line type by line type", () => {
    // Arrange
    const prompt = userLine("why does run.sh fail?");
    const thinking = assistantLine([
      { type: "thinking", thinking: "private reasoning", signature: "sig" },
      { type: "redacted_thinking", data: "x" }
    ]);
    const call = assistantLine([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "cat .claude/run.sh", description: "Show run.sh" } }
    ]);
    const result = userLine([{ tool_use_id: "toolu_01", type: "tool_result", content: "#!/usr/bin/env bash\nset -euo pipefail" }], {
      sourceToolAssistantUUID: call.uuid
    });
    const arrayResult = userLine([
      {
        type: "tool_result",
        tool_use_id: "toolu_02",
        is_error: true,
        content: [
          { type: "text", text: "Exit code 127" },
          { type: "image", source: { type: "base64", data: "AAAA" } },
          { type: "text", text: "not found" }
        ]
      }
    ]);
    const mixedUser = userLine([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", data: "AAAA" } }
    ]);
    const answer = assistantLine([{ type: "text", text: "The failure is in `az` itself." }]);
    const compact = userLine("This session is being continued from a previous conversation.\n\nSummary: …", {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true
    });

    // Act & Assert
    expect(toEntries(prompt)).toEqual([
      {
        key: `${prompt.uuid}:0`,
        role: "user",
        content: { text: "why does run.sh fail?" },
        truncated: false,
        redacted: false,
        message_id: null,
        occurred_at: prompt.timestamp
      }
    ]);
    expect(toEntries(thinking)).toEqual([]);
    expect(toEntries(call).map((e) => [e.key, e.role, e.content])).toEqual([
      [`${call.uuid}:0`, "assistant", { text: "Let me look." }],
      [`${call.uuid}:1`, "tool_use", { id: "toolu_01", name: "Bash", input: { command: "cat .claude/run.sh", description: "Show run.sh" } }]
    ]);
    expect(toEntries(result)[0]?.content).toEqual({ tool_use_id: "toolu_01", output: "#!/usr/bin/env bash\nset -euo pipefail", is_error: false });
    expect(toEntries(arrayResult)[0]).toEqual({
      key: `${arrayResult.uuid}:0`,
      role: "tool_result",
      content: { tool_use_id: "toolu_02", output: "Exit code 127\n[image]\nnot found", is_error: true },
      truncated: false,
      redacted: false,
      message_id: null,
      occurred_at: arrayResult.timestamp
    });
    expect(toEntries(mixedUser).map((e) => [e.key, e.role, e.content])).toEqual([[`${mixedUser.uuid}:0`, "user", { text: "look at this" }]]);
    expect(toEntries(answer)[0]?.content).toEqual({ text: "The failure is in `az` itself." });
    expect(toEntries(compact).map((e) => [e.role, String((e.content as { text: string }).text).slice(0, 12)])).toEqual([["system", "This session"]]);
  });

  it("should skip sidechains, meta lines, bookkeeping lines and thinking", () => {
    // Arrange
    const skipped: unknown[] = [
      userLine("subagent prompt", { isSidechain: true }),
      assistantLine([{ type: "text", text: "subagent answer" }], { isSidechain: true }),
      userLine("<local-command-caveat>…</local-command-caveat>", { isMeta: true }),
      userLine([{ type: "text", text: "Base directory for this skill: …" }], { isMeta: true }),
      base({ type: "system", subtype: "stop_hook_summary", hookCount: 2 }),
      base({ type: "attachment", attachment: { type: "hook_success", content: "hello" } }),
      { type: "file-history-snapshot", messageId: "m", snapshot: { trackedFileBackups: {} } },
      { type: "ai-title", aiTitle: "run.sh illegal instruction error", sessionId: SESSION },
      { type: "custom-title", customTitle: "x", sessionId: SESSION },
      { type: "last-prompt", leafUuid: "u", sessionId: SESSION },
      { type: "mode", mode: "normal" },
      { type: "permission-mode", permissionMode: "bypassPermissions" },
      { type: "cost-state", totalCostUSD: 0.2 },
      assistantLine([{ type: "thinking", thinking: "secret thoughts" }]),
      userLine("   ")
    ];

    // Act & Assert
    for (const line of skipped) {
      expect(toEntries(line), JSON.stringify(line).slice(0, 80)).toEqual([]);
    }
    expect(parseEntries(jsonl(...skipped))).toEqual([]);
    expect(
      JSON.stringify(
        parseEntries(
          jsonl(
            assistantLine([
              { type: "thinking", thinking: "secret thoughts" },
              { type: "text", text: "ok" }
            ])
          )
        )
      )
    ).not.toContain("secret thoughts");
  });

  // Both shapes are real: a line carries `interruptedMessageId` most of the time but not always, and neither carries
  // `isMeta`, so without this the notice would upload and read in the Assistant's thread as a message the person
  // typed. Content as an array as well as a string, which is how Claude Code actually writes it.
  it("should skip the notice Claude Code writes where the person interrupted a turn", () => {
    // Arrange
    const notices: unknown[] = [
      userLine("[Request interrupted by user]", { interruptedMessageId: "msg_1" }),
      userLine([{ type: "text", text: "[Request interrupted by user]" }], { interruptedMessageId: "msg_1" }),
      userLine([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      userLine([{ type: "text", text: "  [Request interrupted by user]  " }])
    ];

    // Act & Assert
    for (const line of notices) {
      expect(toEntries(line), JSON.stringify(line).slice(0, 80)).toEqual([]);
    }
    expect(parseEntries(jsonl(...notices))).toEqual([]);
  });

  it("should keep a message that only mentions an interrupt, which the person did type", () => {
    // Act
    const entries = toEntries(userLine("Why did [Request interrupted by user] show up in my thread?"));

    // Assert
    expect(entries).toEqual([expect.objectContaining({ role: "user" })]);
  });

  it("should key an entry by uuid and part index, counting the parts it skipped", () => {
    // Arrange
    const line = assistantLine([
      { type: "thinking", thinking: "x" },
      { type: "text", text: "a" },
      { type: "tool_use", id: "t", name: "Read", input: {} }
    ]);

    // Act & Assert
    expect(toEntries(line).map((e) => e.key)).toEqual([`${line.uuid}:1`, `${line.uuid}:2`]);
    for (const e of toEntries(line)) {
      expect(e.key).toMatch(/^[A-Za-z0-9:_-]+$/);
    }
    expect(toEntries({ ...line, uuid: "not a key!" })).toEqual([]);
  });

  it("should be empty for anything that is not a transcript line at all", () => {
    // Act & Assert
    expect(toEntries(null)).toEqual([]);
    expect(toEntries("a string")).toEqual([]);
    expect(toEntries([userLine("x")])).toEqual([]);
    expect(toEntries(base({ type: "user", message: { role: "user", content: 7 } }))).toEqual([]);
    expect(toEntries(base({ type: "user", isCompactSummary: true, message: { role: "user", content: "   " } }))).toEqual([]);
  });

  it("should link a direct message delivered by the bridge to its agent-hub message id", () => {
    // Arrange
    const envelope = directEnvelope({ id: "1234", body: "can you check the build?", author: { type: "user", owner_name: "Alice" } });

    // Act & Assert
    expect(toEntries(userLine(envelope))[0]?.message_id).toBe("1234");
    expect(toEntries(userLine([{ type: "text", text: envelope }]))[0]?.message_id).toBe("1234");
    expect(toEntries(userLine(`quoted: ${envelope}`))[0]?.message_id).toBeNull();
  });
});

describe("scrub", () => {
  it("should redact content with a secret-shaped string, keeping the tool call identity", () => {
    // Act
    const [user] = parseEntries(jsonl(userLine(`my token is ${fakeSecrets.githubToken}`)));
    const [call] = parseEntries(
      jsonl(assistantLine([{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: `curl -H "x: ${fakeSecrets.jwt}"` } }]))
    );
    // JSON escaping would hide the quote before the value; the raw text is scanned too.
    const [result] = parseEntries(jsonl(userLine([{ type: "tool_result", tool_use_id: "t", content: `config:\n${fakeSecrets.password}` }])));
    const [clean] = parseEntries(jsonl(userLine("nothing to see")));

    // Assert
    expect(user?.redacted).toBe(true);
    expect(Object.keys(user?.content ?? {})).toEqual(["redacted"]);
    expect(String(user?.content.redacted)).toMatch(/gh/);
    expect(JSON.stringify(user)).not.toContain(fakeSecrets.githubToken);
    expect({ id: call?.content.id, name: call?.content.name, redacted: call?.redacted }).toEqual({ id: "toolu_9", name: "Bash", redacted: true });
    expect(call?.content.input).toBeUndefined();
    expect(result?.redacted).toBe(true);
    expect(Object.keys(result?.content ?? {})).toEqual(["redacted"]);
    expect(clean?.redacted).toBe(false);
  });

  it("should truncate content to the byte limit and mark it", () => {
    // Arrange
    const size = (c: unknown) => Buffer.byteLength(JSON.stringify(c));
    const long = `START ${'é"\\😀x'.repeat(20000)}`;

    // Act
    const text = scrub(toEntries(userLine(long))[0] as ScrubbedEntry);
    const output = scrub(toEntries(userLine([{ type: "tool_result", tool_use_id: "t", content: "y".repeat(40000) }]))[0] as ScrubbedEntry);
    const input = { file_path: "/x", content: "z".repeat(40000) };
    const call = scrub(toEntries(assistantLine([{ type: "tool_use", id: "toolu_1", name: "Write", input }]))[0] as ScrubbedEntry);
    const small = scrub(toEntries(userLine("short"))[0] as ScrubbedEntry);

    // Assert
    expect(text.truncated).toBe(true);
    expect(size(text.content)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(size(text.content), "uses nearly all of the limit").toBeGreaterThan(MAX_CONTENT_BYTES - 16);
    expect(long.startsWith(String(text.content.text))).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(String(text.content.text)), "no half surrogate pair").toBe(false);
    expect(output.truncated).toBe(true);
    expect(size(output.content)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(output.content.tool_use_id).toBe("t");
    expect(call.truncated).toBe(true);
    expect(typeof call.content.input).toBe("string");
    expect(JSON.stringify(input).startsWith(String(call.content.input))).toBe(true);
    expect(size(call.content)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(small.truncated).toBe(false);
  });
});

describe("batchItems", () => {
  it("should keep each request under the entry and byte caps", () => {
    // Arrange
    const lines: unknown[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(assistantLine([{ type: "text", text: `${i} ${"w".repeat(12000)}` }]));
    }
    for (let i = 0; i < 150; i++) {
      lines.push(userLine(`small ${i}`));
    }
    const { items } = parseLines(jsonl(...lines));

    // Act
    const batches = batchItems(items, { sid: SESSION });

    // Assert
    expect(batches.flat()).toHaveLength(300);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
      const size = Buffer.byteLength(JSON.stringify({ session_id: SESSION, entries: batch.map((i) => i.entry) }));
      expect(size, `batch of ${size} bytes`).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(batches.length).toBeGreaterThanOrEqual(10);
  });

  it("should be empty when there is nothing to send", () => {
    // Act & Assert
    expect(batchItems([])).toEqual([]);
  });
});

describe("parseLines", () => {
  it("should skip a blank line and one that is not JSON, and report the end of the last complete line", () => {
    // Arrange
    const good = userLine("kept");
    const text = `\n{not json at all\n${JSON.stringify(good)}\n   \n`;

    // Act
    const { items, end } = parseLines(text, { base: 100 });

    // Assert
    expect(items.map((i) => i.entry.key)).toEqual([`${good.uuid}:0`]);
    expect(end).toBe(100 + Buffer.byteLength(text));
  });
});

describe("transcriptOff", () => {
  it("should read the opt-out file and the environment, and setTranscriptOff should write and remove the file", () => {
    // Arrange
    const sid = `off-${++nextSession}`;
    ensureStateDir(sid);

    // Act & Assert
    expect(transcriptOffByEnv({ AGENT_HUB_TRANSCRIPT: " OFF " })).toBe(true);
    expect(transcriptOffByEnv({ AGENT_HUB_TRANSCRIPT: "on" })).toBe(false);
    expect(transcriptOffBySession(sid)).toBe(false);
    setTranscriptOff(sid, true);
    expect(transcriptOffBySession(sid)).toBe(true);
    expect(transcriptOff(sid, {})).toBe(true);
    setTranscriptOff(sid, false);
    expect(transcriptOff(sid, {})).toBe(false);
  });
});

describe("fastForward", () => {
  it("should be null when there is no transcript to skip past", () => {
    // Act & Assert
    expect(fastForward(`ff-${++nextSession}`, { file: null })).toBeNull();
    expect(fastForward(`ff-${++nextSession}`, { file: path.join(home.root, "no-such-transcript.jsonl") })).toBeNull();
  });

  it("should stay at the start of a transcript that has no complete line yet", () => {
    // Arrange
    const sid = `ff-${++nextSession}`;
    ensureStateDir(sid);
    const file = path.join(home.root, `${sid}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(userLine("half a line")).slice(0, 30));

    // Act & Assert
    expect(fastForward(sid, { agentId: "agent-1", file })).toEqual({ agent_id: "agent-1", path: file, offset: 0, floor: 0 });
  });

  it("should keep the agent the saved state already named when it is given none", () => {
    // Arrange
    const sid = `ff-${++nextSession}`;
    ensureStateDir(sid);
    const file = path.join(home.root, `${sid}.jsonl`);
    fs.writeFileSync(file, jsonl(userLine("one")));
    fastForward(sid, { agentId: "agent-9", file });

    // Act
    const state = fastForward(sid, { file });

    // Assert
    expect(state).toEqual({ agent_id: "agent-9", path: file, offset: fs.statSync(file).size, floor: fs.statSync(file).size });
  });
});

type Fixture = {
  sid: string;
  file: string;
  calls: { agentId: string; body: TranscriptBody; opts?: RequestOptions }[];
  failures: number[];
  agentId: string | null;
  env: Env;
  sync: ReturnType<typeof createTranscriptSync>;
  keys: () => string[];
  state: () => unknown;
  log: () => string;
};

// A sync for a fresh session over a fake api that records, or fails, each upload.
function fixture({ backfillBytes, env = {} }: { backfillBytes?: number; env?: Env } = {}): Fixture {
  const sid = `sync-test-${++nextSession}`;
  ensureStateDir(sid);
  const file = path.join(home.root, `${sid}.jsonl`);
  fs.writeFileSync(file, "");
  fs.writeFileSync(statePath(sid, "transcript"), `${file}\n`);
  const calls: Fixture["calls"] = [];
  const failures: number[] = [];
  const api: Pick<Api, "transcript"> = {
    async transcript(agentId: string, body: TranscriptBody, opts?: RequestOptions): Promise<TranscriptResponse> {
      calls.push({ agentId, body, opts });
      const status = failures.shift();
      if (status) {
        throw new ApiError(status, { error: "nope" }, "POST", `/api/agent/${agentId}/transcript`);
      }
      return { accepted: body.entries.length };
    }
  };
  const ctx = {
    sid,
    file,
    calls,
    failures,
    agentId: "agent-1" as string | null,
    env: { ...env } as Env,
    keys: () => calls.flatMap((c) => c.body.entries.map((e) => e.key)),
    state: () => readJson(syncStatePath(sid)),
    log: () => fs.readFileSync(statePath(sid, "log"), "utf8")
  };
  return Object.assign(ctx, {
    sync: createTranscriptSync({ sid, api, agentId: () => ctx.agentId, env: ctx.env, ...(backfillBytes ? { backfillBytes } : {}) })
  });
}

describe("createTranscriptSync", () => {
  it("should upload complete lines, persist the offset, and leave a partial last line for later", async () => {
    // Arrange
    const t = fixture();
    const a = userLine("one");
    const b = assistantLine([{ type: "text", text: "two" }]);
    const c = userLine("three");
    const cText = JSON.stringify(c);
    fs.writeFileSync(t.file, jsonl(a, b) + cText.slice(0, 20));

    // Act & Assert
    expect((await t.sync.tick()).status).toBe("ok");
    expect(t.keys()).toEqual([`${a.uuid}:0`, `${b.uuid}:0`]);
    expect(t.calls[0]?.body.session_id).toBe(t.sid);
    expect(t.state()).toEqual({ agent_id: "agent-1", path: t.file, offset: Buffer.byteLength(jsonl(a, b)), floor: 0 });

    await t.sync.tick();
    expect(t.calls, "nothing new, nothing sent").toHaveLength(1);

    fs.appendFileSync(t.file, `${cText.slice(20)}\n`);
    await t.sync.tick();
    expect(t.calls[1]?.body.entries.map((e) => e.key)).toEqual([`${c.uuid}:0`]);
    expect((t.state() as { offset: number }).offset).toBe(fs.statSync(t.file).size);
  });

  it("should restart the upload for a new agent id, and start again from the beginning of a shrunk transcript", async () => {
    // Arrange
    const t = fixture();
    const a = userLine("one");
    fs.writeFileSync(t.file, jsonl(a));

    // Act
    await t.sync.tick();
    t.agentId = "agent-2";
    await t.sync.tick();

    // Assert
    expect(t.calls.map((c) => [c.agentId, c.body.entries[0]?.key])).toEqual([
      ["agent-1", `${a.uuid}:0`],
      ["agent-2", `${a.uuid}:0`]
    ]);
    expect(t.log()).toMatch(/transcript sync reset \(new agent\)/);

    const fresh = userLine("x");
    fs.writeFileSync(t.file, jsonl(fresh));
    await t.sync.tick();
    expect(t.calls.at(-1)?.body.entries[0]?.key).toBe(`${fresh.uuid}:0`);
    expect(t.log()).toMatch(/transcript shrank/);
  });

  it("should start again when the session moved to a different transcript file", async () => {
    // Arrange
    const t = fixture();
    const first = userLine("in the old file");
    fs.writeFileSync(t.file, jsonl(first));
    await t.sync.tick();
    const moved = path.join(home.root, `${t.sid}-moved.jsonl`);
    const second = userLine("in the new file");
    fs.writeFileSync(moved, jsonl(second));
    fs.writeFileSync(statePath(t.sid, "transcript"), `${moved}\n`);

    // Act
    await t.sync.tick();

    // Assert
    expect(t.log()).toMatch(/transcript sync reset \(new transcript\); starting at byte 0/);
    expect(t.calls.at(-1)?.body.entries[0]?.key).toBe(`${second.uuid}:0`);
  });

  it("should backfill at most the last 2 MB on an agent's first upload, from a line boundary", async () => {
    // Arrange
    const t = fixture({ backfillBytes: 4096 });
    const lines: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(userLine(`line ${i} ${"p".repeat(200)}`));
    }
    fs.writeFileSync(t.file, jsonl(...lines));
    const size = fs.statSync(t.file).size;

    // Act
    await t.sync.tick();

    // Assert
    const { items } = parseLines(fs.readFileSync(t.file));
    const expected = items.filter((i) => i.start >= size - 4096).map((i) => i.entry.key);
    expect(t.keys()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(5);
    expect(expected.length).toBeLessThan(40);
    expect(BACKFILL_BYTES).toBe(2 * 1024 * 1024);
  });

  it("should log and skip a batch refused with 400, and retry a 5xx on the next tick while logging it once", async () => {
    // Arrange
    const t = fixture();
    const a = userLine("bad batch");
    fs.writeFileSync(t.file, jsonl(a));
    t.failures.push(400);

    // Act & Assert
    expect((await t.sync.tick()).status).toBe("ok");
    expect((t.state() as { offset: number }).offset).toBe(fs.statSync(t.file).size);
    expect(t.log()).toMatch(/transcript batch refused, skipping 1 entries/);

    const b = userLine("retry me");
    fs.appendFileSync(t.file, jsonl(b));
    const before = (t.state() as { offset: number }).offset;
    t.failures.push(503, 503);
    expect((await t.sync.tick()).status).toBe("error");
    expect((await t.sync.tick()).status).toBe("error");
    expect((t.state() as { offset: number }).offset).toBe(before);
    expect(t.log().match(/transcript sync failed/g)).toHaveLength(1);
    expect((await t.sync.tick()).status).toBe("ok");
    expect(t.calls.slice(-3).map((c) => c.body.entries[0]?.key)).toEqual(Array(3).fill(`${b.uuid}:0`));
    expect(t.log()).toMatch(/transcript sync recovered/);
    expect((t.state() as { offset: number }).offset).toBe(fs.statSync(t.file).size);
  });

  it("should resend a line split across two batches whole when the second batch fails", async () => {
    // Arrange
    const t = fixture();
    const filler: unknown[] = [];
    for (let i = 0; i < 99; i++) {
      filler.push(userLine(`f${i}`));
    }
    const split = assistantLine([
      { type: "text", text: "part a" },
      { type: "text", text: "part b" }
    ]);
    fs.writeFileSync(t.file, jsonl(...filler, split));
    t.failures.push(0, 500);

    // Act
    await t.sync.tick();

    // Assert
    expect(t.calls[0]?.body.entries).toHaveLength(100);
    expect((t.state() as { offset: number }).offset).toBe(Buffer.byteLength(jsonl(...filler)));
    await t.sync.tick();
    expect(t.calls.at(-1)?.body.entries.map((e) => e.key)).toEqual([`${split.uuid}:0`, `${split.uuid}:1`]);
  });

  it("should pause uploads for a while on a 404, without moving the offset", async () => {
    // Arrange
    const t = fixture();
    fs.writeFileSync(t.file, jsonl(userLine("hello")));
    t.failures.push(404);

    // Act & Assert
    expect((await t.sync.tick()).status).toBe("unavailable");
    expect((t.state() as { offset: number }).offset).toBe(0);
    expect((await t.sync.tick()).status).toBe("paused");
    expect(t.calls).toHaveLength(1);
    expect(t.log()).toMatch(new RegExp(`pausing uploads for ${UNAVAILABLE_PAUSE_MS / 60000} minutes`));
  });

  it("should upload nothing while it is off, and skip that stretch when it is turned back on", async () => {
    // Arrange
    const t = fixture();
    const before = userLine("before");
    fs.writeFileSync(t.file, jsonl(before));

    // Act & Assert
    await t.sync.tick();
    setTranscriptOff(t.sid, true);
    fs.appendFileSync(t.file, jsonl(userLine("while off")));
    expect((await t.sync.tick()).status).toBe("off");
    setTranscriptOff(t.sid, false);
    t.agentId = "agent-2";
    const later = userLine("after");
    fs.appendFileSync(t.file, jsonl(later));
    await t.sync.tick();
    expect(t.keys(), "a new agent does not backfill below the opt-out").toEqual([`${before.uuid}:0`, `${later.uuid}:0`]);

    t.env.AGENT_HUB_TRANSCRIPT = "off";
    fs.appendFileSync(t.file, jsonl(userLine("env off")));
    expect((await t.sync.tick()).status).toBe("off");
    expect(t.calls).toHaveLength(2);
  });

  it("should stop between batches when uploads are turned off part way through", async () => {
    // Arrange
    const t = fixture();
    const lines: unknown[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(userLine(`line ${i}`));
    }
    fs.writeFileSync(t.file, jsonl(...lines));

    // Act: the fake api turns uploads off while the first batch is in flight.
    t.env.AGENT_HUB_TRANSCRIPT = "";
    const sync = createTranscriptSync({
      sid: t.sid,
      api: {
        transcript: async (agentId, body) => {
          t.calls.push({ agentId, body });
          t.env.AGENT_HUB_TRANSCRIPT = "off";
          return { accepted: body.entries.length };
        }
      },
      agentId: "agent-1",
      env: t.env
    });
    const result = await sync.tick();

    // Assert
    expect(result).toEqual({ status: "ok", uploaded: 100 });
    expect(t.calls).toHaveLength(1);
  });

  it("should do nothing without an agent id or a transcript", async () => {
    // Arrange
    const t = fixture();
    t.agentId = null;
    const missing = createTranscriptSync({
      sid: t.sid,
      api: { transcript: async () => ({ accepted: 0 }) },
      agentId: "agent-1",
      resolvePath: () => null,
      env: {}
    });
    const gone = createTranscriptSync({
      sid: t.sid,
      api: { transcript: async () => ({ accepted: 0 }) },
      agentId: "agent-1",
      resolvePath: () => path.join(home.root, "not-there.jsonl"),
      env: {}
    });

    // Act & Assert
    expect(await t.sync.tick()).toEqual({ status: "no-agent", uploaded: 0 });
    expect(await missing.tick()).toEqual({ status: "no-transcript", uploaded: 0 });
    expect(await gone.tick()).toEqual({ status: "no-transcript", uploaded: 0 });
  });

  it("should move the offset past lines that hold nothing to upload", async () => {
    // Arrange
    const t = fixture();
    fs.writeFileSync(t.file, jsonl(userLine("meta", { isMeta: true }), { type: "mode", mode: "normal" }));

    // Act
    const result = await t.sync.tick();

    // Assert
    expect(result).toEqual({ status: "ok", uploaded: 0 });
    expect(t.calls).toHaveLength(0);
    expect((t.state() as { offset: number }).offset).toBe(fs.statSync(t.file).size);
  });

  it("should give the upload the caller's timeout, and otherwise what is left of its deadline", async () => {
    // Arrange
    const t = fixture();
    fs.writeFileSync(t.file, jsonl(userLine("one")));

    // Act
    await t.sync.tick({ timeoutMs: 1234 });
    fs.appendFileSync(t.file, jsonl(userLine("two")));
    await t.sync.tick({ deadline: Date.now() + 60_000 });

    // Assert
    expect(t.calls[0]?.opts).toEqual({ timeoutMs: 1234 });
    expect(t.calls[1]?.opts?.timeoutMs).toBeGreaterThan(50_000);
  });

  it("should start again from the backfill point when the saved state is garbage", async () => {
    // Arrange
    const t = fixture();
    fs.writeFileSync(t.file, jsonl(userLine("one")));
    fs.writeFileSync(syncStatePath(t.sid), "not json at all");

    // Act
    await t.sync.tick();

    // Assert
    expect(t.calls).toHaveLength(1);
    expect(t.state()).toEqual({ agent_id: "agent-1", path: t.file, offset: fs.statSync(t.file).size, floor: 0 });
  });

  it("should pass every batch the service validation and let it ignore duplicates", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    try {
      const api = createApi({ baseUrl: url, devUser: "u-me|Me|me@example.com" });
      const sid = `sync-test-${++nextSession}`;
      const { agent_id: agentId } = await api.register({ session_id: sid, name: sid, name_source: "derived", client_features: [...CLIENT_FEATURES] });
      ensureStateDir(sid);
      const file = path.join(home.root, `${sid}.jsonl`);
      const lines: unknown[] = [];
      for (let i = 0; i < 30; i++) {
        lines.push(
          assistantLine([
            { type: "text", text: "big ".repeat(5000) },
            { type: "tool_use", id: `t${i}`, name: "Write", input: { content: "q".repeat(30000) } }
          ])
        );
        lines.push(userLine([{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }]));
      }
      fs.writeFileSync(file, jsonl(...lines));
      const sync = createTranscriptSync({ sid, api, agentId, env: {}, resolvePath: () => file });

      // Act & Assert
      expect(await sync.tick()).toEqual({ status: "ok", uploaded: 90 });
      expect(hub.transcripts.get(agentId)?.size).toBe(90);
      expect(hub.calls.filter((c) => c.path === `/api/agent/${agentId}/transcript`).length).toBeGreaterThan(1);

      fs.rmSync(syncStatePath(sid));
      await sync.tick();
      expect(hub.transcripts.get(agentId)?.size).toBe(90);
    } finally {
      await hub.close();
    }
  });
});

describe("backfillStart", () => {
  it("should be the start of the file when it is smaller than the budget", () => {
    // Arrange
    const file = path.join(home.root, "small.jsonl");
    fs.writeFileSync(file, jsonl(userLine("one")));

    // Act & Assert
    expect(backfillStart(file, fs.statSync(file).size)).toBe(0);
  });

  it("should be the end of a file whose last stretch holds no line break", () => {
    // Arrange
    const file = path.join(home.root, "one-long-line.jsonl");
    fs.writeFileSync(file, "x".repeat(4096));

    // Act & Assert
    expect(backfillStart(file, 4096, 100)).toBe(4096);
  });
});
