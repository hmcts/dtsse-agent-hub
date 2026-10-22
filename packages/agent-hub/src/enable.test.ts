// Turning comms on: the auto-enable gate, the detached worker that does the work, and `enableSession` itself.
//
// The workspace suite drove most of these through `runHook` and through `scripts/agent-hub` as a child process.
// What the hook wrapper adds — returning no output, refusing the nested Haiku session (`AGENT_HUB_CHILD`), and
// logging "started auto-enable" — is in `hooks.test.ts`; the `enable`/`disable` command wording, their exit
// codes, the bridge's refusal without the messaging token, and the two cases that kill a hook's process tree
// and SIGTERM the worker are in `cli.test.ts`, which drives the CLI as a child process. Everything they
// asserted about `maybeAutoEnable`, `runAutoEnable` and `enableSession` is here.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { createMockHub } from "./__fixtures__/mock-hub.ts";
import type { Api, TopicListResponse } from "./api.ts";
import { createApi } from "./api.ts";
import {
  AUTO_ENABLE_RETRY_MS,
  autoEnableOn,
  clearOptOut,
  enableSession,
  isInteractive,
  markOptedOut,
  maybeAutoEnable,
  runAutoEnable,
  waitForSessionEntry
} from "./enable.ts";
import type { Env } from "./env.ts";
import { NO_MESSAGING_TOKEN } from "./socket.ts";

const DEAD_PID = 999999999;
const ON: Env = { AGENT_HUB_AUTO_ENABLE: "true" };

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
let recorderCli: string;

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeAll(() => {
  home = tempClaudeHome();
  setEnv("HOME", home.env.HOME);
  setEnv("CLAUDE_CONFIG_DIR", home.env.CLAUDE_CONFIG_DIR);
  setEnv("CLAUDE_PROJECT_DIR", home.root);
  setEnv("CLAUDE_CODE_MESSAGING_TOKEN", "tok");
  setEnv("CLAUDE_CODE_SESSION_ATTENDED", undefined);
  setEnv("AGENT_HUB_CLAUDE_PID", undefined);
  setEnv("AGENT_HUB_URL", undefined);
  setEnv("AGENT_HUB_DEV_USER", undefined);
  setEnv("AGENT_HUB_LAUNCH_TOKEN", undefined);
  setEnv("AGENT_HUB_VIRTUAL_AGENT_ID", undefined);
  setEnv("AGENT_HUB_AUTO_ENABLE", undefined);
  // A bridge the worker starts must be something harmless that records that it ran.
  recorderCli = path.join(home.root, "cli-recorder.mjs");
  fs.writeFileSync(recorderCli, 'process.stdout.write("worker ran: " + process.argv.slice(2).join(" ") + "\\n");\n');
  setEnv("AGENT_HUB_CLI_JS", recorderCli);
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

function registry(sid: string, fields: Record<string, unknown> = {}) {
  const pid = (fields.pid as number | undefined) ?? DEAD_PID;
  fs.writeFileSync(path.join(home.claude, "sessions", `${sid}-${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: home.root, ...fields }));
}

type SpawnCall = { sid: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } };

function spawnStub() {
  const calls: SpawnCall[] = [];
  const spawn = async (sid: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ sid, args, opts });
    return 4242;
  };
  return { calls, spawn };
}

const stateFile = (sid: string, name: string) => path.join(home.hub, sid, name);

const logOf = (sid: string) => fs.readFileSync(stateFile(sid, "log"), "utf8");

async function until(check: () => boolean, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("autoEnableOn", () => {
  it("should accept true, 1 and yes in any case, and nothing else", () => {
    // Act & Assert
    for (const v of ["true", "TRUE", "True", "1", "yes", "Yes", " yes "]) {
      expect(autoEnableOn({ AGENT_HUB_AUTO_ENABLE: v }), v).toBe(true);
    }
    for (const v of [undefined, "", "false", "0", "no", "on", "truthy"]) {
      expect(autoEnableOn({ AGENT_HUB_AUTO_ENABLE: v }), String(v)).toBe(false);
    }
  });
});

describe("isInteractive", () => {
  it("should believe the registry's kind over the attended environment variable", () => {
    // Arrange
    registry("kind-interactive", { kind: "interactive" });
    registry("kind-headless", { kind: "headless" });

    // Act & Assert
    expect(isInteractive("kind-interactive", { CLAUDE_CODE_SESSION_ATTENDED: "0" })).toBe(true);
    expect(isInteractive("kind-headless", { CLAUDE_CODE_SESSION_ATTENDED: "1" })).toBe(false);
  });
});

describe("maybeAutoEnable", () => {
  it("should do nothing and write no state when auto-enable is off", async () => {
    // Arrange
    registry("off-sess", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act & Assert
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(await maybeAutoEnable(event, "off-sess", { source: "startup" }, { env: {}, spawn })).toBe("off");
    }
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home.hub, "off-sess"))).toBe(false);
  });

  it("should start a background enable for every SessionStart source when it is on and the session is interactive", async () => {
    // Arrange
    registry("on-sess", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act
    for (const source of ["startup", "resume", "clear", "compact"]) {
      expect(await maybeAutoEnable("SessionStart", "on-sess", { source, cwd: "/some/dir" }, { env: ON, spawn }), source).toBe("spawned");
    }

    // Assert
    expect(calls).toHaveLength(4);
    expect(calls[0]?.args).toEqual(["auto-enable", "--session", "on-sess", "--cwd", "/some/dir"]);
    expect(calls[0]?.opts.env).toBe(ON);
    expect(fs.existsSync(stateFile("on-sess", "auto-enable.last"))).toBe(true);
    expect(fs.existsSync(stateFile("on-sess", "enabled"))).toBe(false);
  });

  it("should take the working directory from the session registry when the hook gave none", async () => {
    // Arrange
    registry("no-cwd-sess", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act
    await maybeAutoEnable("SessionStart", "no-cwd-sess", { source: "startup" }, { env: ON, spawn });

    // Assert
    expect(calls[0]?.args).toEqual(["auto-enable", "--session", "no-cwd-sess", "--cwd", home.root]);
  });

  it("should skip a session the registry calls headless, and an unregistered one that is not attended", async () => {
    // Arrange
    registry("headless-sess", { kind: "headless" });
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("SessionStart", "headless-sess", { source: "startup" }, { env: { ...ON, CLAUDE_CODE_SESSION_ATTENDED: "1" }, spawn })).toBe(
      "not-interactive"
    );
    expect(await maybeAutoEnable("SessionStart", "no-entry-sess", { source: "startup" }, { env: ON, spawn })).toBe("not-interactive");
    expect(await maybeAutoEnable("UserPromptSubmit", "no-entry-sess", {}, { env: { ...ON, CLAUDE_CODE_SESSION_ATTENDED: "0" }, spawn })).toBe(
      "not-interactive"
    );
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home.hub, "headless-sess"))).toBe(false);
    expect(fs.existsSync(path.join(home.hub, "no-entry-sess"))).toBe(false);
  });

  it("should treat an attended session with no registry entry as interactive", async () => {
    // Arrange
    const { calls, spawn } = spawnStub();

    // Act
    await maybeAutoEnable("SessionStart", "attended-sess", { source: "startup" }, { env: { ...ON, CLAUDE_CODE_SESSION_ATTENDED: "1" }, spawn });

    // Assert
    expect(calls).toHaveLength(1);
  });

  it("should not apply to any event but SessionStart and UserPromptSubmit", async () => {
    // Arrange
    registry("stop-auto", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("Stop", "stop-auto", {}, { env: ON, spawn })).toBe("not-applicable");
    expect(await maybeAutoEnable("SessionEnd", "stop-auto", {}, { env: ON, spawn })).toBe("not-applicable");
    expect(calls).toHaveLength(0);
  });

  it("should skip a session whose comms are already enabled", async () => {
    // Arrange
    registry("already-sess", { kind: "interactive" });
    fs.mkdirSync(path.join(home.hub, "already-sess"), { recursive: true });
    fs.writeFileSync(stateFile("already-sess", "enabled"), "x\n");
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("SessionStart", "already-sess", { source: "startup" }, { env: ON, spawn })).toBe("enabled");
    expect(calls).toHaveLength(0);
  });

  it("should retry on a prompt no more than once every five minutes after an attempt", async () => {
    // Arrange
    registry("retry-sess", { kind: "interactive" });
    const { calls, spawn } = spawnStub();
    let t = 1_000_000;
    const now = () => t;
    const go = (event: string) => maybeAutoEnable(event, "retry-sess", { source: "startup" }, { env: ON, spawn, now });

    // Act & Assert
    expect(await go("SessionStart")).toBe("spawned");
    t += 60_000;
    expect(await go("UserPromptSubmit")).toBe("too-soon");
    t += AUTO_ENABLE_RETRY_MS - 60_000 - 1;
    expect(await go("UserPromptSubmit")).toBe("too-soon");
    t += 1;
    expect(await go("UserPromptSubmit")).toBe("spawned");
    t += 1000;
    expect(await go("UserPromptSubmit")).toBe("too-soon");
    expect(calls).toHaveLength(2);
  });

  it("should attempt at once on UserPromptSubmit when there is no earlier attempt", async () => {
    // Arrange
    registry("late-sess", { kind: "interactive" });
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("UserPromptSubmit", "late-sess", {}, { env: ON, spawn })).toBe("spawned");
    expect(calls).toHaveLength(1);
  });

  it("should skip an opted-out session, and inherit the opt-out through /clear in the same process", async () => {
    // Arrange
    registry("opt-sess", { kind: "interactive", pid: process.pid });
    markOptedOut("opt-sess");
    const { calls, spawn } = spawnStub();

    // Act
    expect(await maybeAutoEnable("SessionStart", "opt-sess", { source: "resume" }, { env: ON, spawn })).toBe("opted-out");
    expect(await maybeAutoEnable("UserPromptSubmit", "opt-sess", {}, { env: ON, spawn })).toBe("opted-out");
    fs.rmSync(path.join(home.claude, "sessions", `opt-sess-${process.pid}.json`));
    registry("after-clear", { kind: "interactive", pid: process.pid });
    const inherited = await maybeAutoEnable("SessionStart", "after-clear", { source: "clear" }, { env: ON, spawn });

    // Assert
    expect(inherited).toBe("opted-out");
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(stateFile("after-clear", "opted-out"))).toBe(true);
    expect(logOf("after-clear")).toMatch(/auto-enable: skipped, the session before \/clear opted out/);
  });

  it("should not look for an inherited opt-out when the session has no process of its own", async () => {
    // Arrange
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("SessionStart", "clear-no-pid", { source: "clear" }, { env: { ...ON, CLAUDE_CODE_SESSION_ATTENDED: "1" }, spawn })).toBe(
      "spawned"
    );
    expect(calls).toHaveLength(1);
  });

  it("should forget an opt-out left by a process that has gone, and enable the session that replaced it", async () => {
    // Arrange
    registry("dead-opt", { kind: "interactive", pid: DEAD_PID });
    markOptedOut("dead-opt", DEAD_PID);
    clearOptOut("dead-opt", null);
    registry("after-dead", { kind: "interactive", pid: DEAD_PID });
    const { calls, spawn } = spawnStub();

    // Act & Assert
    expect(await maybeAutoEnable("SessionStart", "after-dead", { source: "clear" }, { env: ON, spawn })).toBe("spawned");
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(home.hub, "opted-out", String(DEAD_PID)))).toBe(false);
  });
});

describe("clearOptOut", () => {
  it("should remove both the session's opt-out and the one kept for its process", () => {
    // Arrange
    const sid = "opt-cleared";
    markOptedOut(sid, 4242);

    // Act
    clearOptOut(sid, 4242);

    // Assert
    expect(fs.existsSync(stateFile(sid, "opted-out"))).toBe(false);
    expect(fs.existsSync(path.join(home.hub, "opted-out", "4242"))).toBe(false);
  });
});

describe("waitForSessionEntry", () => {
  it("should give up after the timeout and return the entry once Claude Code writes it", async () => {
    // Arrange
    const sid = "sess-registry-wait";
    const started = Date.now();

    // Act & Assert
    expect(await waitForSessionEntry(sid, { timeoutMs: 200, intervalMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);

    setTimeout(() => {
      fs.writeFileSync(
        path.join(home.claude, "sessions", "424242.json"),
        JSON.stringify({ pid: 424242, sessionId: sid, name: "agent-hub", nameSource: "user" })
      );
    }, 100);
    const entry = await waitForSessionEntry(sid, { timeoutMs: 2000, intervalMs: 20 });
    expect(entry?.name).toBe("agent-hub");
  });
});

describe("enableSession", () => {
  it("should refuse before registering when the messaging token is not set", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    const sid = "no-token-sess";
    registry(sid, { kind: "interactive" });

    try {
      // Act & Assert
      await expect(enableSession(sid, { cwd: home.root, env: { AGENT_HUB_URL: url, AGENT_HUB_DEV_USER: "u-me|Me|me@example.com" } })).rejects.toThrow(
        NO_MESSAGING_TOKEN
      );
      expect(hub.calls.filter((c) => c.path === "/api/agent/register")).toHaveLength(0);
      expect(fs.existsSync(stateFile(sid, "enabled"))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("should register, subscribe, mark the session enabled and start a bridge", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    const sid = "enable-happy";
    registry(sid, { kind: "interactive", name: "enable-happy" });
    const env: Env = {
      AGENT_HUB_URL: url,
      AGENT_HUB_DEV_USER: "u-me|Me Tester|me@example.com",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      AGENT_HUB_CLI_JS: recorderCli
    };

    try {
      // Act
      const done = await enableSession(sid, { cwd: home.root, topics: ["pcs-api"], env, api: createApi({ baseUrl: url, devUser: "u-me|Me|me@example.com" }) });

      // Assert
      expect(done?.subscribed).toEqual(["pcs-api"]);
      expect(done?.started).toBe(true);
      expect(done?.baseUrl).toBe(url);
      expect(fs.readFileSync(stateFile(sid, "status"), "utf8")).toBe("busy\n");
      expect(fs.existsSync(stateFile(sid, "enabled"))).toBe(true);
      expect(logOf(sid)).toMatch(new RegExp(`enabled as .* \\(${done?.agent.agent_id}\\)`));
      await until(() => logOf(sid).includes("worker ran"), "the bridge to run");
      expect(logOf(sid)).toContain(`worker ran: bridge --session ${sid}`);
    } finally {
      await hub.close();
    }
  });

  it("should keep the topics it asked for when the hub answers the subscription without any", async () => {
    // Arrange
    const sid = "enable-no-topics-back";
    registry(sid, { kind: "interactive" });
    const api = {
      baseUrl: "http://hub.test",
      register: async () => ({ agent_id: "a-1", name: "n" }),
      subscribe: async () => ({}) as TopicListResponse
    } as unknown as Api;

    // Act
    const done = await enableSession(sid, {
      cwd: home.root,
      topics: ["ccd"],
      env: { CLAUDE_CODE_MESSAGING_TOKEN: "tok", AGENT_HUB_DEV_USER: "u|n|e", AGENT_HUB_CLI_JS: recorderCli },
      api
    });

    // Assert
    expect(done?.subscribed).toEqual(["ccd"]);
  });

  // The workspace suite drove this through `enableSession` from `agent.test.mjs`; it belongs beside `enableSession`.
  it("should subscribe to no automatic topics when the session is an assistant conversation", async () => {
    // Arrange
    const launchToken = `launch-${"a".repeat(16)}`;
    const hub = createMockHub({ launchTokens: { [launchToken]: { virtualId: "va-assist", owner: { oid: "oid-owner", name: "Olive Owner" } } } });
    const url = await hub.listen();
    const cwd = path.join(home.root, "apps", "pcs", "pcs-api");
    fs.mkdirSync(cwd, { recursive: true });
    // A pod, so no Azure sign-in is wanted: the single predicate needs the agent id as well as the token.
    const env: Env = {
      ...process.env,
      AGENT_HUB_URL: url,
      AGENT_HUB_VIRTUAL_AGENT_ID: "va-assist",
      AGENT_HUB_LAUNCH_TOKEN: launchToken,
      CLAUDE_CODE_MESSAGING_TOKEN: "tok"
    };
    const api = createApi({ baseUrl: url, launchToken });
    registry("topics-plain", { kind: "interactive" });
    registry("topics-conv", { kind: "interactive" });

    try {
      // Act
      const plain = await enableSession("topics-plain", { cwd, env, api, proceed: () => false });
      const conv = await enableSession("topics-conv", {
        cwd,
        env: { ...env, AGENT_HUB_CONVERSATION_ID: "0f8a6a1e-0000-4000-8000-000000000001" },
        api,
        proceed: () => false
      });

      // Assert
      expect(plain).toBeNull();
      expect(conv).toBeNull();
      const subscribes = hub.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/subscriptions"));
      expect(subscribes, "the conversation subscribed to topics").toHaveLength(1);
      expect(subscribes[0]?.body.topics).toContain("pcs");
      expect(JSON.parse(fs.readFileSync(stateFile("topics-conv", "agent.json"), "utf8")).topics).toEqual([]);
    } finally {
      await hub.close();
    }
  });

  it("should return null without enabling the session when proceed says not to", async () => {
    // Arrange
    const sid = "enable-declined";
    registry(sid, { kind: "interactive" });
    const api = {
      baseUrl: "http://hub.test",
      register: async () => ({ agent_id: "a-2", name: "n" }),
      subscribe: async () => ({ topics: [] })
    } as unknown as Api;

    // Act
    const done = await enableSession(sid, {
      cwd: home.root,
      env: { CLAUDE_CODE_MESSAGING_TOKEN: "tok", AGENT_HUB_DEV_USER: "u|n|e" },
      proceed: () => false,
      api
    });

    // Assert
    expect(done).toBeNull();
    expect(fs.existsSync(stateFile(sid, "enabled"))).toBe(false);
    expect(fs.existsSync(stateFile(sid, "agent.json"))).toBe(true);
  });
});

describe("runAutoEnable", () => {
  it("should log one line, write no enabled flag and leave no lock when the enable fails", async () => {
    // Arrange
    registry("fail-sess", { kind: "interactive" });
    setEnv("AGENT_HUB_URL", "http://127.0.0.1:9");
    setEnv("AGENT_HUB_DEV_USER", "u|n|e");

    try {
      // Act
      await runAutoEnable({ sid: "fail-sess", cwd: home.root });
    } finally {
      setEnv("AGENT_HUB_URL", undefined);
      setEnv("AGENT_HUB_DEV_USER", undefined);
    }

    // Assert
    const lines = logOf("fail-sess").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/auto-enable failed/);
    expect(fs.existsSync(stateFile("fail-sess", "enabled"))).toBe(false);
    expect(fs.existsSync(stateFile("fail-sess", "auto-enable.lock"))).toBe(false);
  });

  it("should fail quietly when there is no Azure login", async () => {
    // Arrange
    registry("noaz-sess", { kind: "interactive" });
    const emptyBin = path.join(home.root, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    const savedPath = process.env.PATH;
    process.env.PATH = emptyBin;

    try {
      // Act
      await runAutoEnable({ sid: "noaz-sess", cwd: home.root });
    } finally {
      process.env.PATH = savedPath;
    }

    // Assert
    expect(logOf("noaz-sess")).toMatch(/auto-enable failed.*not logged in to Azure/);
    expect(fs.existsSync(stateFile("noaz-sess", "enabled"))).toBe(false);
  });

  it("should log every way it declines to run", async () => {
    // Arrange
    registry("declines-enabled", { kind: "interactive" });
    fs.mkdirSync(path.join(home.hub, "declines-enabled"), { recursive: true });
    fs.writeFileSync(stateFile("declines-enabled", "enabled"), "x\n");
    registry("declines-opted", { kind: "interactive" });
    markOptedOut("declines-opted");
    registry("declines-locked", { kind: "interactive" });
    fs.mkdirSync(path.join(home.hub, "declines-locked"), { recursive: true });
    fs.writeFileSync(stateFile("declines-locked", "auto-enable.lock"), `${process.ppid}\n`);

    // Act
    await runAutoEnable({ sid: "declines-enabled", cwd: home.root });
    await runAutoEnable({ sid: "declines-opted", cwd: home.root });
    await runAutoEnable({ sid: "declines-locked", cwd: home.root });

    // Assert
    expect(logOf("declines-enabled")).toMatch(/auto-enable: skipped, comms are already enabled/);
    expect(logOf("declines-opted")).toMatch(/auto-enable: skipped, the session opted out/);
    expect(logOf("declines-locked")).toMatch(new RegExp(`auto-enable: skipped, another auto-enable \\(pid ${process.ppid}\\) is running`));
  });

  it("should enable the session, note a missing registry entry and clear the retry marker", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    const sid = "auto-enable-ok";
    setEnv("AGENT_HUB_URL", url);
    setEnv("AGENT_HUB_DEV_USER", "u-me|Me Tester|me@example.com");
    fs.mkdirSync(path.join(home.hub, sid), { recursive: true });
    fs.writeFileSync(stateFile(sid, "auto-enable.last"), `${Date.now()}\n`);

    try {
      // Act
      await runAutoEnable({ sid, cwd: home.root, registryWaitMs: 50 });

      // Assert
      expect(logOf(sid)).toMatch(/auto-enable: no session registry entry yet; registering under the fallback name/);
      expect(logOf(sid)).toMatch(/enabled as /);
      expect(fs.existsSync(stateFile(sid, "enabled"))).toBe(true);
      expect(fs.existsSync(stateFile(sid, "auto-enable.last"))).toBe(false);
      expect(hub.calls.filter((c) => c.path === "/api/agent/register")).toHaveLength(1);
    } finally {
      setEnv("AGENT_HUB_URL", undefined);
      setEnv("AGENT_HUB_DEV_USER", undefined);
      await hub.close();
    }
  });

  it("should say so when the session is enabled or opts out while it is registering", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    setEnv("AGENT_HUB_URL", url);
    setEnv("AGENT_HUB_DEV_USER", "u-me|Me Tester|me@example.com");

    try {
      // Act: both races are won deterministically while the worker waits for a registry entry that never comes.
      const enabling = runAutoEnable({ sid: "race-enabled", cwd: home.root, registryWaitMs: 2000 });
      await until(() => fs.existsSync(stateFile("race-enabled", "auto-enable.lock")), "the worker to take its lock");
      fs.writeFileSync(stateFile("race-enabled", "enabled"), "x\n");
      await enabling;

      const optingOut = runAutoEnable({ sid: "race-opted", cwd: home.root, registryWaitMs: 2000 });
      await until(() => fs.existsSync(stateFile("race-opted", "auto-enable.lock")), "the worker to take its lock");
      markOptedOut("race-opted", null);
      await optingOut;

      // Assert
      expect(logOf("race-enabled")).toMatch(/auto-enable: skipped, comms were enabled while it registered/);
      expect(logOf("race-opted")).toMatch(/auto-enable: skipped, the session opted out while it registered/);
    } finally {
      setEnv("AGENT_HUB_URL", undefined);
      setEnv("AGENT_HUB_DEV_USER", undefined);
      await hub.close();
    }
  });
});
