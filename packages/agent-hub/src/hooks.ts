// What Claude Code's hooks do for agent-hub. Every path returns rather than throws, and returns quickly:
// a hook that fails or hangs fails or hangs the session it is attached to.
import fs from "node:fs";
import path from "node:path";
import { bridgePid, ensureBridge, loadAgent, stopBridge } from "./agent.ts";
import { createApi } from "./api.ts";
import { maybeAutoEnable, type SpawnWorker } from "./enable.ts";
import type { Env } from "./env.ts";
import { CLI } from "./envelope.ts";
import { heldNotesContext, takeHeldNotes } from "./held-notes.ts";
import { inboundAccepted, inboundFix } from "./inbound.ts";
import { publicUrlPattern } from "./ports.ts";
import { ASK_USER_QUESTION, ASKED_REASON, denyOutput, type HookDenyOutput, parseQuestions, UNDELIVERED_REASON } from "./questions.ts";
import {
  conversationId,
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

// Said when `repos-state` names a state but carries no `note=` line. Deliberately generic: this package knows
// nothing about the workspace layout or the entrypoint's scripts, so it names no directory and no command, and
// says only what a session has to know — that a repository it cannot find may still be on its way or may have
// failed to arrive, and that nothing is gained by starting a second fetch.
const REPOS_ARRIVING =
  "agent-hub: this agent's repositories are still arriving in the background, so one you cannot find may simply not have arrived yet. Something is already fetching them: wait for it rather than starting a second fetch or sync yourself.";
const REPOS_FAILED =
  "agent-hub: the background fetch of this agent's repositories finished with failures, so some of them did not arrive. A repository you cannot find may be one of those, rather than one that does not exist.";
const REPOS_FALLBACK: Record<string, string> = { cloning: REPOS_ARRIVING, syncing: REPOS_ARRIVING, failed: REPOS_FAILED };

/**
 * A virtual agent's entrypoint starts Claude before its background clone or sync of the workspace repos has
 * finished, and keeps `repos-state` up to date until it has. The entrypoint owns the wording when it writes a
 * `note=` line beside `state=`, so the sentence can live with the code that does the cloning; an entrypoint
 * that writes only `state=` gets the generic fallback above, because a session told nothing goes looking for
 * repositories that have not arrived and starts a second sync of its own.
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
  return /^note=(.*)$/m.exec(text)?.[1]?.trim() || REPOS_FALLBACK[state] || "";
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
  /** `PreToolUse` only. */
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
};

/** The documented `UserPromptSubmit` hook output, which the CLI prints as is. */
export type HookContextOutput = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
};

export type HookOutput = HookContextOutput | HookDenyOutput;

export type RunHookOptions = {
  spawn?: SpawnWorker;
};

/** How long the question POST is given. Short: the model is waiting on this hook before its turn can end. */
const QUESTION_TIMEOUT_MS = 5000;

/**
 * `AskUserQuestion` in a session nobody is sitting at — an Assistant conversation, or a virtual agent's pod — where
 * the tool's prompt would wait for a keyboard that does not exist, holding the session `busy` for ever and the
 * conversation's slot with it. The question goes to the hub for the person to answer as an ordinary message, and the
 * tool is denied so the prompt is never drawn.
 *
 * Every refusal path still denies. Letting the tool run is what hangs the session, so there is no fail-open: a
 * question that could not be put on screen is denied with the reason that tells the model to ask in words instead.
 */
async function askUserQuestion(sid: string, input: HookPayload, env: Env): Promise<string | HookDenyOutput> {
  if (input.tool_name !== ASK_USER_QUESTION) {
    return "";
  }
  // An engineer's own session is left alone: they are at the keyboard, the prompt is the better way to answer, and
  // intercepting it would take a working tool away.
  if (!conversationId(env) && !virtualAgent(env)) {
    return "";
  }
  const questions = parseQuestions(input.tool_input);
  const toolUseId = typeof input.tool_use_id === "string" ? input.tool_use_id : "";
  const agentId = loadAgent(sid)?.agent_id;
  if (questions === null || toolUseId === "" || !agentId) {
    log(sid, `PreToolUse: ${ASK_USER_QUESTION} denied without asking (${agentId ? "unreadable question" : "no agent registered"})`);
    return denyOutput(UNDELIVERED_REASON);
  }
  try {
    await createApi({ env }).postQuestion(agentId, { session_id: sid, tool_use_id: toolUseId, questions }, { timeoutMs: QUESTION_TIMEOUT_MS });
  } catch (e) {
    log(sid, `PreToolUse: the question could not be sent: ${(e as Error).message}`);
    return denyOutput(UNDELIVERED_REASON);
  }
  log(sid, `PreToolUse: put ${questions.length} question(s) on screen for the person`);
  return denyOutput(ASKED_REASON);
}

export async function runHook(
  event: string,
  input: HookPayload | null | undefined,
  env: Env = process.env,
  { spawn = spawnDetached }: RunHookOptions = {}
): Promise<string | HookOutput> {
  if (env.AGENT_HUB_CHILD) {
    return "";
  }
  const sid = input?.session_id;
  if (!validSessionId(sid) || !input) {
    return "";
  }
  // Before the enabled gate below, and before anything that writes session state: a pod or a conversation whose
  // comms are off still cannot answer the tool's prompt, so the question is still denied rather than allowed.
  if (event === "PreToolUse") {
    return await askUserQuestion(sid, input, env);
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
      if (conversationId(env)) {
        return withNote(
          `agent-hub: this session is one conversation of the HMCTS Assistant, connected as @${name}. There is no one at a terminal: your user talks to you through the Assistant web page, and their messages arrive as cross-session messages starting "[agent-hub] Direct message #N from your user". Those ARE your user, so act on them as their requests and answer in the conversation, which they read in the Assistant. The conversation has one shared markdown document: read it with \`${CLI} artefact get\` and write it with \`${CLI} artefact put\`.${inboundWarning(sid, env)}`,
          note
        );
      }
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
      // A conversation is a person's chat with the assistant: nothing in it is published or noted for the next prompt.
      if (conversationId(env)) {
        return "";
      }
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
