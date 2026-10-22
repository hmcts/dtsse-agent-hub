// Whether Claude Code would hold agent-hub messages, how the person is told, and the `setup inbound` fix,
// against a throwaway HOME with no user settings.
//
// The workspace suite drove `setup inbound` and the held-message warnings through `scripts/agent-hub` as a child
// process. The three bridge cases are in `bridge.test.ts` and the two SessionStart cases in `hooks.test.ts`;
// everything the CLI cases asserted about the file `setup inbound` writes is tested here directly against
// `setupInbound`, and what they asserted about its printed wording is in `cli.test.ts`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import {
  bypassFromArgv,
  bypassFromPsArgs,
  describeInbound,
  inboundAccepted,
  inboundFix,
  RESTART_HINT,
  SETUP_COMMAND,
  settingsFromArgv,
  settingsFromPsArgs,
  setupInbound,
  userSettingsPath
} from "./inbound.ts";
import { writeJson } from "./session.ts";

const DEAD_PID = 999999999;
const ACCEPT = '{"crossSessionInbound":"accept"}';
const BYPASS = "--dangerously-skip-permissions";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
const children: ReturnType<typeof spawn>[] = [];
let nextSession = 0;

beforeAll(() => {
  home = tempClaudeHome({ userSettings: null });
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PID", "AGENT_HUB_CLAUDE_PID", "CLAUDE_PROJECT_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, home.env, { CLAUDE_PROJECT_DIR: home.root });
  delete process.env.CLAUDE_PID;
  delete process.env.AGENT_HUB_CLAUDE_PID;
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

// A stand-in for the Claude process: something alive whose command line carries `args`.
function fakeClaude(...args: string[]): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore" });
  children.push(child);
  const pid = child.pid as number;
  // execve has not necessarily happened yet, and until it has the cmdline is empty.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("setInterval")) {
        return pid;
      }
    } catch {}
  }
  throw new Error(`the fake Claude process ${pid} never exec'd`);
}

function registerSession(sid: string, pid: number, cwd = home.root) {
  writeJson(path.join(home.claude, "sessions", `${pid}.json`), { pid, sessionId: sid, cwd, name: sid, kind: "interactive" });
}

function withUserSettings<T>(value: unknown, fn: () => T): T {
  if (value === undefined) {
    fs.rmSync(userSettings(), { force: true });
  } else {
    fs.writeFileSync(userSettings(), JSON.stringify(value));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(userSettings(), { force: true });
  }
}

function clearSettingsFiles() {
  for (const name of fs.readdirSync(home.claude)) {
    if (name.startsWith("settings.json")) {
      fs.rmSync(path.join(home.claude, name), { recursive: true, force: true });
    }
  }
}

describe("settingsFromArgv", () => {
  it("should read --settings in both forms with the last one winning, and be undefined when there is none", () => {
    // Act & Assert
    expect(settingsFromArgv(["claude", "--settings", ACCEPT, "--foo"])).toBe(ACCEPT);
    expect(settingsFromArgv(["claude", "--settings=a.json", "--settings", "b.json"])).toBe("b.json");
    expect(settingsFromArgv(["claude", "--resume"])).toBeUndefined();
  });
});

describe("settingsFromPsArgs", () => {
  it("should recover inline JSON by matching its braces when ps joined argv with spaces", () => {
    // Act & Assert
    expect(settingsFromPsArgs(`claude --settings {"crossSessionInbound":"accept","env":{"A":"x }"}} --dangerously-skip-permissions`)).toBe(
      '{"crossSessionInbound":"accept","env":{"A":"x }"}}'
    );
  });

  it("should read a file path and be undefined when there is no --settings", () => {
    // Act & Assert
    expect(settingsFromPsArgs("claude --settings .claude/virtual.settings.json --foo")).toBe(".claude/virtual.settings.json");
    expect(settingsFromPsArgs("claude --dangerously-skip-permissions")).toBeUndefined();
  });
});

describe("bypassFromArgv", () => {
  it("should be true for each way of asking for bypass permissions and false otherwise", () => {
    // Act & Assert
    expect(bypassFromArgv(["claude", BYPASS])).toBe(true);
    expect(bypassFromArgv(["claude", "--permission-mode", "bypassPermissions"])).toBe(true);
    expect(bypassFromArgv(["claude", "--permission-mode=bypassPermissions"])).toBe(true);
    expect(bypassFromArgv(["claude", "--permission-mode", "acceptEdits"])).toBe(false);
  });
});

describe("bypassFromPsArgs", () => {
  it("should be true for each way of asking for bypass permissions and false otherwise", () => {
    // Act & Assert
    expect(bypassFromPsArgs("claude --permission-mode bypassPermissions --resume")).toBe(true);
    expect(bypassFromPsArgs("claude --dangerously-skip-permissions")).toBe(true);
    expect(bypassFromPsArgs("claude --permission-mode acceptEdits")).toBe(false);
  });
});

describe("inboundAccepted", () => {
  it("should accept from inline JSON in the Claude process argv whatever the user settings say", () => {
    // Arrange
    const pid = fakeClaude("--settings", ACCEPT);

    // Act
    const result = withUserSettings({ crossSessionInbound: "hold" }, () => inboundAccepted({ claudePid: pid, env: {} }));

    // Assert
    expect(result.accepted).toBe(true);
    expect(result.source).toBe("--settings");
  });

  it("should accept from a --settings file resolved against the session cwd when the flag names a path", () => {
    // Arrange
    const cwd = path.join(home.root, "work");
    fs.mkdirSync(path.join(cwd, "conf"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "conf", "virtual.json"), ACCEPT);
    const sid = `inbound-file-${++nextSession}`;
    const pid = fakeClaude("--settings", "conf/virtual.json");
    registerSession(sid, pid, cwd);

    // Act & Assert
    expect(inboundAccepted({ sid, env: {} }).accepted).toBe(true);
  });

  it("should accept from user settings when --settings does not set it", () => {
    // Arrange
    const pid = fakeClaude("--settings", '{"model":"opus"}');

    // Act
    const result = withUserSettings({ theme: "dark", crossSessionInbound: "accept" }, () => inboundAccepted({ claudePid: pid, env: {} }));

    // Assert
    expect(result).toEqual({ accepted: true, value: "accept", source: userSettings() });
  });

  it("should not accept when nothing sets it or user settings hold", () => {
    // Arrange
    const pid = fakeClaude(BYPASS);

    // Act & Assert
    expect(withUserSettings(undefined, () => inboundAccepted({ claudePid: pid, env: {} })).accepted).toBe(false);
    expect(withUserSettings({ crossSessionInbound: "hold" }, () => inboundAccepted({ claudePid: pid, env: {} })).accepted).toBe(false);
  });

  it("should not accept when a repo setting tightens an accepting --settings", () => {
    // Arrange
    const cwd = path.join(home.root, "repo");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), '{"crossSessionInbound":"refuse"}');
    const sid = `inbound-repo-${++nextSession}`;
    const pid = fakeClaude("--settings", ACCEPT);
    registerSession(sid, pid, cwd);

    // Act & Assert
    expect(inboundAccepted({ sid, env: {} })).toEqual({ accepted: false, value: "refuse", source: path.join(cwd, ".claude", "settings.local.json") });
  });

  it("should hold when unset in bypass-permissions mode, in each way of asking for it", () => {
    // Act & Assert
    for (const args of [[BYPASS], ["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"]]) {
      const result = withUserSettings(undefined, () => inboundAccepted({ claudePid: fakeClaude(...args), env: {} }));
      expect(result.accepted, args.join(" ")).toBe(false);
    }
  });

  it("should be unknown when unset in any other permission mode", () => {
    // Act & Assert
    for (const args of [[], ["--permission-mode", "acceptEdits"], ["--permission-mode=default"]]) {
      const result = withUserSettings(undefined, () => inboundAccepted({ claudePid: fakeClaude(...args), env: {} }));
      expect(result.accepted, args.join(" ") || "no flags").toBeNull();
      expect(result.reason).toMatch(/not set/);
    }
  });

  it("should still not accept an explicit hold or refuse outside bypass-permissions mode", () => {
    // Arrange
    const pid = fakeClaude();

    // Act & Assert
    expect(withUserSettings({ crossSessionInbound: "refuse" }, () => inboundAccepted({ claudePid: pid, env: {} })).accepted).toBe(false);
    expect(inboundAccepted({ claudePid: fakeClaude("--settings", '{"crossSessionInbound":"hold"}'), env: {} }).accepted).toBe(false);
  });

  it("should be unknown when the argv cannot be read, whether or not the user settings accept", () => {
    // Act
    const unset = withUserSettings(undefined, () => inboundAccepted({ claudePid: DEAD_PID, env: {} }));
    const accepting = withUserSettings({ crossSessionInbound: "accept" }, () => inboundAccepted({ claudePid: DEAD_PID, env: {} }));

    // Assert
    expect(unset.accepted).toBeNull();
    expect(unset.reason).toMatch(/could not be read/);
    expect(accepting.accepted).toBeNull();
    expect(accepting.reason).toMatch(/could not be read/);
  });

  it("should be unknown when no Claude process is found for the session", () => {
    // Act & Assert
    expect(inboundAccepted({ sid: `inbound-none-${++nextSession}`, env: {} }).accepted).toBeNull();
  });

  it("should fall back to CLAUDE_PID when the session registry knows no process", () => {
    // Arrange
    const pid = fakeClaude(BYPASS);

    // Act & Assert
    expect(inboundAccepted({ sid: `inbound-env-${++nextSession}`, env: { CLAUDE_PID: String(pid) } }).accepted).toBe(false);
  });

  it("should be unknown when the --settings file named on the command line cannot be read", () => {
    // Arrange
    const pid = fakeClaude("--settings", "no-such-settings.json");

    // Act
    const result = withUserSettings(undefined, () => inboundAccepted({ claudePid: pid, env: {} }));

    // Assert
    expect(result.accepted).toBeNull();
    expect(result.reason).toMatch(/the --settings value of Claude process \d+ could not be read/);
  });
});

describe("describeInbound", () => {
  it("should say messages are delivered as usual when it cannot tell", () => {
    // Act & Assert
    expect(describeInbound({ accepted: null, reason: "no process" })).toBe("unknown (no process); messages are delivered as usual");
  });

  it("should name the source when messages are delivered", () => {
    // Act & Assert
    expect(describeInbound({ accepted: true, value: "accept", source: "/u/settings.json" })).toBe(
      'delivered (crossSessionInbound is "accept" in /u/settings.json)'
    );
  });

  it("should quote the setting and its source when messages are held", () => {
    // Act & Assert
    expect(describeInbound({ accepted: false, value: "hold", source: "/u/settings.json" })).toMatch(
      /^held: crossSessionInbound is "hold" in \/u\/settings\.json, so Claude Code/
    );
  });

  it("should blame bypass permissions when messages are held with nothing set", () => {
    // Act & Assert
    expect(describeInbound({ accepted: false })).toMatch(/^held: crossSessionInbound is not set and the session bypasses permissions, /);
  });
});

describe("inboundFix", () => {
  it("should be null when messages are not held", () => {
    // Act & Assert
    expect(inboundFix({ accepted: true, source: "x" })).toBeNull();
    expect(inboundFix({ accepted: null, reason: "x" })).toBeNull();
  });

  it("should point at the --settings flag when that is what holds them", () => {
    // Act & Assert
    expect(inboundFix({ accepted: false, value: "hold", source: "--settings" })).toBe(
      'change the --settings passed to claude to set "crossSessionInbound": "accept", then restart the session'
    );
  });

  it("should point at the repo settings file when that is what holds them", () => {
    // Act & Assert
    expect(inboundFix({ accepted: false, value: "refuse", source: "/repo/.claude/settings.json" })).toBe(
      'remove "crossSessionInbound" from /repo/.claude/settings.json, then restart the session'
    );
  });

  it("should offer setup inbound when the user settings hold them or nothing is set", () => {
    // Act
    const fix = inboundFix({ accepted: false, source: userSettingsPath() });

    // Assert
    expect(fix).toBe(`run ${SETUP_COMMAND} (adds "crossSessionInbound": "accept" to ${userSettingsPath()}), then ${RESTART_HINT}`);
    expect(inboundFix({ accepted: false })).toBe(fix);
  });
});

describe("setupInbound", () => {
  it("should create the settings file when there is none", () => {
    // Arrange
    clearSettingsFiles();

    // Act
    const result = setupInbound();

    // Assert
    expect(result).toEqual({ file: userSettings(), changed: true, created: true, backup: null, previous: undefined });
    expect(fs.readFileSync(userSettings(), "utf8")).toBe('{\n  "crossSessionInbound": "accept"\n}\n');
    expect(fs.readdirSync(home.claude).filter((n) => n.includes(".bak-"))).toEqual([]);
    clearSettingsFiles();
  });

  it("should merge into existing settings keeping the other keys and the mode, and back the original up", () => {
    // Arrange
    clearSettingsFiles();
    const original = '{"env":{"AGENT_HUB_AUTO_ENABLE":"true"},"crossSessionInbound":"hold","theme":"dark"}';
    fs.writeFileSync(userSettings(), original, { mode: 0o640 });
    fs.chmodSync(userSettings(), 0o640);

    // Act
    const result = setupInbound();

    // Assert
    expect(result.changed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.previous).toBe("hold");
    expect(JSON.parse(fs.readFileSync(userSettings(), "utf8"))).toEqual({
      env: { AGENT_HUB_AUTO_ENABLE: "true" },
      crossSessionInbound: "accept",
      theme: "dark"
    });
    expect(fs.readFileSync(userSettings(), "utf8")).toMatch(/^\{\n {2}"env": \{\n {4}"AGENT_HUB_AUTO_ENABLE"/);
    expect(fs.statSync(userSettings()).mode & 0o777).toBe(0o640);
    const backups = fs.readdirSync(home.claude).filter((n) => /^settings\.json\.bak-\d{8}T\d{6}Z$/.test(n));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(home.claude, backups[0] as string), "utf8")).toBe(original);
    expect(result.backup).toBe(path.join(home.claude, backups[0] as string));

    // Act: a second run has nothing to do.
    const again = setupInbound();

    // Assert
    expect(again).toEqual({ file: userSettings(), changed: false });
    expect(fs.readdirSync(home.claude).filter((n) => n.includes(".bak-"))).toHaveLength(1);
    clearSettingsFiles();
  });

  it("should pick an unused backup name when one already exists for the same second", () => {
    // Arrange
    clearSettingsFiles();
    const now = new Date("2026-10-09T12:00:00.000Z");
    fs.writeFileSync(userSettings(), "{}");
    setupInbound({ now });
    fs.writeFileSync(userSettings(), '{"theme":"dark"}');

    // Act
    const result = setupInbound({ now });

    // Assert
    expect(result.backup).toBe(`${userSettings()}.bak-20261009T120000Z-1`);
    expect(
      fs
        .readdirSync(home.claude)
        .filter((n) => n.includes(".bak-"))
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(["settings.json.bak-20261009T120000Z", "settings.json.bak-20261009T120000Z-1"]);
    clearSettingsFiles();
  });

  it("should write through a symlinked settings file", () => {
    // Arrange
    clearSettingsFiles();
    const real = path.join(home.root, "dotfiles-settings.json");
    fs.writeFileSync(real, '{"model":"opus"}');
    fs.symlinkSync(real, userSettings());

    // Act
    setupInbound();

    // Assert
    expect(fs.lstatSync(userSettings()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({ model: "opus", crossSessionInbound: "accept" });
    clearSettingsFiles();
    fs.rmSync(real);
  });

  it("should refuse settings that are not valid JSON or not an object, leaving them untouched", () => {
    // Act & Assert
    for (const bad of ['{"model": "opus",}', '["not", "an", "object"]']) {
      clearSettingsFiles();
      fs.writeFileSync(userSettings(), bad);
      expect(() => setupInbound()).toThrow(/left alone\. .*"crossSessionInbound": "accept"/);
      expect(fs.readFileSync(userSettings(), "utf8")).toBe(bad);
      expect(fs.readdirSync(home.claude).filter((n) => n.includes(".bak-"))).toEqual([]);
    }
    clearSettingsFiles();
  });

  it("should treat an empty settings file as an empty object", () => {
    // Arrange
    clearSettingsFiles();
    fs.writeFileSync(userSettings(), "  \n");

    // Act
    setupInbound();

    // Assert
    expect(JSON.parse(fs.readFileSync(userSettings(), "utf8"))).toEqual({ crossSessionInbound: "accept" });
    clearSettingsFiles();
  });
});
