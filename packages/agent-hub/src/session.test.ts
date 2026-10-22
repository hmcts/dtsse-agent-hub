import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import {
  acquirePidFile,
  agentName,
  claudeHome,
  cliCommand,
  conversationTitles,
  DEFAULT_CONFIG,
  ensureStateDir,
  findSessionEntry,
  hubHome,
  isEnabled,
  log,
  logPath,
  nameSlug,
  parseSessionEntry,
  pidAlive,
  projectDir,
  readJson,
  readPidFile,
  readText,
  releasePidFile,
  removeFile,
  requireSessionId,
  rotateLog,
  sessionInfo,
  sha256,
  spawnDetached,
  stateDir,
  statePath,
  transcriptPath,
  validSessionId,
  writeJson
} from "./session.ts";

const DEAD_PID = 999999999;

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

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
  setEnv("CLAUDE_PROJECT_DIR", undefined);
  setEnv("AGENT_HUB_CLI_JS", undefined);
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

function registry(sid: string, fields: Record<string, unknown>) {
  fs.writeFileSync(path.join(home.claude, "sessions", `${sid}.json`), JSON.stringify({ pid: 1, sessionId: sid, ...fields }));
}

function transcript(file: string, entries: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function tmpFile(name: string) {
  return path.join(home.root, name);
}

describe("claudeHome", () => {
  it("should use CLAUDE_CONFIG_DIR when it is set", () => {
    expect(claudeHome()).toBe(home.claude);
  });

  it("should fall back to .claude in the home directory when it is not set", () => {
    setEnv("CLAUDE_CONFIG_DIR", undefined);
    try {
      expect(claudeHome()).toBe(path.join(home.root, ".claude"));
      expect(claudeHome()).toBe(path.join(os.homedir(), ".claude"));
    } finally {
      setEnv("CLAUDE_CONFIG_DIR", home.env.CLAUDE_CONFIG_DIR);
    }
  });
});

describe("hubHome", () => {
  it("should be the agent-hub directory under the claude home", () => {
    expect(hubHome()).toBe(path.join(home.claude, "agent-hub"));
    expect(hubHome()).toBe(home.hub);
  });
});

describe("projectDir", () => {
  it("should use CLAUDE_PROJECT_DIR when the hook supplied it", () => {
    setEnv("CLAUDE_PROJECT_DIR", "/work/cft-workspace");
    try {
      expect(projectDir()).toBe("/work/cft-workspace");
    } finally {
      setEnv("CLAUDE_PROJECT_DIR", undefined);
    }
  });

  // This package is installed under node_modules, so its own location says nothing about the checkout.
  it("should fall back to the working directory, not this package's location, when it is not set", () => {
    expect(projectDir()).toBe(process.cwd());
    expect(projectDir()).not.toContain("node_modules");
  });
});

describe("cliCommand", () => {
  it("should run the compiled cli beside this module by default", () => {
    const expected = fileURLToPath(new URL("./cli.js", import.meta.url));
    expect(cliCommand({})).toEqual([process.execPath, expected]);
    expect(expected).toBe(path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js"));
  });

  it("should run AGENT_HUB_CLI_JS when the environment names one", () => {
    expect(cliCommand({ AGENT_HUB_CLI_JS: "/opt/other/cli.js" })).toEqual([process.execPath, "/opt/other/cli.js"]);
  });
});

describe("validSessionId", () => {
  it("should accept a session id of up to 128 word characters and dashes", () => {
    expect(validSessionId("abc")).toBe(true);
    expect(validSessionId("A-b_c-123")).toBe(true);
    expect(validSessionId("x".repeat(128))).toBe(true);
  });

  it("should reject an id that is empty, too long, or carries a path separator", () => {
    expect(validSessionId("")).toBe(false);
    expect(validSessionId("x".repeat(129))).toBe(false);
    expect(validSessionId("../escape")).toBe(false);
    expect(validSessionId("a/b")).toBe(false);
    expect(validSessionId("a.b")).toBe(false);
  });

  it("should reject anything that is not a string", () => {
    expect(validSessionId(undefined)).toBe(false);
    expect(validSessionId(null)).toBe(false);
    expect(validSessionId(42)).toBe(false);
    expect(validSessionId({})).toBe(false);
  });
});

describe("stateDir", () => {
  it("should be the session's directory under the hub home", () => {
    expect(stateDir("sess-1")).toBe(path.join(home.hub, "sess-1"));
  });

  it("should throw naming the id when it is not a valid session id", () => {
    expect(() => stateDir("../escape")).toThrow('invalid session id: "../escape"');
  });
});

describe("statePath", () => {
  it("should be a named file in the session's directory", () => {
    expect(statePath("sess-1", "enabled")).toBe(path.join(home.hub, "sess-1", "enabled"));
  });

  it("should throw when the id is not a valid session id", () => {
    expect(() => statePath("a/b", "enabled")).toThrow("invalid session id");
  });
});

describe("ensureStateDir", () => {
  it("should create the directory private to its owner and give its path back", () => {
    const dir = ensureStateDir("sess-mkdir");
    expect(dir).toBe(path.join(home.hub, "sess-mkdir"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("should be a no-op when the directory already exists", () => {
    ensureStateDir("sess-mkdir-twice");
    expect(() => ensureStateDir("sess-mkdir-twice")).not.toThrow();
  });
});

describe("isEnabled", () => {
  it("should be false when the session has no enabled marker", () => {
    ensureStateDir("sess-enabled");
    expect(isEnabled("sess-enabled")).toBe(false);
  });

  it("should be true once the enabled marker is written", () => {
    ensureStateDir("sess-enabled-2");
    fs.writeFileSync(statePath("sess-enabled-2", "enabled"), "x");
    expect(isEnabled("sess-enabled-2")).toBe(true);
  });

  it("should be false rather than throw when the id is not a valid session id", () => {
    expect(isEnabled("../escape")).toBe(false);
    expect(isEnabled(undefined)).toBe(false);
  });
});

describe("readJson", () => {
  it("should parse the file when it holds JSON", () => {
    const file = tmpFile("read.json");
    fs.writeFileSync(file, '{"a":1}');
    expect(readJson(file)).toEqual({ a: 1 });
  });

  it("should be null when the file is missing", () => {
    expect(readJson(tmpFile("absent.json"))).toBeNull();
  });

  it("should be null rather than throw when an older client left garbage behind", () => {
    const file = tmpFile("garbage.json");
    fs.writeFileSync(file, "{not json");
    expect(readJson(file)).toBeNull();
  });

  it("should be null when the path is a directory", () => {
    expect(readJson(home.claude)).toBeNull();
  });
});

describe("writeJson", () => {
  it("should write pretty JSON with a trailing newline, readable only by its owner", () => {
    const file = tmpFile("written.json");
    writeJson(file, { b: 2 });
    expect(fs.readFileSync(file, "utf8")).toBe('{\n  "b": 2\n}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readJson(file)).toEqual({ b: 2 });
  });

  it("should leave no temporary file behind, so a reader never sees a half-written file", () => {
    const file = tmpFile("atomic.json");
    writeJson(file, { c: 3 });
    expect(fs.existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("should replace the previous contents", () => {
    const file = tmpFile("replaced.json");
    writeJson(file, { first: true });
    writeJson(file, { second: true });
    expect(readJson(file)).toEqual({ second: true });
  });
});

describe("readText", () => {
  it("should give the file's contents with surrounding whitespace removed", () => {
    const file = tmpFile("text");
    fs.writeFileSync(file, "  hello\n\n");
    expect(readText(file)).toBe("hello");
  });

  it("should be the empty string when the file is missing", () => {
    expect(readText(tmpFile("no-text"))).toBe("");
  });
});

describe("removeFile", () => {
  it("should delete the file", () => {
    const file = tmpFile("doomed");
    fs.writeFileSync(file, "x");
    removeFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("should do nothing when the file is already gone", () => {
    expect(() => removeFile(tmpFile("never-existed"))).not.toThrow();
  });
});

describe("logPath", () => {
  it("should be the log file in the session's directory", () => {
    expect(logPath("sess-log")).toBe(path.join(home.hub, "sess-log", "log"));
  });
});

describe("rotateLog", () => {
  it("should move the log aside once it passes a megabyte", () => {
    const sid = "sess-rotate";
    ensureStateDir(sid);
    fs.writeFileSync(logPath(sid), "x".repeat(1024 * 1024 + 1));
    rotateLog(sid);
    expect(fs.existsSync(logPath(sid))).toBe(false);
    expect(fs.statSync(`${logPath(sid)}.1`).size).toBe(1024 * 1024 + 1);
  });

  it("should leave a log that is still under a megabyte alone", () => {
    const sid = "sess-rotate-small";
    ensureStateDir(sid);
    fs.writeFileSync(logPath(sid), "small");
    rotateLog(sid);
    expect(readText(logPath(sid))).toBe("small");
    expect(fs.existsSync(`${logPath(sid)}.1`)).toBe(false);
  });

  it("should do nothing when there is no log yet", () => {
    expect(() => rotateLog("sess-rotate-absent")).not.toThrow();
  });
});

describe("log", () => {
  it("should append a timestamped line with the writing process's id", () => {
    const sid = "sess-logging";
    log(sid, "first");
    log(sid, "second");
    const lines = fs.readFileSync(logPath(sid), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z \\[${process.pid}\\] first$`));
    expect(lines[1]).toContain("second");
  });

  it("should swallow the failure rather than fail the hook when the id is unusable", () => {
    expect(() => log("../escape", "nope")).not.toThrow();
  });
});

describe("parseSessionEntry", () => {
  it("should keep the fields it understands", () => {
    expect(parseSessionEntry({ sessionId: "s", pid: 7, cwd: "/w", kind: "interactive", name: "n", nameSource: "user", messagingSocketPath: "/sock" })).toEqual({
      sessionId: "s",
      pid: 7,
      cwd: "/w",
      kind: "interactive",
      name: "n",
      nameSource: "user",
      messagingSocketPath: "/sock"
    });
  });

  it("should drop a field whose type the registry got wrong, rather than throw", () => {
    expect(parseSessionEntry({ sessionId: "s", pid: "7", cwd: 5, name: "" })).toEqual({
      sessionId: "s",
      pid: undefined,
      cwd: undefined,
      name: undefined,
      nameSource: undefined,
      messagingSocketPath: undefined
    });
  });

  it("should be null when the value is not an object", () => {
    expect(parseSessionEntry(null)).toBeNull();
    expect(parseSessionEntry("x")).toBeNull();
    expect(parseSessionEntry(3)).toBeNull();
    expect(parseSessionEntry([{ sessionId: "s" }])).toBeNull();
  });
});

describe("findSessionEntry", () => {
  it("should find the registry entry whose sessionId matches", () => {
    registry("sess-find", { name: "hmcts-a1", cwd: "/w/a" });
    expect(findSessionEntry("sess-find")).toMatchObject({ sessionId: "sess-find", name: "hmcts-a1", cwd: "/w/a", pid: 1 });
  });

  it("should be null when no entry names the session", () => {
    expect(findSessionEntry("sess-unregistered")).toBeNull();
  });

  it("should ignore files that are not JSON entries", () => {
    fs.writeFileSync(path.join(home.claude, "sessions", "notes.txt"), "ignore me");
    fs.writeFileSync(path.join(home.claude, "sessions", "broken.json"), "{not json");
    registry("sess-after-junk", { name: "hmcts-b2" });
    expect(findSessionEntry("sess-after-junk")).toMatchObject({ name: "hmcts-b2" });
  });

  it("should be null when there is no sessions directory", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    setEnv("CLAUDE_CONFIG_DIR", path.join(home.root, "no-such-claude"));
    try {
      expect(findSessionEntry("sess-find")).toBeNull();
    } finally {
      setEnv("CLAUDE_CONFIG_DIR", previous);
    }
  });
});

describe("transcriptPath", () => {
  it("should use what a hook recorded, then the worker cursor, then the registry cwd", () => {
    const sid = "sess-transcript";
    registry(sid, { name: "hmcts-x", cwd: "/w/x" });
    expect(transcriptPath(sid)).toBe(path.join(home.claude, "projects", "-w-x", `${sid}.jsonl`));

    ensureStateDir(sid);
    fs.writeFileSync(statePath(sid, "cursors.json"), JSON.stringify({ transcript_path: "/from/worker.jsonl" }));
    expect(transcriptPath(sid)).toBe("/from/worker.jsonl");

    fs.writeFileSync(statePath(sid, "transcript"), "/from/hook.jsonl\n");
    expect(transcriptPath(sid)).toBe("/from/hook.jsonl");
  });

  it("should ignore a cursor file whose transcript_path is missing or not a string", () => {
    const sid = "sess-transcript-bad-cursor";
    registry(sid, { cwd: "/w/y" });
    ensureStateDir(sid);
    fs.writeFileSync(statePath(sid, "cursors.json"), JSON.stringify({ transcript_path: 7 }));
    expect(transcriptPath(sid)).toBe(path.join(home.claude, "projects", "-w-y", `${sid}.jsonl`));
    fs.writeFileSync(statePath(sid, "cursors.json"), "{not json");
    expect(transcriptPath(sid)).toBe(path.join(home.claude, "projects", "-w-y", `${sid}.jsonl`));
  });

  it("should be null when nothing says where the transcript is", () => {
    expect(transcriptPath("sess-nowhere")).toBeNull();
    expect(transcriptPath("sess-nowhere", { sessionId: "sess-nowhere" })).toBeNull();
  });
});

describe("conversationTitles", () => {
  it("should read the latest custom and ai titles from the tail", () => {
    const file = tmpFile("titles.jsonl");
    transcript(file, [
      { type: "ai-title", aiTitle: "old title" },
      { type: "user", message: { content: 'hello "ai-title" in text' } },
      { type: "custom-title", customTitle: "my conversation" },
      { type: "ai-title", aiTitle: "new title" }
    ]);
    expect(conversationTitles(file)).toEqual({ ai: "new title", custom: "my conversation" });
  });

  it("should be empty when the file is missing", () => {
    expect(conversationTitles(tmpFile("missing.jsonl"))).toEqual({});
  });

  it("should ignore a title entry whose field is absent or the wrong type", () => {
    const file = tmpFile("titles-bad.jsonl");
    transcript(file, [{ type: "custom-title", customTitle: 7 }, { type: "ai-title" }, { type: "ai-title", aiTitle: "kept" }]);
    expect(conversationTitles(file)).toEqual({ ai: "kept" });
  });

  it("should skip a line that mentions a title but is not JSON", () => {
    const file = tmpFile("titles-unparseable.jsonl");
    fs.writeFileSync(file, `{broken "ai-title"\n${JSON.stringify({ type: "ai-title", aiTitle: "parsed" })}\n`);
    expect(conversationTitles(file)).toEqual({ ai: "parsed" });
  });

  it("should read only the tail, so a title from the start of a long transcript is not used", () => {
    const file = tmpFile("titles-long.jsonl");
    const padding = `${JSON.stringify({ type: "user", message: { content: "x".repeat(200) } })}\n`.repeat(1600);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: "ai-title", aiTitle: "buried" })}\n${padding}${JSON.stringify({ type: "custom-title", customTitle: "Near The End" })}\n`
    );
    expect(fs.statSync(file).size).toBeGreaterThan(256 * 1024);
    expect(conversationTitles(file)).toEqual({ custom: "Near The End" });
  });
});

describe("nameSlug", () => {
  it("should turn a title into an addressable handle", () => {
    expect(nameSlug("dtsse-agent-hub redesign")).toBe("dtsse-agent-hub-redesign");
    expect(nameSlug("  Fix PCS: make-order (v2)!  ")).toBe("fix-pcs-make-order-v2");
    expect(nameSlug("")).toBe("");
    expect(nameSlug("x".repeat(80))).toHaveLength(64);
  });

  it("should be empty when there is no title", () => {
    expect(nameSlug(null)).toBe("");
    expect(nameSlug(undefined)).toBe("");
  });

  it("should not end in a dash left by the length cut", () => {
    expect(nameSlug(`${"a".repeat(63)} tail`)).toBe("a".repeat(63));
  });
});

describe("agentName", () => {
  const cwd = "/work/cft-workspace";
  const file = (sid: string) => path.join(home.claude, "projects", "-work-cft-workspace", `${sid}.jsonl`);

  it("should prefer a /rename, then the custom title, then the ai title, then the derived handle", () => {
    registry("renamed", { name: "agent-hub", nameSource: "user", cwd });
    transcript(file("renamed"), [{ type: "ai-title", aiTitle: "something else" }]);
    expect(agentName("renamed")).toBe("agent-hub");

    registry("custom", { name: "hmcts-a1", nameSource: "derived", cwd });
    transcript(file("custom"), [
      { type: "ai-title", aiTitle: "ai one" },
      { type: "custom-title", customTitle: "Custom One" }
    ]);
    expect(agentName("custom")).toBe("custom-one");

    registry("titled", { name: "hmcts-da", nameSource: "derived", cwd });
    transcript(file("titled"), [{ type: "ai-title", aiTitle: "dtsse-agent-hub redesign" }]);
    expect(agentName("titled")).toBe("dtsse-agent-hub-redesign");

    registry("untitled", { name: "hmcts-6f", nameSource: "derived", cwd });
    expect(agentName("untitled")).toBe("hmcts-6f");

    expect(agentName("0123456789-unregistered")).toBe("01234567");
  });

  it("should fall back to the first eight characters of the id when the registry says nothing usable", () => {
    registry("nameless-session-id", { cwd: "/w/nameless" });
    expect(agentName("nameless-session-id")).toBe("nameless");
  });
});

describe("sessionInfo", () => {
  it("should take the Claude process id from the environment when the launcher exported it", () => {
    registry("sess-info", { pid: 1234, name: "hmcts-i1", cwd: "/w/i", messagingSocketPath: "/sock/registry" });
    expect(sessionInfo("sess-info", { AGENT_HUB_CLAUDE_PID: "4321" })).toEqual({
      pid: 4321,
      name: "hmcts-i1",
      cwd: "/w/i",
      socketPath: "/sock/registry"
    });
  });

  it("should fall back to the registry's process id and socket", () => {
    registry("sess-info-2", { pid: 1234, name: "hmcts-i2", cwd: "/w/i2", messagingSocketPath: "/sock/registry" });
    expect(sessionInfo("sess-info-2", {})).toMatchObject({ pid: 1234, socketPath: "/sock/registry" });
  });

  it("should prefer the socket in the environment, because the token beside it belongs to that socket", () => {
    registry("sess-info-3", { pid: 1, name: "hmcts-i3", cwd: "/w/i3", messagingSocketPath: "/sock/registry" });
    expect(sessionInfo("sess-info-3", { CLAUDE_CODE_MESSAGING_SOCKET: "/sock/env" }).socketPath).toBe("/sock/env");
  });

  it("should report nulls when the session is not in the registry", () => {
    expect(sessionInfo("sess-info-absent", {})).toEqual({ pid: null, name: "sess-inf", cwd: null, socketPath: null });
  });

  it("should ignore an environment process id that is not a number", () => {
    registry("sess-info-4", { pid: 99, cwd: "/w/i4" });
    expect(sessionInfo("sess-info-4", { AGENT_HUB_CLAUDE_PID: "not-a-pid" }).pid).toBe(99);
  });
});

describe("pidAlive", () => {
  it("should be true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  // Signalling pid 1 fails with EPERM for an unprivileged process, which still means it is running.
  it("should be true for a process this one may not signal", () => {
    expect(pidAlive(1)).toBe(true);
  });

  it("should be false for a process id nothing is using", () => {
    expect(pidAlive(DEAD_PID)).toBe(false);
  });

  it("should be false for anything that is not a positive integer", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(null)).toBe(false);
    expect(pidAlive(undefined)).toBe(false);
  });
});

describe("readPidFile", () => {
  it("should read the process id the file holds", () => {
    const file = tmpFile("pid-1");
    fs.writeFileSync(file, "4242\n");
    expect(readPidFile(file)).toBe(4242);
  });

  it("should be null when the file is missing or holds no number", () => {
    expect(readPidFile(tmpFile("pid-absent"))).toBeNull();
    const file = tmpFile("pid-garbage");
    fs.writeFileSync(file, "not a pid\n");
    expect(readPidFile(file)).toBeNull();
  });
});

describe("acquirePidFile", () => {
  it("should create the file and claim it for this process", () => {
    const file = tmpFile("lock-fresh");
    expect(acquirePidFile(file)).toBe(true);
    expect(readPidFile(file)).toBe(process.pid);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("should still succeed when this process already holds it", () => {
    const file = tmpFile("lock-mine");
    acquirePidFile(file);
    expect(acquirePidFile(file)).toBe(true);
  });

  it("should refuse when a live process holds it", () => {
    const file = tmpFile("lock-held");
    fs.writeFileSync(file, "1\n");
    expect(acquirePidFile(file)).toBe(false);
    expect(readPidFile(file)).toBe(1);
  });

  it("should reclaim a file left behind by a dead process", () => {
    const file = tmpFile("lock-stale");
    fs.writeFileSync(file, `${DEAD_PID}\n`);
    expect(acquirePidFile(file)).toBe(true);
    expect(readPidFile(file)).toBe(process.pid);
  });

  it("should reclaim a file that holds no process id at all", () => {
    const file = tmpFile("lock-empty");
    fs.writeFileSync(file, "\n");
    expect(acquirePidFile(file)).toBe(true);
    expect(readPidFile(file)).toBe(process.pid);
  });

  it("should throw when the failure is not a file that already exists", () => {
    expect(() => acquirePidFile(path.join(home.root, "no-such-dir", "lock"))).toThrow(/ENOENT/);
  });
});

describe("releasePidFile", () => {
  it("should remove the file when this process holds it", () => {
    const file = tmpFile("release-mine");
    acquirePidFile(file);
    releasePidFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("should leave a file another process holds alone", () => {
    const file = tmpFile("release-theirs");
    fs.writeFileSync(file, `${DEAD_PID}\n`);
    releasePidFile(file);
    expect(readPidFile(file)).toBe(DEAD_PID);
  });
});

describe("requireSessionId", () => {
  it("should give the session id the Bash tool exported", () => {
    expect(requireSessionId({ CLAUDE_CODE_SESSION_ID: "sess-required" })).toBe("sess-required");
  });

  it("should say where the session id comes from when it is absent or invalid", () => {
    expect(() => requireSessionId({})).toThrow("CLAUDE_CODE_SESSION_ID is not set. Run this from inside a Claude Code session (the Bash tool exports it).");
    expect(() => requireSessionId({ CLAUDE_CODE_SESSION_ID: "a/b" })).toThrow("CLAUDE_CODE_SESSION_ID is not set");
  });

  it("should read the process environment when none is passed", () => {
    setEnv("CLAUDE_CODE_SESSION_ID", "sess-from-process");
    try {
      expect(requireSessionId()).toBe("sess-from-process");
    } finally {
      setEnv("CLAUDE_CODE_SESSION_ID", undefined);
    }
  });
});

describe("spawnDetached", () => {
  function recorderCli(name: string) {
    const file = tmpFile(`${name}.mjs`);
    fs.writeFileSync(file, 'process.stdout.write("worker ran: " + process.argv.slice(2).join(" ") + "\\n");\n');
    return file;
  }

  async function waitForLog(sid: string, match: RegExp) {
    for (let i = 0; i < 100; i++) {
      if (match.test(readText(logPath(sid)))) {
        return readText(logPath(sid));
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`log never matched ${match}: ${JSON.stringify(readText(logPath(sid)))}`);
  }

  it("should start the worker detached and resolve its process id", async () => {
    const sid = "sess-spawn";
    const pid = await spawnDetached(sid, ["bridge", "--once"], { env: { ...process.env, AGENT_HUB_CLI_JS: recorderCli("recorder") } });
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    await expect(waitForLog(sid, /worker ran/)).resolves.toContain("worker ran: bridge --once");
  });

  it("should run whichever cli its own environment names, so a worker matches the process that started it", async () => {
    const sid = "sess-spawn-cli";
    await spawnDetached(sid, ["stop-worker"], { env: { ...process.env, AGENT_HUB_CLI_JS: recorderCli("other-recorder") } });
    await expect(waitForLog(sid, /worker ran/)).resolves.toContain("worker ran: stop-worker");
  });

  it("should reject naming the command when the worker cannot be started", async () => {
    setEnv("CLAUDE_PROJECT_DIR", path.join(home.root, "no-such-project"));
    try {
      await expect(spawnDetached("sess-spawn-fail", ["bridge"], { env: { ...process.env } })).rejects.toThrow("could not start bridge:");
    } finally {
      setEnv("CLAUDE_PROJECT_DIR", undefined);
    }
  });
});

describe("sha256", () => {
  it("should be the hex digest of the value's string form", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(123)).toBe(sha256("123"));
  });
});

describe("DEFAULT_CONFIG", () => {
  it("should publish and notify once a minute until the hub says otherwise", () => {
    expect(DEFAULT_CONFIG).toEqual({ publish_interval_minutes: 1, notify_interval_minutes: 1 });
  });
});
