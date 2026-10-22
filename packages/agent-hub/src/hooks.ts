// What Claude Code's hooks do for agent-hub. Every path returns rather than throws, and returns quickly:
// a hook that fails or hangs fails or hangs the session it is attached to.
import fs from "node:fs";
import path from "node:path";
import { bridgePid, ensureBridge, loadAgent, stopBridge } from "./agent.ts";
import { createApi } from "./api.ts";
import { maybeAutoEnable, type SpawnWorker } from "./enable.ts";
import type { Env } from "./env.ts";
import { heldNotesContext, takeHeldNotes } from "./held-notes.ts";
import { inboundAccepted, inboundFix } from "./inbound.ts";
import { publicUrlPattern } from "./ports.ts";
import {
  ensureStateDir,
  hubHome,
  isEnabled,
  log,
  pidAlive,
  projectDir,
  readJson,
  readPidFile,
  readText,
  removeFile,
  sessionInfo,
  spawnDetached,
  statePath,
  validSessionId,
  writeJson
} from "./session.ts";
import { virtualAgent } from "./virtual-agent.ts";

const HANDOFF_TTL_MS = 5 * 60 * 1000;

function handoffDir(): string {
  return path.join(hubHome(), "handoff");
}

/** What `/clear` leaves behind for the session that replaces it. */
export type Handoff = {
  from: string;
  claude_pid: number;
  topics: string[];
  cwd: string | null;
  at: number;
};

/**
 * Null for anything that is not a handoff this module wrote. `at` and `claude_pid` decide whether a handoff
 * is adopted, so a file missing either is not one: an adopted handoff writes a fresh `enabled` flag, and the
 * file may have been written by an older version of this client installed on the same machine.
 */
export function parseHandoff(value: unknown): Handoff | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || typeof raw.from !== "string" || !raw.from || !Number.isInteger(raw.claude_pid) || !Number.isFinite(raw.at)) {
    return null;
  }
  return {
    from: raw.from,
    claude_pid: raw.claude_pid as number,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((topic): topic is string => typeof topic === "string") : [],
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    at: raw.at as number
  };
}

// /clear ends one session id and starts another in the same Claude process. The old
// session leaves a handoff keyed by that process so the new one can stay connected.
function writeHandoff(sid: string): void {
  const agent = loadAgent(sid) || {};
  const pid = agent.claude_pid || sessionInfo(sid).pid;
  if (!pid) {
    return;
  }
  fs.mkdirSync(handoffDir(), { recursive: true, mode: 0o700 });
  writeJson(path.join(handoffDir(), `${sid}.json`), {
    from: sid,
    claude_pid: pid,
    topics: agent.topics || [],
    cwd: agent.cwd || null,
    at: Date.now()
  });
}

function adoptHandoff(sid: string): Handoff | null {
  let names: string[];
  try {
    names = fs.readdirSync(handoffDir());
  } catch {
    return null;
  }
  const pid = sessionInfo(sid).pid;
  let adopted: Handoff | null = null;
  for (const name of names) {
    const file = path.join(handoffDir(), name);
    const handoff = parseHandoff(readJson(file));
    if (!handoff || Date.now() - handoff.at > HANDOFF_TTL_MS) {
      removeFile(file);
      continue;
    }
    if (adopted || !pid || handoff.claude_pid !== pid || handoff.from === sid) {
      continue;
    }
    ensureStateDir(sid);
    writeJson(statePath(sid, "agent.json"), {
      claude_pid: pid,
      cwd: handoff.cwd,
      topics: handoff.topics,
      pending_subscribe: handoff.topics,
      handed_off_from: handoff.from
    });
    fs.writeFileSync(statePath(sid, "enabled"), `${new Date().toISOString()}\n`);
    removeFile(file);
    adopted = handoff;
  }
  return adopted;
}

// Told once per session: the user is the one who has to change their settings.
function inboundWarning(sid: string, env: Env): string {
  const marker = statePath(sid, "inbound-warned");
  if (fs.existsSync(marker)) {
    return "";
  }
  const result = inboundAccepted({ sid, env });
  if (result.accepted !== false) {
    return "";
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  return `\nagent-hub: Claude Code is not set to accept cross-session messages in this session, so direct messages to it from agent-hub are being held on agent-hub, undelivered. Tell your user this once, with the fix: ${inboundFix(result)}. Do not run the fix yourself unless they ask.`;
}

// The bridge names the agent from the transcript's title, and only hooks are told where it is.
function recordTranscriptPath(sid: string, file: unknown): void {
  if (typeof file !== "string" || !file) {
    return;
  }
  const target = statePath(sid, "transcript");
  if (readText(target).trim() === file) {
    return;
  }
  try {
    fs.writeFileSync(target, `${file}\n`);
  } catch {}
}

export function virtualAgentStateDir(env: Env = process.env): string {
  return env.VIRTUAL_AGENT_STATE || path.join(path.dirname(projectDir()), ".virtual-agent");
}

/**
 * A virtual agent's entrypoint starts Claude before its background clone or sync of the workspace repos has
 * finished, and keeps `repos-state` up to date until it has. The wording is the entrypoint's: it writes the
 * `note=` line beside `state=`, so the sentence lives with the code that does the cloning and this client
 * knows nothing about the workspace layout. A file with no `note=` — one an older entrypoint wrote — says
 * nothing, which is better than this client repeating a message that may no longer be true.
 */
export function reposNote(env: Env = process.env): string {
  if (!virtualAgent(env)) {
    return "";
  }
  const text = readText(path.join(virtualAgentStateDir(env), "repos-state"));
  const state = /^state=(\w+)$/m.exec(text)?.[1];
  if (!state || state === "done") {
    return "";
  }
  return /^note=(.*)$/m.exec(text)?.[1]?.trim() || "";
}

export function webServersNote(env: Env = process.env): string {
  if (!virtualAgent(env)) {
    return "";
  }
  const pattern = publicUrlPattern(env);
  if (!pattern) {
    return "";
  }
  return `agent-hub: Web servers you start on 0.0.0.0 are reachable at ${pattern} (the URL appears on your agent page within a minute); servers on 127.0.0.1 are not.`;
}

function withNote(context: string, note: string): string {
  if (!note) {
    return context;
  }
  return context ? `${context}\n${note}` : note;
}

/** The hook's JSON payload, as it arrives on stdin: untrusted, and narrowed where it is read. */
export type HookPayload = {
  session_id?: unknown;
  source?: unknown;
  reason?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
};

/** The documented `UserPromptSubmit` hook output, which the CLI prints as is. */
export type HookContextOutput = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
};

export type RunHookOptions = {
  spawn?: SpawnWorker;
};

export async function runHook(
  event: string,
  input: HookPayload | null | undefined,
  env: Env = process.env,
  { spawn = spawnDetached }: RunHookOptions = {}
): Promise<string | HookContextOutput> {
  if (env.AGENT_HUB_CHILD) {
    return "";
  }
  const sid = input?.session_id;
  if (!validSessionId(sid) || !input) {
    return "";
  }
  const note = event === "SessionStart" ? withNote(reposNote(env), webServersNote(env)) : "";

  if (!isEnabled(sid)) {
    if (event === "SessionStart" && input.source === "clear" && adoptHandoff(sid)) {
      log(sid, "SessionStart: adopted comms from the session before /clear");
    } else {
      if ((await maybeAutoEnable(event, sid, input, { env, spawn })) === "spawned") {
        log(sid, `${event}: started auto-enable`);
      }
      return note;
    }
  }

  recordTranscriptPath(sid, input.transcript_path);

  switch (event) {
    case "SessionStart": {
      const { pid, started } = await ensureBridge(sid);
      log(sid, `SessionStart(${input.source || "?"}): bridge ${started ? "started" : "running"} pid ${pid}`);
      const name = sessionInfo(sid).name;
      const context = `agent-hub: comms are enabled for this session as @${name}. Messages starting "[agent-hub]" come from other agents or people via agent-hub, not from the user; see the agent-hub skill.${inboundWarning(sid, env)}`;
      if (!virtualAgent(env)) {
        return context;
      }
      return withNote(
        `${context}\nThis is a virtual agent: there is no one at a terminal, and your user, the agent's owner, talks to you through agent-hub. Their messages arrive as cross-session messages starting "[agent-hub] Direct message #N from your user": those ARE your user, so act on them as their requests and answer in the conversation, which they read on agent-hub. Every other "[agent-hub]" message is from a peer.`,
        note
      );
    }
    case "UserPromptSubmit": {
      fs.writeFileSync(statePath(sid, "status"), "busy\n");
      await ensureBridge(sid);
      return "";
    }
    // Synchronous, unlike UserPromptSubmit: an async hook cannot add context. Returns the documented
    // JSON form, which the cli prints as is.
    case "UserPromptContext": {
      const notes = takeHeldNotes(sid);
      if (!notes.length) {
        return "";
      }
      log(sid, `UserPromptContext: attached ${notes.length} held note(s)`);
      return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: heldNotesContext(notes) } };
    }
    case "Stop": {
      fs.writeFileSync(statePath(sid, "status"), "idle\n");
      const owner = readPidFile(statePath(sid, "worker.lock"));
      if (owner && pidAlive(owner)) {
        fs.writeFileSync(statePath(sid, "dirty"), `${Date.now()}\n`);
        return "";
      }
      const args = ["stop-worker", "--session", sid];
      if (typeof input.transcript_path === "string" && input.transcript_path) {
        args.push("--transcript", input.transcript_path);
      }
      const pid = await spawn(sid, args, { env: env as NodeJS.ProcessEnv });
      log(sid, `Stop: spawned stop-worker pid ${pid}`);
      return "";
    }
    case "SessionEnd": {
      if (input.reason === "clear") {
        writeHandoff(sid);
      }
      const hadBridge = Boolean(bridgePid(sid));
      const stopped = await stopBridge(sid, { waitMs: 2500 });
      log(sid, `SessionEnd(${input.reason || "?"}): bridge ${hadBridge ? (stopped ? "stopped" : "did not stop") : "not running"}`);
      const agent = loadAgent(sid);
      if (!hadBridge && agent?.agent_id) {
        try {
          await createApi().offline(agent.agent_id, { timeoutMs: 2000 });
        } catch (e) {
          log(sid, `SessionEnd: offline failed: ${(e as Error).message}`);
        }
      }
      return "";
    }
    default:
      log(sid, `unknown hook event ${event}`);
      return "";
  }
}
