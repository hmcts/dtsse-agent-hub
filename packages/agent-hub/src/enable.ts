// Turning comms on for a session: by hand, or by itself when `AGENT_HUB_AUTO_ENABLE` is set. Auto-enable runs in
// a detached worker because a hook must return in milliseconds and registering needs a round trip to the hub and,
// on a laptop, an Azure token.
import fs from "node:fs";
import path from "node:path";
import { autoTopics, ensureBridge, type RegisteredAgent, registerAgent } from "./agent.ts";
import { type Api, createApi, requireAzureLogin } from "./api.ts";
import type { Env } from "./env.ts";
import {
  acquirePidFile,
  ensureStateDir,
  findSessionEntry,
  hubHome,
  isEnabled,
  log,
  pidAlive,
  readPidFile,
  readText,
  releasePidFile,
  removeFile,
  type SessionEntry,
  sessionInfo,
  spawnDetached,
  statePath,
  writeJson
} from "./session.ts";
import { NO_MESSAGING_TOKEN } from "./socket.ts";
import { virtualAgent } from "./virtual-agent.ts";

export const AUTO_ENABLE_RETRY_MS = 5 * 60 * 1000;

export function autoEnableOn(env: Env = process.env): boolean {
  return /^(true|1|yes)$/i.test(String(env.AGENT_HUB_AUTO_ENABLE || "").trim());
}

// The registry's `kind` is authoritative; without an entry, only an attended session counts.
export function isInteractive(sid: string, env: Env = process.env): boolean {
  const entry = findSessionEntry(sid);
  if (typeof entry?.kind === "string") {
    return entry.kind === "interactive";
  }
  return env.CLAUDE_CODE_SESSION_ATTENDED === "1";
}

// /clear gives the same Claude process a new session id, so an opt-out is also kept per process.
function optOutPidFile(pid: number): string {
  return path.join(hubHome(), "opted-out", String(pid));
}

export function isOptedOut(sid: string): boolean {
  return fs.existsSync(statePath(sid, "opted-out"));
}

export function markOptedOut(sid: string, pid: number | null = sessionInfo(sid).pid): void {
  ensureStateDir(sid);
  fs.writeFileSync(statePath(sid, "opted-out"), `${new Date().toISOString()}\n`);
  if (!pid) {
    return;
  }
  fs.mkdirSync(path.dirname(optOutPidFile(pid)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(optOutPidFile(pid), `${sid}\n`);
}

export function clearOptOut(sid: string, pid: number | null = sessionInfo(sid).pid): void {
  removeFile(statePath(sid, "opted-out"));
  if (pid) {
    removeFile(optOutPidFile(pid));
  }
}

// A session started by /clear inherits the opt-out of the session it replaced in the same process.
function inheritOptOut(sid: string): boolean {
  const pid = sessionInfo(sid).pid;
  if (!pid) {
    return false;
  }
  const file = optOutPidFile(pid);
  if (!fs.existsSync(file)) {
    return false;
  }
  if (!pidAlive(pid)) {
    removeFile(file);
    return false;
  }
  markOptedOut(sid, pid);
  return true;
}

export type EnableSessionOptions = {
  cwd?: string;
  topics?: string[];
  env?: Env;
  proceed?: () => boolean;
  api?: Api;
};

export type EnableSessionResult = {
  agent: RegisteredAgent;
  subscribed: string[];
  pid: number;
  started: boolean;
  baseUrl: string;
};

/** Null when `proceed` said not to, which is how the auto-enable worker drops out of a race it lost. */
export async function enableSession(
  sid: string,
  { cwd, topics = [], env = process.env, proceed = () => true, api }: EnableSessionOptions = {}
): Promise<EnableSessionResult | null> {
  if (!env.CLAUDE_CODE_MESSAGING_TOKEN) {
    throw new Error(NO_MESSAGING_TOKEN);
  }
  // A pod authenticates with its launch token, so it never needs an Azure sign-in; the token alone is not a pod.
  if (!env.AGENT_HUB_DEV_USER && !virtualAgent(env)) {
    await requireAzureLogin();
  }
  const hub = api ?? createApi();
  const { agent, meta } = await registerAgent(hub, sid, { cwd });
  const wanted = [...new Set([...autoTopics(meta), ...topics])];
  let subscribed = wanted;
  if (wanted.length) {
    subscribed = (await hub.subscribe(agent.agent_id, wanted))?.topics || wanted;
  }
  agent.topics = [...new Set([...(agent.topics || []), ...wanted])];
  writeJson(statePath(sid, "agent.json"), agent);
  if (!proceed()) {
    return null;
  }
  fs.writeFileSync(statePath(sid, "status"), "busy\n");
  fs.writeFileSync(statePath(sid, "enabled"), `${new Date().toISOString()}\n`);
  const { pid, started } = await ensureBridge(sid, { env });
  log(sid, `enabled as ${agent.name} (${agent.agent_id})`);
  return { agent, subscribed, pid, started, baseUrl: hub.baseUrl };
}

/** The hook payload, as it arrives: untrusted JSON, narrowed where it is read. */
export type HookInput = {
  source?: unknown;
  cwd?: unknown;
};

export type AutoEnableOutcome = "off" | "not-applicable" | "enabled" | "opted-out" | "not-interactive" | "too-soon" | "spawned";

/** Starts a detached worker, which is what `spawnDetached` does; a test passes its own. */
export type SpawnWorker = (sid: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => Promise<number>;

export type MaybeAutoEnableOptions = {
  env?: Env;
  spawn?: SpawnWorker;
  now?: () => number;
};

/**
 * Starts a background enable for a SessionStart or UserPromptSubmit hook when auto-enable is on.
 * Returns why it did or didn't, for the log and tests; it never throws for the expected cases.
 */
export async function maybeAutoEnable(
  event: string,
  sid: string,
  input: HookInput,
  { env = process.env, spawn = spawnDetached, now = Date.now }: MaybeAutoEnableOptions = {}
): Promise<AutoEnableOutcome> {
  if (!autoEnableOn(env)) {
    return "off";
  }
  if (event !== "SessionStart" && event !== "UserPromptSubmit") {
    return "not-applicable";
  }
  if (isEnabled(sid)) {
    return "enabled";
  }
  if (isOptedOut(sid)) {
    return "opted-out";
  }
  if (!isInteractive(sid, env)) {
    return "not-interactive";
  }
  if (event === "SessionStart" && input.source === "clear" && inheritOptOut(sid)) {
    log(sid, "auto-enable: skipped, the session before /clear opted out");
    return "opted-out";
  }
  const lastFile = statePath(sid, "auto-enable.last");
  if (event === "UserPromptSubmit") {
    const last = Number.parseInt(readText(lastFile), 10);
    if (Number.isFinite(last) && now() - last < AUTO_ENABLE_RETRY_MS) {
      return "too-soon";
    }
  }
  ensureStateDir(sid);
  fs.writeFileSync(lastFile, `${now()}\n`);
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : sessionInfo(sid, env).cwd;
  const args = ["auto-enable", "--session", sid];
  if (cwd) {
    args.push("--cwd", cwd);
  }
  await spawn(sid, args, { env: env as NodeJS.ProcessEnv });
  return "spawned";
}

export type WaitForSessionEntryOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

// SessionStart runs before Claude Code writes the session's registry entry, which holds the name and the pid.
export async function waitForSessionEntry(sid: string, { timeoutMs = 10000, intervalMs = 250 }: WaitForSessionEntryOptions = {}): Promise<SessionEntry | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = findSessionEntry(sid);
    if (entry?.pid || Date.now() >= deadline) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function skipped(sid: string, why: string): void {
  log(sid, `auto-enable: skipped, ${why}`);
}

export type RunAutoEnableOptions = {
  sid: string;
  cwd?: string;
  env?: Env;
  registryWaitMs?: number;
};

// The detached half of auto-enable. It logs how every attempt ends, so a session log that has
// "started auto-enable" and nothing after it means the worker was killed.
export async function runAutoEnable({
  sid,
  cwd,
  env = process.env,
  registryWaitMs = Number(env.AGENT_HUB_REGISTRY_WAIT_MS) || 10000
}: RunAutoEnableOptions): Promise<void> {
  const lock = statePath(sid, "auto-enable.lock");
  try {
    ensureStateDir(sid);
    if (!acquirePidFile(lock)) {
      return skipped(sid, `another auto-enable (pid ${readPidFile(lock)}) is running`);
    }
    if (isEnabled(sid)) {
      return skipped(sid, "comms are already enabled");
    }
    if (isOptedOut(sid)) {
      return skipped(sid, "the session opted out");
    }
    if (!(await waitForSessionEntry(sid, { timeoutMs: registryWaitMs }))) {
      log(sid, "auto-enable: no session registry entry yet; registering under the fallback name");
    }
    const done = await enableSession(sid, { cwd, env, proceed: () => !isOptedOut(sid) && !isEnabled(sid) });
    if (done) {
      removeFile(statePath(sid, "auto-enable.last"));
    } else {
      skipped(sid, isOptedOut(sid) ? "the session opted out while it registered" : "comms were enabled while it registered");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(sid, `auto-enable failed, retrying on a prompt after ${AUTO_ENABLE_RETRY_MS / 60000} minutes: ${message.replace(/\s+/g, " ").trim()}`);
  } finally {
    releasePidFile(lock);
  }
}
