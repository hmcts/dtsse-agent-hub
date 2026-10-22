// Where a Claude Code session's agent-hub state lives, what Claude Code records about the session, and how a
// detached worker is started. Everything here tolerates unreadable or garbage state and reports it as absent: a
// hook must never fail the session, and these files may have been written by an older version of this client
// installed on the same machine.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./env.ts";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type Config = {
  publish_interval_minutes: number;
  notify_interval_minutes: number;
};

export const DEFAULT_CONFIG: Config = {
  publish_interval_minutes: 1,
  notify_interval_minutes: 1
};

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function hubHome(): string {
  return path.join(claudeHome(), "agent-hub");
}

// The repository the session is working in. Hooks always receive `CLAUDE_PROJECT_DIR`; for every other
// invocation the working directory is the only thing that can stand in, since this package's own location is
// somewhere under `node_modules` and says nothing about the checkout.
export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// The compiled CLI beside this module, as an argv prefix. `./cli.js` is a URL string rather than an import
// specifier, so `rewriteRelativeImportExtensions` leaves it alone and it resolves in `dist/` as written. The
// environment is a parameter because a detached worker must run whichever CLI its own environment names.
export function cliCommand(env: Env = process.env): string[] {
  return [process.execPath, env.AGENT_HUB_CLI_JS || fileURLToPath(new URL("./cli.js", import.meta.url))];
}

export function validSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && SESSION_ID_RE.test(sid);
}

export function stateDir(sid: string): string {
  if (!validSessionId(sid)) {
    throw new Error(`invalid session id: ${JSON.stringify(sid)}`);
  }
  return path.join(hubHome(), sid);
}

export function statePath(sid: string, name: string): string {
  return path.join(stateDir(sid), name);
}

export function ensureStateDir(sid: string): string {
  const dir = stateDir(sid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function isEnabled(sid: unknown): boolean {
  return validSessionId(sid) && fs.existsSync(statePath(sid, "enabled"));
}

// Unknown on purpose: the shape of each state file belongs to the module that writes it, which narrows what it
// reads back. Returns null for a file that is missing, unreadable or not JSON.
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {}
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const LOG_MAX_BYTES = 1024 * 1024;

export function logPath(sid: string): string {
  return statePath(sid, "log");
}

export function rotateLog(sid: string): void {
  const file = logPath(sid);
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {}
}

export function log(sid: string, message: string): void {
  try {
    ensureStateDir(sid);
    fs.appendFileSync(logPath(sid), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {}
}

// ~/.claude/sessions/<pid>.json is undocumented (peerProtocol 1); treat every field as optional.
export type SessionEntry = {
  sessionId?: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  name?: string;
  nameSource?: string;
  messagingSocketPath?: string;
};

export function parseSessionEntry(value: unknown): SessionEntry | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    sessionId: asNonEmptyString(raw.sessionId),
    pid: Number.isInteger(raw.pid) ? (raw.pid as number) : undefined,
    cwd: asNonEmptyString(raw.cwd),
    kind: asNonEmptyString(raw.kind),
    name: asNonEmptyString(raw.name),
    nameSource: asNonEmptyString(raw.nameSource),
    messagingSocketPath: asNonEmptyString(raw.messagingSocketPath)
  };
}

export function findSessionEntry(sid: string): SessionEntry | null {
  const dir = path.join(claudeHome(), "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const entry = parseSessionEntry(readJson(path.join(dir, name)));
    if (entry && entry.sessionId === sid) {
      return entry;
    }
  }
  return null;
}

// Title entries are re-appended throughout a transcript, so the tail holds the current ones.
const TITLE_TAIL_BYTES = 256 * 1024;

// Where Claude Code keeps the transcript of a session run from `cwd`.
export function projectTranscriptPath(cwd: string, sid: string): string {
  return path.join(claudeHome(), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);
}

export function transcriptPath(sid: string, entry: SessionEntry | null = findSessionEntry(sid)): string | null {
  const recorded = readText(statePath(sid, "transcript")).trim();
  if (recorded) {
    return recorded;
  }
  const fromWorker = asRecord(readJson(statePath(sid, "cursors.json")))?.transcript_path;
  if (typeof fromWorker === "string" && fromWorker) {
    return fromWorker;
  }
  if (!entry?.cwd) {
    return null;
  }
  return projectTranscriptPath(entry.cwd, sid);
}

export type ConversationTitles = {
  custom?: string;
  ai?: string;
};

// The latest `custom-title` and `ai-title` entries in the transcript, the title /resume shows.
export function conversationTitles(file: string): ConversationTitles {
  let text: string;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TITLE_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return {};
  }
  const titles: ConversationTitles = {};
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && !(titles.custom && titles.ai); i--) {
    const line = lines[i] ?? "";
    if (!line.includes('-title"')) {
      continue;
    }
    const entry = asRecord(parseJsonText(line));
    if (!entry) {
      continue;
    }
    if (entry.type === "custom-title" && !titles.custom && typeof entry.customTitle === "string") {
      titles.custom = entry.customTitle;
    }
    if (entry.type === "ai-title" && !titles.ai && typeof entry.aiTitle === "string") {
      titles.ai = entry.aiTitle;
    }
  }
  return titles;
}

export function nameSlug(title: string | null | undefined): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

// A /rename wins, then the conversation's title, then the handle Claude Code derived for the session.
export function agentName(sid: string, entry: SessionEntry | null = findSessionEntry(sid)): string {
  if (entry?.nameSource === "user" && entry.name) {
    return entry.name;
  }
  const file = transcriptPath(sid, entry);
  const titles = file ? conversationTitles(file) : {};
  return nameSlug(titles.custom) || nameSlug(titles.ai) || entry?.name || sid.slice(0, 8);
}

export type SessionInfo = {
  pid: number | null;
  name: string;
  cwd: string | null;
  socketPath: string | null;
};

export function sessionInfo(sid: string, env: Env = process.env): SessionInfo {
  const entry = findSessionEntry(sid);
  const envPid = Number.parseInt(env.AGENT_HUB_CLAUDE_PID || "", 10);
  return {
    pid: Number.isInteger(envPid) ? envPid : (entry?.pid ?? null),
    name: agentName(sid, entry),
    cwd: entry?.cwd || null,
    // The token in the environment belongs to the socket in the environment, so that pair wins; the registry
    // path is the fallback for processes started without it.
    socketPath: env.CLAUDE_CODE_MESSAGING_SOCKET || entry?.messagingSocketPath || null
  };
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    return false;
  }
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPidFile(file: string): number | null {
  const pid = Number.parseInt(readText(file), 10);
  return Number.isInteger(pid) ? pid : null;
}

// Exclusive-create pidfile. A file left by a dead process is reclaimed once.
export function acquirePidFile(file: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
      const owner = readPidFile(file);
      if (owner === process.pid) {
        return true;
      }
      if (owner && pidAlive(owner)) {
        return false;
      }
      removeFile(file);
    }
  }
  return false;
}

export function releasePidFile(file: string): void {
  if (readPidFile(file) === process.pid) {
    removeFile(file);
  }
}

// A virtual agent's conversation supervisor starts each conversation's session with the conversation's id in its
// environment, which is what makes that session one of the HMCTS Assistant's conversations rather than the pod's own.
export function conversationId(env: Env = process.env): string | null {
  return env.AGENT_HUB_CONVERSATION_ID || null;
}

export function requireSessionId(env: Env = process.env): string {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (!validSessionId(sid)) {
    throw new Error("CLAUDE_CODE_SESSION_ID is not set. Run this from inside a Claude Code session (the Bash tool exports it).");
  }
  return sid;
}

// Claude Code kills a hook that outlives its timeout together with every descendant it can find, so a
// worker started straight from the hook dies with it, before it has logged anything. A shell in a new
// session backgrounds the worker and exits, which leaves the worker in that session and nobody's child.
const LAUNCHER = 'log=$1; shift; "$@" </dev/null >>"$log" 2>&1 & echo $!';
const LAUNCH_TIMEOUT_MS = 10000;

// `env` is the child's environment, and is also what selects the CLI: a detached worker is a continuation of
// this process and has to run the same one.
export function spawnDetached(sid: string, args: string[], { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  ensureStateDir(sid);
  rotateLog(sid);
  return new Promise((resolve, reject) => {
    const sh = spawn("/bin/sh", ["-c", LAUNCHER, "sh", logPath(sid), ...cliCommand(env), ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: projectDir(),
      env
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => sh.kill("SIGKILL"), LAUNCH_TIMEOUT_MS);
    sh.stdout?.on("data", (d) => {
      out += d;
    });
    sh.stderr?.on("data", (d) => {
      err += d;
    });
    sh.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${args[0]}: ${e.message}`));
    });
    sh.on("close", (code, signal) => {
      clearTimeout(timer);
      const pid = Number.parseInt(out.trim(), 10);
      if (code === 0 && Number.isInteger(pid)) {
        resolve(pid);
      } else {
        reject(new Error(`could not start ${args[0]}: /bin/sh exited ${signal || code}${err.trim() ? `: ${err.trim()}` : ""}`));
      }
    });
  });
}

export function sha256(text: unknown): string {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}
