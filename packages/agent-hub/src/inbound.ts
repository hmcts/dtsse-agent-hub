// Whether Claude Code would hand this session's model a cross-session message, which is how an agent-hub direct
// message arrives, and the `setup inbound` fix when it would not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./env.ts";
import { claudeHome, projectDir, readJson, type SessionInfo, sessionInfo } from "./session.ts";

// The workspace keeps `scripts/agent-hub` as a thin shim onto this package's bin, so the command quoted here is
// the one an engineer has always typed.
export const SETUP_COMMAND = "scripts/agent-hub setup inbound";
export const RESTART_HINT = "restart the session (exit, then claude --resume) if scripts/agent-hub status still says messages are held";

export function userSettingsPath(): string {
  return path.join(claudeHome(), "settings.json");
}

// The last --settings wins, as with any repeated flag; undefined when there is none.
export function settingsFromArgv(argv: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--settings" && i + 1 < argv.length) {
      value = argv[++i];
    } else if (arg.startsWith("--settings=")) {
      value = arg.slice("--settings=".length);
    }
  }
  return value;
}

export function bypassFromArgv(argv: string[]): boolean {
  return argv.some(
    (a, i) =>
      a === "--dangerously-skip-permissions" ||
      a === "--permission-mode=bypassPermissions" ||
      (a === "--permission-mode" && argv[i + 1] === "bypassPermissions")
  );
}

export function bypassFromPsArgs(text: string): boolean {
  return /(?:^|\s)(?:--dangerously-skip-permissions|--permission-mode(?:=|\s+)bypassPermissions)(?=\s|$)/.test(text);
}

// `ps -o args=` joins argv with spaces, so inline JSON is recovered by matching its braces.
export function settingsFromPsArgs(text: string): string | undefined {
  const re = /(?:^|\s)--settings(?:=|\s+)/g;
  let start = -1;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    start = m.index + m[0].length;
    m = re.exec(text);
  }
  if (start === -1) {
    return undefined;
  }
  if (text[start] !== "{") {
    return text.slice(start).split(/\s/)[0];
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

type SettingsArg = {
  found: boolean;
  value?: string | undefined;
  bypass?: boolean;
};

// { found: false } when the process's command line cannot be read at all.
function readSettingsArg(pid: number): SettingsArg {
  if (process.platform === "linux") {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.length && argv[argv.length - 1] === "") {
        argv.pop();
      }
      if (!argv.length) {
        return { found: false };
      }
      return { found: true, value: settingsFromArgv(argv), bypass: bypassFromArgv(argv) };
    } catch {
      return { found: false };
    }
  }
  try {
    const text = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return text ? { found: true, value: settingsFromPsArgs(text), bypass: bypassFromPsArgs(text) } : { found: false };
  } catch {
    return { found: false };
  }
}

function processCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Undefined for a file that is missing, unreadable, not JSON or not an object: none of those set the key.
function settingIn(file: string): unknown {
  return asRecord(readJson(file))?.crossSessionInbound;
}

export type InboundResult = {
  accepted: boolean | null;
  reason?: string;
  value?: unknown;
  source?: string;
};

export type InboundOptions = {
  sid?: string;
  env?: Env;
  claudePid?: number | null;
};

/**
 * Whether Claude Code delivers cross-session messages, so agent-hub's, to this session's model:
 * `accepted` is true, false, or null when it cannot tell. It follows Claude Code's own order,
 * where --settings beats user settings and a repo's settings can only tighten them. Managed
 * settings are not read. Unset, Claude Code holds messages in bypass-permissions mode; in other
 * modes it decides per message, so unset is unknown there.
 */
export function inboundAccepted({ sid, env = process.env, claudePid }: InboundOptions = {}): InboundResult {
  const info: Partial<SessionInfo> = sid ? sessionInfo(sid, env) : {};
  const envPid = Number.parseInt(env.CLAUDE_PID || "", 10);
  const pid = claudePid || info.pid || (Number.isInteger(envPid) ? envPid : null);
  if (!pid) {
    return { accepted: null, reason: "the Claude process for this session was not found" };
  }
  const arg = readSettingsArg(pid);
  if (!arg.found) {
    return { accepted: null, reason: `the command line of Claude process ${pid} could not be read` };
  }
  const cwd = info.cwd || processCwd(pid) || projectDir();

  let value: unknown;
  let source: string | undefined;
  if (arg.value !== undefined) {
    let flag: Record<string, unknown> | null;
    try {
      const text = arg.value.trim();
      flag = asRecord(JSON.parse(text.startsWith("{") ? text : fs.readFileSync(path.resolve(cwd, text), "utf8")));
    } catch {
      return { accepted: null, reason: `the --settings value of Claude process ${pid} could not be read` };
    }
    if (flag?.crossSessionInbound !== undefined) {
      value = flag.crossSessionInbound;
      source = "--settings";
    }
  }
  if (source === undefined) {
    const file = userSettingsPath();
    const user = settingIn(file);
    if (user !== undefined) {
      value = user;
      source = file;
    }
  }
  for (const name of ["settings.local.json", "settings.json"]) {
    const file = path.join(cwd, ".claude", name);
    if (file === userSettingsPath()) {
      continue;
    }
    const repo = settingIn(file);
    if (repo !== undefined && repo !== "accept") {
      return { accepted: false, value: repo, source: file };
    }
  }
  if (value === undefined && !arg.bypass) {
    return { accepted: null, reason: "crossSessionInbound is not set, and outside bypass-permissions mode Claude Code decides per message" };
  }
  return { accepted: value === "accept", value, source };
}

export function describeInbound(result: InboundResult): string {
  if (result.accepted === null) {
    return `unknown (${result.reason}); messages are delivered as usual`;
  }
  if (result.accepted) {
    return `delivered (crossSessionInbound is "accept" in ${result.source})`;
  }
  const setting = result.source
    ? `crossSessionInbound is ${JSON.stringify(result.value)} in ${result.source}`
    : "crossSessionInbound is not set and the session bypasses permissions";
  return `held: ${setting}, so Claude Code would not show agent-hub messages to this session. They wait on agent-hub, undelivered`;
}

export function inboundFix(result: InboundResult): string | null {
  if (result.accepted !== false) {
    return null;
  }
  if (result.source === "--settings") {
    return 'change the --settings passed to claude to set "crossSessionInbound": "accept", then restart the session';
  }
  if (result.source && result.source !== userSettingsPath()) {
    return `remove "crossSessionInbound" from ${result.source}, then restart the session`;
  }
  return `run ${SETUP_COMMAND} (adds "crossSessionInbound": "accept" to ${userSettingsPath()}), then ${RESTART_HINT}`;
}

function backupName(file: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  for (let n = 0; ; n++) {
    const name = `${file}.bak-${stamp}${n ? `-${n}` : ""}`;
    if (!fs.existsSync(name)) {
      return name;
    }
  }
}

export type SetupInboundResult = {
  file: string;
  changed: boolean;
  created?: boolean;
  backup?: string | null;
  previous?: unknown;
};

/**
 * Adds "crossSessionInbound": "accept" to the user's Claude Code settings, keeping every other
 * key. Only ever run on the person's explicit request: it opts every session they run in.
 */
export function setupInbound({ now = new Date() }: { now?: Date } = {}): SetupInboundResult {
  const file = userSettingsPath();
  let target = file;
  let settings: Record<string, unknown> = {};
  let mode = 0o600;
  let exists = false;
  try {
    target = fs.realpathSync(file);
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  if (exists) {
    const text = fs.readFileSync(target, "utf8");
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(
        `${file} is not valid JSON (${(e as Error).message}), so it was left alone. Fix it, or add "crossSessionInbound": "accept" to it by hand.`
      );
    }
    const record = asRecord(parsed);
    if (!record) {
      throw new Error(`${file} does not hold a JSON object, so it was left alone. Add "crossSessionInbound": "accept" to it by hand.`);
    }
    settings = record;
    if (settings.crossSessionInbound === "accept") {
      return { file, changed: false };
    }
    mode = fs.statSync(target).mode & 0o777;
  }
  let backup: string | null = null;
  if (exists) {
    backup = backupName(file, now);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const previous = settings.crossSessionInbound;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...settings, crossSessionInbound: "accept" }, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
  return { file, changed: true, created: !exists, backup, previous };
}
