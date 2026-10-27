// The Claude Code hook entry points, driven in process. The workspace suite drove them through
// `scripts/agent-hub` as a child process; what those cases asserted about the bash gate — that a session which
// never enabled comms never starts node — lives in `bin.test.ts`, and the stdout wording of the CLI's `hook`
// command is in `cli.test.ts`.
//
// Restored here: the three `runHook("UserPromptContext", …)` cases `held-notes.test.ts` points at, the two
// `SessionStart` cases `inbound.test.ts` points at, and what the `runHook` wrapper adds on top of
// `maybeAutoEnable`, which `enable.test.ts` points at.
//
// One case cannot be restored anywhere in this package: "settings run UserPromptContext synchronously beside
// the async UserPromptSubmit hook" read `cft-workspace/.claude/settings.json`, which stays in cft-workspace
// along with the hook wiring it asserts. Part C of the plan relocates it beside that file.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import type { SpawnWorker } from "./enable.ts";
import type { Env } from "./env.ts";
import { HELD_NOTES, holdNote } from "./held-notes.ts";
import { type HookPayload, parseHandoff, reposNote, runHook, virtualAgentStateDir, webServersNote } from "./hooks.ts";
import { ASK_USER_QUESTION, ASKED_REASON, type HookDenyOutput, UNDELIVERED_REASON } from "./questions.ts";
import { ensureStateDir, statePath, writeJson } from "./session.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEAD_PID = 999999999;
const ACCEPT = '{"crossSessionInbound":"accept"}';
const BYPASS = "--dangerously-skip-permissions";
const VIRTUAL_ID = "0f8a6a1e-1234-4000-8000-000000000001";
const VIRTUAL = { AGENT_HUB_VIRTUAL_AGENT_ID: VIRTUAL_ID, AGENT_HUB_LAUNCH_TOKEN: "lt-abc123" };
const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10000 }).status === 0;

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
const children: ReturnType<typeof spawn>[] = [];

beforeAll(() => {
  home = tempClaudeHome({ userSettings: null });
  const noopCli = path.join(home.root, "noop-cli.mjs");
  fs.writeFileSync(noopCli, "");
  for (const key of [
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROJECT_DIR",
    "AGENT_HUB_URL",
    "AGENT_HUB_DEV_USER",
    "AGENT_HUB_CLAUDE_PID",
    "AGENT_HUB_AUTO_ENABLE",
    "AGENT_HUB_CHILD",
    "AGENT_HUB_VIRTUAL_AGENT_ID",
    "AGENT_HUB_LAUNCH_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID",
    "AGENT_HUB_CLI_JS",
    "VIRTUAL_AGENT_STATE",
    "VIRTUAL_AGENT_PUBLIC_DOMAIN"
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The hooks reach `createApi()` and `sessionInfo()` through `process.env`, not the environment they are
  // given, so the unreachable hub and the dead Claude pid have to be set here as well.
  Object.assign(process.env, home.env, {
    CLAUDE_PROJECT_DIR: home.root,
    AGENT_HUB_URL: "http://127.0.0.1:9",
    AGENT_HUB_DEV_USER: "u|n|e",
    AGENT_HUB_CLAUDE_PID: String(DEAD_PID),
    // A bridge this suite lets start must not be the real one: there is no compiled CLI in a test run.
    AGENT_HUB_CLI_JS: noopCli
  });
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

// A stand-in for the Claude process: something alive whose command line carries `args`, in a directory with no
// repository settings of its own.
function fakeClaude(...args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore", cwd: home.root });
  children.push(child);
  return child.pid as number;
}

// Enables comms for a session and gives it a live bridge, so `ensureBridge` finds one rather than spawning.
function enable(sid: string): string {
  const dir = ensureStateDir(sid);
  fs.writeFileSync(path.join(dir, "enabled"), "x");
  fs.writeFileSync(path.join(dir, "bridge.pid"), `${process.pid}\n`);
  return dir;
}

function registry(sid: string, fields: Record<string, unknown> = {}) {
  writeJson(path.join(home.claude, "sessions", `${sid}-${DEAD_PID}.json`), { pid: DEAD_PID, sessionId: sid, cwd: home.root, ...fields });
}

function spawnStub(): { calls: { sid: string; args: string[] }[]; spawn: SpawnWorker } {
  const calls: { sid: string; args: string[] }[] = [];
  const spawn: SpawnWorker = async (sid, args) => {
    calls.push({ sid, args });
    return 4242;
  };
  return { calls, spawn };
}

async function hookText(event: string, input: HookPayload | null, env: Env = {}, spawn?: SpawnWorker): Promise<string> {
  const out = await runHook(event, input, { ...process.env, ...env }, spawn ? { spawn } : {});
  if (typeof out !== "string") {
    throw new Error(`expected text output from ${event}, got JSON`);
  }
  return out;
}

const lines = (text: string) => text.trim().split("\n");

// Mimics the entrypoint, which owns the wording and writes it into `repos-state` beside `state=`.
function reposState(state: string | null, note?: string): Env {
  const dir = path.join(home.root, "virtual-agent-state");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (state) {
    fs.writeFileSync(path.join(dir, "repos-state"), `state=${state}\ndone=12\ntotal=241\n${note === undefined ? "" : `note=${note}\n`}`);
  }
  return { ...VIRTUAL, VIRTUAL_AGENT_STATE: dir };
}

async function virtualStart(sid: string, env: Env): Promise<string[]> {
  enable(sid);
  return lines(await hookText("SessionStart", { session_id: sid, source: "startup" }, env));
}

describe("parseHandoff", () => {
  it("should keep every field the adoption reads when the file is one this module wrote", () => {
    // Arrange
    const written = { from: "old-sess", claude_pid: 4242, topics: ["pcs-api", "civil"], cwd: "/w/pcs", at: 1700000000000 };

    // Act
    const handoff = parseHandoff(written);

    // Assert
    expect(handoff).toEqual(written);
  });

  it("should be null when the file is not a handoff with a source session and a Claude pid", () => {
    // Act & Assert
    expect(parseHandoff(null)).toBeNull();
    expect(parseHandoff(["from", "old"])).toBeNull();
    expect(parseHandoff({ claude_pid: 1, at: 1 })).toBeNull();
    expect(parseHandoff({ from: "", claude_pid: 1, at: 1 })).toBeNull();
    expect(parseHandoff({ from: "old", claude_pid: "1", at: 1 })).toBeNull();
    expect(parseHandoff({ from: "old", claude_pid: 1.5, at: 1 })).toBeNull();
    expect(parseHandoff({ from: "old", claude_pid: 1 })).toBeNull();
    expect(parseHandoff({ from: "old", claude_pid: 1, at: "soon" })).toBeNull();
  });

  it("should drop topics and a cwd that are not what they should be when the file is malformed", () => {
    // Act
    const handoff = parseHandoff({ from: "old", claude_pid: 1, at: 2, topics: ["ok", 7, null], cwd: 9 });

    // Assert
    expect(handoff).toEqual({ from: "old", claude_pid: 1, at: 2, topics: ["ok"], cwd: null });
  });
});

describe("runHook", () => {
  it("should return nothing and write no state when the session never enabled comms", async () => {
    // Act & Assert
    for (const event of ["SessionStart", "UserPromptSubmit", "UserPromptContext", "Stop", "SessionEnd"]) {
      expect(await hookText(event, { session_id: "never-enabled", source: "startup" })).toBe("");
    }
    expect(fs.existsSync(path.join(home.hub, "never-enabled"))).toBe(false);
  });

  it("should return nothing and write no state when the payload has no usable session id", async () => {
    // Arrange
    const listing = () => (fs.existsSync(home.hub) ? fs.readdirSync(home.hub) : []);
    const before = listing();

    // Act & Assert
    for (const input of [null, {}, { session_id: "../../etc" }, { session_id: 5 }] as (HookPayload | null)[]) {
      expect(await hookText("Stop", input)).toBe("");
    }
    expect(listing()).toEqual(before);
  });

  it("should do nothing when it is the nested Haiku session", async () => {
    // Arrange
    const dir = enable("child-sess");

    // Act
    const out = await hookText("UserPromptSubmit", { session_id: "child-sess" }, { AGENT_HUB_CHILD: "1" });

    // Assert
    expect(out).toBe("");
    expect(fs.existsSync(path.join(dir, "status"))).toBe(false);
  });

  it("should mark the session busy then idle and record the dirty flag when a stop worker is already running", async () => {
    // Arrange
    const dir = enable("busy-sess");

    // Act
    const submitted = await hookText("UserPromptSubmit", { session_id: "busy-sess" });

    // Assert
    expect(submitted).toBe("");
    expect(fs.readFileSync(path.join(dir, "status"), "utf8")).toBe("busy\n");

    // Act
    fs.writeFileSync(path.join(dir, "worker.lock"), `${process.pid}\n`);
    const stopped = await hookText("Stop", { session_id: "busy-sess", transcript_path: "/nonexistent" });

    // Assert
    expect(stopped).toBe("");
    expect(fs.readFileSync(path.join(dir, "status"), "utf8")).toBe("idle\n");
    expect(fs.existsSync(path.join(dir, "dirty"))).toBe(true);
  });

  it("should spawn the stop worker with the transcript when no worker holds the lock", async () => {
    // Arrange
    enable("stop-spawn-sess");
    const { calls, spawn } = spawnStub();

    // Act
    const out = await hookText("Stop", { session_id: "stop-spawn-sess", transcript_path: "/w/t.jsonl" }, {}, spawn);

    // Assert
    expect(out).toBe("");
    expect(calls).toEqual([{ sid: "stop-spawn-sess", args: ["stop-worker", "--session", "stop-spawn-sess", "--transcript", "/w/t.jsonl"] }]);
  });

  it("should add one line of context when comms are enabled and SessionStart runs", async () => {
    // Arrange
    enable("start-sess");

    // Act
    const out = await hookText("SessionStart", { session_id: "start-sess", source: "resume" });

    // Assert
    expect(out).toMatch(/^agent-hub: comms are enabled for this session as @start-se\./);
    expect(lines(out)).toHaveLength(1);
  });

  it("should hand comms over to the new session id when /clear restarts it in the same Claude process", async () => {
    // Arrange
    const dir = ensureStateDir("old-sess");
    fs.writeFileSync(path.join(dir, "enabled"), "x");
    writeJson(path.join(dir, "agent.json"), { agent_id: "a-old", claude_pid: DEAD_PID, topics: ["pcs-api"] });

    // Act
    const ended = await hookText("SessionEnd", { session_id: "old-sess", reason: "clear" });

    // Assert
    expect(ended).toBe("");
    expect(fs.existsSync(path.join(home.hub, "handoff", "old-sess.json"))).toBe(true);

    // Act
    const started = await hookText("SessionStart", { session_id: "new-sess", source: "clear" });

    // Assert
    expect(started).toMatch(/comms are enabled/);
    const agent = JSON.parse(fs.readFileSync(path.join(home.hub, "new-sess", "agent.json"), "utf8"));
    expect(agent.pending_subscribe).toEqual(["pcs-api"]);
    expect(agent.handed_off_from).toBe("old-sess");
    expect(fs.existsSync(path.join(home.hub, "new-sess", "enabled"))).toBe(true);
    expect(fs.existsSync(path.join(home.hub, "handoff", "old-sess.json"))).toBe(false);
  });

  it("should not adopt a handoff when it came from a different Claude process", async () => {
    // Arrange
    fs.mkdirSync(path.join(home.hub, "handoff"), { recursive: true });
    fs.writeFileSync(path.join(home.hub, "handoff", "other.json"), JSON.stringify({ from: "other", claude_pid: 12345, topics: [], at: Date.now() }));

    // Act
    const out = await hookText("SessionStart", { session_id: "unrelated-sess", source: "clear" });

    // Assert
    expect(out).toBe("");
    expect(fs.existsSync(path.join(home.hub, "unrelated-sess", "enabled"))).toBe(false);
  });

  it("should tell the model once per session that messages are held and how to fix it, when Claude Code holds them", async () => {
    // Arrange
    const sid = "inbound-hook-held";
    enable(sid);
    const env = { CLAUDE_PID: String(fakeClaude(BYPASS)), AGENT_HUB_CLAUDE_PID: "" };

    // Act
    const first = await hookText("SessionStart", { session_id: sid, source: "startup" }, env);

    // Assert
    expect(first).toMatch(/comms are enabled for this session/);
    expect(first).toMatch(/being held on agent-hub, undelivered\. Tell your user this once, with the fix: run agent-hub setup inbound/);
    expect(first).toMatch(/Do not run the fix yourself unless they ask/);

    // Act
    const second = await hookText("SessionStart", { session_id: sid, source: "resume" }, env);

    // Assert
    expect(second).toMatch(/comms are enabled for this session/);
    expect(second).not.toMatch(/being held/);
  });

  it("should add no warning when Claude Code accepts cross-session messages", async () => {
    // Arrange
    const sid = "inbound-hook-accepted";
    enable(sid);

    // Act
    const out = await hookText(
      "SessionStart",
      { session_id: sid, source: "startup" },
      { CLAUDE_PID: String(fakeClaude("--settings", ACCEPT)), AGENT_HUB_CLAUDE_PID: "" }
    );

    // Assert
    expect(out).toMatch(/comms are enabled/);
    expect(out).not.toMatch(/being held/);
    expect(fs.existsSync(statePath(sid, "inbound-warned"))).toBe(false);
  });

  it("should return the documented UserPromptSubmit JSON once and empty the queue when notes are held", async () => {
    // Arrange
    const sid = "ctx-held";
    enable(sid);
    holdNote(sid, "#50 touches the same table.", Date.UTC(2026, 9, 9));

    // Act
    const out = await runHook("UserPromptContext", { session_id: sid, hook_event_name: "UserPromptSubmit" } as HookPayload, { ...process.env });

    // Assert
    const parsed = JSON.parse(JSON.stringify(out));
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/NOT from the user[\s\S]*#50 touches the same table\./);
    expect(fs.existsSync(statePath(sid, HELD_NOTES))).toBe(false);
    expect(await hookText("UserPromptContext", { session_id: sid })).toBe("");
  });

  it("should return nothing when nothing is held", async () => {
    // Arrange
    const sid = "ctx-empty";
    enable(sid);

    // Act & Assert
    expect(await hookText("UserPromptContext", { session_id: sid })).toBe("");
  });

  it("should leave the queue alone when the session has no comms", async () => {
    // Arrange
    const sid = "ctx-off";
    ensureStateDir(sid);
    holdNote(sid, "left over");

    // Act & Assert
    expect(await hookText("UserPromptContext", { session_id: sid })).toBe("");
    expect(fs.existsSync(statePath(sid, HELD_NOTES))).toBe(true);
  });

  it("should log that it started a background enable and return nothing when auto-enable is on", async () => {
    // Arrange
    registry("auto-on", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act
    const out = await hookText("SessionStart", { session_id: "auto-on", source: "startup" }, { AGENT_HUB_AUTO_ENABLE: "true" }, spawn);

    // Assert
    expect(out).toBe("");
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(statePath("auto-on", "log"), "utf8")).toMatch(/SessionStart: started auto-enable/);
    expect(fs.existsSync(statePath("auto-on", "enabled"))).toBe(false);
  });

  it("should never auto-enable when it is the nested Haiku session", async () => {
    // Arrange
    registry("child-auto", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act
    const out = await hookText("SessionStart", { session_id: "child-auto", source: "startup" }, { AGENT_HUB_AUTO_ENABLE: "true", AGENT_HUB_CHILD: "1" }, spawn);

    // Assert
    expect(out).toBe("");
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home.hub, "child-auto"))).toBe(false);
  });

  it("should log the event and return nothing when the event is not one it handles", async () => {
    // Arrange
    enable("unknown-sess");

    // Act
    const out = await hookText("PostToolUse", { session_id: "unknown-sess" });

    // Assert
    expect(out).toBe("");
    expect(fs.readFileSync(statePath("unknown-sess", "log"), "utf8")).toMatch(/unknown hook event PostToolUse/);
  });
});

describe("runHook in a virtual agent", () => {
  it("should pass on the entrypoint's repos note while the clone is still running", async () => {
    // Arrange
    const env = reposState("cloning", "agent-hub: the workspace repositories are still being cloned in the background.");

    // Act
    const out = await virtualStart("va-cloning", env);

    // Assert
    expect(out).toHaveLength(4);
    expect(out[0]).toMatch(/^agent-hub: comms are enabled/);
    expect(out[1]).toMatch(/^This is a virtual agent/);
    // The wording the workspace's `virtual.test.mjs` pinned: a pod must be told that its owner's directs are
    // its user speaking, not a peer's.
    expect(out[1]).toMatch(/"\[agent-hub\] Direct message #N from your user": those ARE your user/);
    expect(out[2]).toBe("agent-hub: the workspace repositories are still being cloned in the background.");
    expect(out[3]).toMatch(/^agent-hub: Web servers you start on 0\.0\.0\.0/);
  });

  it("should pass on whatever note the entrypoint wrote when the clone failed", async () => {
    // Arrange
    const env = reposState("failed", "agent-hub: the clone finished with failures; see repos.log.");

    // Act
    const out = await virtualStart("va-failed", env);

    // Assert
    expect(out.at(-2)).toBe("agent-hub: the clone finished with failures; see repos.log.");
  });

  it("should say nothing about the repos once they are done, or with no repos-state at all", async () => {
    // Act & Assert
    for (const [sid, state] of [
      ["va-done", "done"],
      ["va-absent", null]
    ] as [string, string | null][]) {
      const out = await virtualStart(sid, reposState(state, "agent-hub: still cloning."));
      expect(out).toHaveLength(3);
      expect(out[1]).toMatch(/^This is a virtual agent/);
      expect(out[2]).toMatch(/^agent-hub: Web servers/);
    }
  });

  // No entrypoint writes a `note=` line today, so this is the message a pod running this package actually gets.
  it.each([
    ["va-no-note", "cloning", /still arriving in the background/],
    ["va-syncing-no-note", "syncing", /still arriving in the background/],
    ["va-failed-no-note", "failed", /finished with failures, so some of them did not arrive/]
  ])("should fall back to a generic note for %s when an entrypoint wrote a repos-state with no note", async (sid, state, expected) => {
    // Act
    const out = await virtualStart(sid, reposState(state));

    // Assert
    expect(out).toHaveLength(4);
    expect(out[2]).toMatch(expected);
    expect(out[3]).toMatch(/^agent-hub: Web servers/);
  });

  it("should keep the fallback free of the layout and the scripts the entrypoint owns", () => {
    // Act
    const arriving = reposNote(reposState("cloning"));
    const failed = reposNote(reposState("failed"));

    // Assert
    for (const note of [arriving, failed]) {
      expect(note).toMatch(/^agent-hub: /);
      expect(note).not.toMatch(/apps\/|libs\/|platops\/|scripts\/|bootstrap|cft-workspace/);
    }
    expect(arriving).toMatch(/wait for it rather than starting a second fetch or sync yourself/);
  });

  it("should say nothing about the repos for a state it does not recognise and has no note for", async () => {
    // Act
    const out = await virtualStart("va-odd-state", reposState("rearranging"));

    // Assert
    expect(out).toHaveLength(3);
    expect(out[2]).toMatch(/^agent-hub: Web servers/);
  });

  it("should put the repos note first when comms are not enabled yet", async () => {
    // Arrange
    const env = reposState("cloning", "agent-hub: the workspace repositories are still being cloned in the background.");

    // Act
    const out = await hookText("SessionStart", { session_id: "va-not-enabled", source: "startup" }, env);

    // Assert
    expect(lines(out)[0]).toBe("agent-hub: the workspace repositories are still being cloned in the background.");
    expect(lines(out)).toHaveLength(2);
  });

  it("should tell Claude the URL its web servers get under the default domain", async () => {
    // Act
    const out = await virtualStart("va-web", reposState(null));

    // Assert
    expect(out.at(-1)).toBe(
      "agent-hub: Web servers you start on 0.0.0.0 are reachable at https://va-0f8a6a1e-<port>.preview.platform.hmcts.net (the URL appears on your agent page within a minute); servers on 127.0.0.1 are not."
    );
  });

  it("should use VIRTUAL_AGENT_PUBLIC_DOMAIN, follow the repos note and come before comms are enabled too", async () => {
    // Arrange
    const env = { ...reposState("cloning", "agent-hub: still cloning."), VIRTUAL_AGENT_PUBLIC_DOMAIN: "example.net" };

    // Act
    const out = await virtualStart("va-web-domain", env);

    // Assert
    expect(out.at(-2)).toBe("agent-hub: still cloning.");
    expect(out.at(-1)).toMatch(/reachable at https:\/\/va-0f8a6a1e-<port>\.example\.net /);

    // Act
    const notEnabled = await hookText("SessionStart", { session_id: "va-web-off", source: "startup" }, env);

    // Assert
    expect(lines(notEnabled)).toHaveLength(2);
    expect(notEnabled).toMatch(/servers on 127\.0\.0\.1 are not\.$/m);
  });

  it("should add neither note when the launch token is missing, whatever repos-state says", async () => {
    // Arrange
    const env: Env = { ...reposState("cloning", "agent-hub: still cloning."), AGENT_HUB_LAUNCH_TOKEN: "" };

    // Act
    const out = await virtualStart("not-virtual", env);
    const notEnabled = await hookText("SessionStart", { session_id: "not-virtual-off", source: "startup" }, env);

    // Assert
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^agent-hub: comms are enabled/);
    expect(notEnabled).toBe("");
  });

  it("should add neither note when the virtual agent id is missing", async () => {
    // Arrange
    const env: Env = { ...reposState("cloning", "agent-hub: still cloning."), AGENT_HUB_VIRTUAL_AGENT_ID: "" };

    // Act & Assert
    expect(reposNote(env)).toBe("");
    expect(webServersNote(env)).toBe("");
    expect(await hookText("SessionStart", { session_id: "not-virtual-web", source: "startup" }, env)).toBe("");
  });
});

describe("runHook in an assistant conversation", () => {
  const CONVERSATION: Env = { ...VIRTUAL, AGENT_HUB_CONVERSATION_ID: "0f8a6a1e-0000-4000-8000-000000000001" };

  it("should record idle and start no stop worker when Stop runs in an assistant conversation", async () => {
    // Arrange
    const dir = enable("conv-stop");
    fs.writeFileSync(path.join(dir, "status"), "busy\n");

    // Act
    const out = await hookText("Stop", { session_id: "conv-stop", transcript_path: "/nonexistent" }, CONVERSATION);

    // Assert
    expect(out).toBe("");
    expect(fs.readFileSync(path.join(dir, "status"), "utf8")).toBe("idle\n");
    const log = fs.existsSync(path.join(dir, "log")) ? fs.readFileSync(path.join(dir, "log"), "utf8") : "";
    expect(log).not.toMatch(/stop-worker/);
    expect(fs.existsSync(path.join(dir, "dirty"))).toBe(false);
  });

  it("should start a stop worker when Stop runs in a session that is not a conversation", async () => {
    // Arrange
    enable("plain-stop");
    const { calls, spawn } = spawnStub();

    // Act
    const out = await hookText("Stop", { session_id: "plain-stop", transcript_path: "/nonexistent" }, {}, spawn);

    // Assert
    expect(out).toBe("");
    expect(calls).toEqual([{ sid: "plain-stop", args: ["stop-worker", "--session", "plain-stop", "--transcript", "/nonexistent"] }]);
    expect(fs.readFileSync(statePath("plain-stop", "log"), "utf8")).toMatch(/Stop: spawned stop-worker pid \d+/);
  });

  it("should give the assistant context, not the virtual agent one, when SessionStart runs in a conversation", async () => {
    // Act
    const out = await virtualStart("conv-start", { ...reposState(null), ...CONVERSATION });

    // Assert
    expect(out[0]).toMatch(/^agent-hub: this session is one conversation of the HMCTS Assistant, connected as @conv-sta\./);
    expect(out[0]).toMatch(/agent-hub artefact get/);
    expect(out.some((l) => /^This is a virtual agent/.test(l))).toBe(false);
  });
});

// AskUserQuestion in a session nobody is sitting at: the question goes to the hub and the tool is denied, so the
// TUI prompt that would hold the session busy for ever is never drawn.
describe("runHook PreToolUse", () => {
  const AGENT = "0f8a6a1e-1234-4000-8000-0000000000aa";
  const CONVERSATION = { AGENT_HUB_CONVERSATION_ID: "0f8a6a1e-1234-4000-8000-0000000000bb" };
  const TOOL_INPUT = {
    questions: [
      {
        question: "Do you prefer red or blue?",
        header: "Color",
        options: [
          { label: "Red", description: "You prefer red." },
          { label: "Blue", description: "You prefer blue." }
        ],
        multiSelect: false
      }
    ]
  };

  function ask(sid: string, overrides: Partial<HookPayload> = {}): HookPayload {
    return { session_id: sid, tool_name: ASK_USER_QUESTION, tool_input: TOOL_INPUT, tool_use_id: "toolu_bdrk_01TNH", ...overrides };
  }

  /** A session that has registered an agent, with no `enabled` flag: the question is denied whatever the comms state. */
  function registered(sid: string, agentId: string | null = AGENT): void {
    ensureStateDir(sid);
    writeJson(statePath(sid, "agent.json"), agentId === null ? { claude_pid: DEAD_PID } : { agent_id: agentId, claude_pid: DEAD_PID });
  }

  /** A fetch that answers 204, as the hub's question route does, and records what it was given. */
  function accepts(): { calls: { url: string; body: unknown }[]; fetchImpl: ReturnType<typeof vi.fn> } {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    return { calls, fetchImpl };
  }

  async function hookJson(input: HookPayload, env: Env): Promise<HookDenyOutput> {
    const out = await runHook("PreToolUse", input, { ...process.env, ...env });
    if (typeof out === "string") {
      throw new Error(`expected a decision from PreToolUse, got ${JSON.stringify(out)}`);
    }
    return out as HookDenyOutput;
  }

  const reason = (out: HookDenyOutput) => out.hookSpecificOutput.permissionDecisionReason;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should put the question on screen and deny the tool when the session is an assistant conversation", async () => {
    // Arrange
    registered("preq-conversation");
    const { calls } = accepts();

    // Act
    const out = await hookJson(ask("preq-conversation"), CONVERSATION);

    // Assert
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:9/api/agent/${AGENT}/question`);
    expect(calls[0]?.body).toEqual({ session_id: "preq-conversation", tool_use_id: "toolu_bdrk_01TNH", questions: TOOL_INPUT.questions });
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reason(out)).toBe(ASKED_REASON);
  });

  it("should put the question on screen and deny the tool when the session is a virtual agent's pod", async () => {
    // Arrange
    registered("preq-pod");
    const { calls } = accepts();

    // Act
    const out = await hookJson(ask("preq-pod"), VIRTUAL);

    // Assert
    expect(calls).toHaveLength(1);
    expect(reason(out)).toBe(ASKED_REASON);
  });

  it("should output nothing and ask nobody when a person is at the keyboard, since they can answer the prompt", async () => {
    // Arrange
    registered("preq-local");
    const { calls } = accepts();

    // Act
    const out = await runHook("PreToolUse", ask("preq-local"), { ...process.env });

    // Assert
    expect(out).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("should output nothing when the tool is not the one that would wait for a keyboard", async () => {
    // Arrange
    registered("preq-other-tool");
    const { calls } = accepts();

    // Act
    const out = await runHook("PreToolUse", ask("preq-other-tool", { tool_name: "Bash", tool_input: { command: "ls" } }), {
      ...process.env,
      ...CONVERSATION
    });

    // Assert
    expect(out).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("should tell the model to ask in words when the question could not be sent", async () => {
    // Arrange
    registered("preq-unreachable");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );

    // Act
    const out = await hookJson(ask("preq-unreachable"), CONVERSATION);

    // Assert
    expect(reason(out)).toBe(UNDELIVERED_REASON);
  });

  it("should tell the model to ask in words when the hub refused the question", async () => {
    // Arrange
    registered("preq-refused");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "no such agent" }, { status: 404 }))
    );

    // Act
    const out = await hookJson(ask("preq-refused"), CONVERSATION);

    // Assert
    expect(reason(out)).toBe(UNDELIVERED_REASON);
  });

  it("should tell the model to ask in words without calling the hub when the session has no agent", async () => {
    // Arrange
    registered("preq-unregistered", null);
    const { calls } = accepts();

    // Act
    const out = await hookJson(ask("preq-unregistered"), CONVERSATION);

    // Assert
    expect(reason(out)).toBe(UNDELIVERED_REASON);
    expect(calls).toHaveLength(0);
  });

  it("should tell the model to ask in words when the payload carries no question it can read", async () => {
    // Arrange
    registered("preq-unreadable");
    const { calls } = accepts();

    // Act & Assert
    for (const payload of [{ tool_input: {} }, { tool_input: "red or blue" }, { tool_use_id: "" }] as Partial<HookPayload>[]) {
      expect(reason(await hookJson(ask("preq-unreadable", payload), CONVERSATION))).toBe(UNDELIVERED_REASON);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("virtualAgentStateDir", () => {
  it("should sit beside the project directory when the pod does not name one", () => {
    // Act & Assert
    expect(virtualAgentStateDir({})).toBe(path.join(path.dirname(home.root), ".virtual-agent"));
    expect(virtualAgentStateDir({ VIRTUAL_AGENT_STATE: "/state" })).toBe("/state");
  });
});

describe("the bash scripts under bash 3.2", () => {
  // Pull first: on a cold cache `docker run` writes its download progress to stderr, which would
  // otherwise read as bash objecting to the script.
  beforeAll(() => {
    if (dockerAvailable) {
      spawnSync("docker", ["pull", "bash:3.2"], { encoding: "utf8", timeout: 120000, stdio: "ignore" });
    }
  }, 130000);

  // macOS still ships bash 3.2, and `bin/agent-hub` runs on every prompt there. Local bash is 5.x, so only a
  // container can prove they parse; `bin.test.ts` covers the local-bash half. The pod runtime is here too
  // because its own suite is run under this image, so a construct bash 3.2 refuses must fail here as well.
  it.skipIf(!dockerAvailable).each(["bin/agent-hub", "bin/virtual-agent-boot", "virtual-agent/entrypoint.sh"])(
    "should parse %s, so it runs on macOS",
    (bin) => {
      // Act
      const result = spawnSync("docker", ["run", "--rm", "-v", `${PACKAGE_ROOT}:/w`, "-w", "/w", "bash:3.2", "bash", "-n", bin], {
        encoding: "utf8",
        timeout: 120000
      });

      // Assert
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  );
});
