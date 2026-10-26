// The supervisor's state and every decision it makes, with its side effects injected: which conversations have a
// session, which are waiting for a free slot, which are stopping, and what the hub is told about them. See the
// sessions stream in dtsse-agent-hub's docs/agent-api.md.
import nodeFs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../agent.ts";
import type { Api, SessionReport } from "../api.ts";
import type { Env } from "../env.ts";
import { hubHome, projectTranscriptPath, statePath, validSessionId } from "../session.ts";
import { removeConversationUploads, uploadsRoot } from "./attachments.ts";
import { canRunProgram, claudeCommand, commandProgram, createTmux, type ProgramCheck, type Tmux, tmuxName } from "./tmux.ts";

export const DEFAULT_MAX_SESSIONS = 2;
export const MAX_SESSIONS_LIMIT = 20;
export const DEFAULT_IDLE_MINUTES = 20;
// How long a session has to leave after `/exit` before its tmux session is killed.
export const EXIT_GRACE_MS = 15000;
/**
 * How long a `busy` is believed with nothing new appended to the session's transcript.
 *
 * Claude Code's `Stop` hook is the only thing that clears the `busy` its `UserPromptSubmit` hook wrote, and it does
 * not run for a turn the person interrupted, so the flag alone is not evidence of a turn still running. Every step
 * of a real turn appends to the transcript, and the longest a single step can block is Claude Code's ten-minute tool
 * timeout, so an hours-old transcript under a `busy` is a turn that ended without saying so.
 *
 * Two hours is an order of magnitude beyond that, because the two mistakes are not equal: a slot held too long is a
 * wait, while evicting a session that is really working — a long build, a slow Jenkins wait — costs the person the
 * answer it was in the middle of.
 */
export const BUSY_STALE_MS = 2 * 60 * 60 * 1000;
export const REPORT_EVERY_MS = 60000;
/**
 * How often a launcher this pod cannot run is said again while that is still true. On an interval, as `report()`
 * re-sends state that has not changed, rather than once per process: a refused wake is in no report and has no
 * `SessionReport.state` to carry it, so the log is the only sign, and a pod that said it once an hour ago reads as
 * a healthy supervisor that simply has no sessions. Not per wake, because the hub replays every pending wake each
 * time it remakes the sessions stream, which would bury the first.
 */
export const REFUSAL_EVERY_MS = 60000;
// The hub's limits on PUT /api/virtual/{id}/sessions.
const MAX_REPORTED = 50;
const DETAIL_MAX = 200;
const CONVERSATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_NAME_RE = /^c-[0-9a-f]{8}$/;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const maxSessions = (env: Env = process.env): number => boundedInt(env.AGENT_HUB_MAX_SESSIONS, DEFAULT_MAX_SESSIONS, 1, MAX_SESSIONS_LIMIT);
export const idleMinutes = (env: Env = process.env): number => boundedInt(env.AGENT_HUB_SESSION_IDLE_MINUTES, DEFAULT_IDLE_MINUTES, 1, 24 * 60);

/** A wake on the sessions stream: which conversation, the session id to run it as, and whether to resume it. */
export type Wake = {
  conversation_id: string;
  session_id: string;
  resume: boolean;
};

/** `starting` until the session's hooks say comms are on, `live` after that, `stopping` from its `/exit`. */
export type SessionPhase = "starting" | "live" | "stopping";

export type ConversationSession = Wake & {
  name: string;
  phase: SessionPhase;
  busy: boolean;
  started_at: number;
  active_at: number;
  stopping_at?: number;
};

/** What `assistant-sessions.json` holds, so a restarted supervisor can adopt the tmux sessions still running. */
export type SavedSession = Wake & {
  name: string;
  started_at: number;
};

export type AssistantSupervisor = {
  sessions: Map<string, ConversationSession>;
  queue: Wake[];
  max: number;
  wake: (data: unknown) => Promise<void>;
  interrupt: (data: unknown) => Promise<void>;
  close: (data: unknown) => Promise<void>;
  tick: () => Promise<void>;
  adopt: () => Promise<void>;
  report: (opts?: { force?: boolean }) => Promise<ReportOutcome>;
};

export type ReportOutcome = "unchanged" | "reported" | "error";

/** The filesystem calls the supervisor makes; a test passes `node:fs` or its own. */
export type SupervisorFs = Pick<typeof nodeFs, "statSync" | "readFileSync" | "writeFileSync" | "existsSync" | "mkdirSync" | "renameSync" | "rmSync">;

export type CreateAssistantSupervisorOptions = {
  api: Pick<Api, "putSessions">;
  id: string;
  env?: Env;
  tmux?: Tmux;
  /** Whether a pane's program can be run; a test passes its own rather than putting a launcher on PATH. */
  canRun?: ProgramCheck;
  fs?: SupervisorFs;
  now?: () => number;
  say?: (message: string) => void;
  /** Where each conversation's session runs, and so what a relative path in its command resolves against: the
   * workspace checkout root, because `claudeCommand` names the prompt file through a path relative to it. */
  cwd?: string;
  /** Where conversations' attachments live; a deleted conversation's directory goes with its session. */
  uploadsDir?: string;
  max?: number;
  idleMs?: number;
  exitGraceMs?: number;
  reportEveryMs?: number;
  refusalEveryMs?: number;
  busyStaleMs?: number;
  /** When this supervisor started, which bounds how old a `busy` it will believe is; a test passes its own. */
  bootedAt?: number;
};

// The pod's state directory, which `virtual/phases.ts` also writes to. Spelled out rather than taken from
// `virtualStateDir()` so this stays a pure path: `save()` creates the directory through the injected `fs`.
const stateFile = () => path.join(hubHome(), "virtual", "assistant-sessions.json");

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A wake with a conversation id and a session id this client would run, or null. */
export function parseWake(value: unknown): Wake | null {
  const raw = asRecord(value);
  if (!raw || !CONVERSATION_RE.test(String(raw.conversation_id)) || !validSessionId(raw.session_id)) {
    return null;
  }
  return { conversation_id: raw.conversation_id as string, session_id: raw.session_id, resume: raw.resume === true };
}

/** Null for anything that is not a session this supervisor saved; `started_at` is optional, as an older one left it. */
export function parseSavedSession(value: unknown): SavedSession | null {
  const raw = asRecord(value);
  if (!raw || !CONVERSATION_RE.test(String(raw.conversation_id)) || !validSessionId(raw.session_id) || typeof raw.name !== "string") {
    return null;
  }
  return {
    conversation_id: raw.conversation_id as string,
    session_id: raw.session_id,
    resume: raw.resume === true,
    name: raw.name,
    started_at: typeof raw.started_at === "number" ? raw.started_at : 0
  };
}

/**
 * `wake`, `close`, `tick`, `adopt` and `report` run one at a time, in the order they are called, so a wake that
 * arrives while a tick is freeing a slot never starts a session the tick was about to start.
 */
export function createAssistantSupervisor({
  api,
  id,
  env = process.env,
  tmux = createTmux({ env: env as NodeJS.ProcessEnv }),
  canRun = canRunProgram,
  fs = nodeFs,
  now = Date.now,
  say = () => {},
  cwd = workspaceRoot(),
  uploadsDir = uploadsRoot(env, cwd),
  max = maxSessions(env),
  idleMs = idleMinutes(env) * 60000,
  exitGraceMs = EXIT_GRACE_MS,
  reportEveryMs = REPORT_EVERY_MS,
  refusalEveryMs = REFUSAL_EVERY_MS,
  busyStaleMs = BUSY_STALE_MS,
  bootedAt = now()
}: CreateAssistantSupervisorOptions): AssistantSupervisor {
  const sessions = new Map<string, ConversationSession>();
  // Wakes waiting for a free slot, oldest first. A conversation whose session is stopping waits here too.
  const queue: Wake[] = [];
  let reported: string | null = null;
  let reportedAt = 0;
  // The launcher refusal already said and when, so replayed wakes do not repeat it every time. Cleared by a
  // session that starts, so a launcher that goes missing again is said at once.
  let refusedLauncher: string | null = null;
  let refusedLauncherAt = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const transcript = (sid: string) => projectTranscriptPath(cwd, sid);
  const mtime = (file: string) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };

  function save(): void {
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const kept: SavedSession[] = [...sessions.values()].map(({ conversation_id, session_id, name, resume, started_at }) => ({
        conversation_id,
        session_id,
        name,
        resume,
        started_at
      }));
      fs.writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      say(`could not save ${file}: ${(e as Error).message}`);
    }
  }

  function load(): unknown[] {
    try {
      const list = JSON.parse(fs.readFileSync(stateFile(), "utf8") as string);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  /**
   * Busy while the hooks say so and the session is still showing progress. Last active when the status file or the
   * transcript last changed either way: the Stop hook writes the one, and every turn appends to the other.
   *
   * A `busy` is believed only when the status file was written since this supervisor started, and only while there
   * has been progress within `busyStaleMs`. `~/.claude` is a volume that outlives the pod, so a turn the pod went
   * down in the middle of leaves `busy` behind on disk, and nothing rewrites it: a session resumed under the same
   * session id finds the `enabled` file its predecessor left there too, so it goes straight to `live` without the
   * enable that would have written the status afresh. No session can be mid-turn from before the process that would
   * be running it, and such a `busy` taken at face value is a slot `leastActiveIdle` will not take and the idle
   * sweep will not reach — on a disk that outlives the pod, so restarting does not clear it either.
   *
   * `active_at` moves with the two mtimes alone, never with the flag, so that a frozen `busy` cannot also read as
   * the most recently used session on the pod. A turn that is really running appends to its transcript, which is
   * what keeps it at the recent end of the eviction order and what makes it safe to discount a `busy` claimed
   * before the boot: a genuine turn adopted across a supervisor restart is the last session eviction would pick and
   * is nowhere near the idle stop.
   */
  function refresh(s: ConversationSession): void {
    const status = statePath(s.session_id, "status");
    let text = "";
    try {
      text = (fs.readFileSync(status, "utf8") as string).trim();
    } catch {}
    const statusAt = mtime(status);
    const progressAt = Math.max(statusAt, mtime(transcript(s.session_id)));
    s.busy = text === "busy" && statusAt >= bootedAt && now() - progressAt < busyStaleMs;
    s.active_at = Math.max(s.active_at, progressAt);
    if (s.phase === "starting" && fs.existsSync(statePath(s.session_id, "enabled"))) {
      s.phase = "live";
    }
  }

  function drop(s: ConversationSession, why: string): void {
    sessions.delete(s.conversation_id);
    save();
    say(`conversation ${s.conversation_id}: ${why}`);
  }

  /**
   * The program a wake's session would be, when it is one this pod cannot run, and null when it can.
   *
   * `tmux new-session` succeeds whatever the command is, because the pane's shell starts and only the command in it
   * fails, taking its own error message with it when the pane closes. A session recorded for a launcher that is not
   * there is one the hub believes is running and keeps waking, so the wake is refused instead — and refused before
   * `fill()` acts on it, because the eviction it would do next must not cost a live session its slot for a session
   * that will never start.
   */
  function unrunnableLauncher(w: Wake): string | null {
    const program = commandProgram(claudeCommand(w.session_id, w.resume));
    return canRun(program, { cwd, env }) ? null : program;
  }

  async function start(w: Wake): Promise<void> {
    const resume = w.resume || fs.existsSync(transcript(w.session_id));
    const name = tmuxName(w.conversation_id);
    const command = claudeCommand(w.session_id, resume);
    try {
      await tmux.start({ name, cwd, vars: { AGENT_HUB_CONVERSATION_ID: w.conversation_id }, command });
    } catch (e) {
      // Nothing registered for it, so the hub sends the wake again on the next connection.
      say(`conversation ${w.conversation_id}: could not start a session: ${(e as Error).message}`);
      return;
    }
    const at = now();
    sessions.set(w.conversation_id, { ...w, name, resume, phase: "starting", busy: false, started_at: at, active_at: at });
    save();
    refusedLauncher = null;
    say(`conversation ${w.conversation_id}: ${resume ? "resumed" : "started"} session ${w.session_id} in tmux session ${name}`);
  }

  async function stop(s: ConversationSession, why: string): Promise<void> {
    if (s.phase === "stopping") {
      return;
    }
    s.phase = "stopping";
    s.stopping_at = now();
    say(`conversation ${s.conversation_id}: stopping its session (${why})`);
    try {
      await tmux.sendKeys(s.name, "/exit", "Enter");
    } catch (e) {
      say(`conversation ${s.conversation_id}: could not send /exit: ${(e as Error).message}`);
    }
  }

  function leastActiveIdle(): ConversationSession | null {
    const idle = [...sessions.values()].filter((s) => s.phase === "live" && !s.busy);
    return idle.sort((a, b) => a.active_at - b.active_at)[0] ?? null;
  }

  // Starts queued wakes while there is room, dropping any whose launcher this pod cannot run. At the cap, it stops
  // the least recently active idle session for each wake that no stopping session will make room for; with none
  // idle, the wakes stay queued.
  async function fill(): Promise<void> {
    for (;;) {
      const next = queue.find((w) => !sessions.has(w.conversation_id));
      if (!next) {
        return;
      }
      const unrunnable = unrunnableLauncher(next);
      if (unrunnable !== null) {
        // Dropped rather than left queued: the hub reports a queued conversation as waiting for a free session,
        // which would promise the person one that cannot start. The hub sends the wake again on its next stream.
        queue.splice(queue.indexOf(next), 1);
        const reason = `cannot run ${unrunnable} from ${cwd}`;
        if (refusedLauncher !== reason || now() - refusedLauncherAt >= refusalEveryMs) {
          refusedLauncher = reason;
          refusedLauncherAt = now();
          say(`conversation ${next.conversation_id}: not starting a session: ${reason}`);
        }
        continue;
      }
      if (sessions.size < max) {
        queue.splice(queue.indexOf(next), 1);
        await start(next);
        continue;
      }
      const stopping = [...sessions.values()].filter((s) => s.phase === "stopping").length;
      if (stopping >= queue.length) {
        return;
      }
      for (const s of sessions.values()) {
        if (s.phase !== "stopping") {
          refresh(s);
        }
      }
      const victim = leastActiveIdle();
      if (!victim) {
        return;
      }
      await stop(victim, `making room for conversation ${next.conversation_id}`);
    }
  }

  function entries(): SessionReport[] {
    const out: SessionReport[] = [];
    for (const s of sessions.values()) {
      if (s.phase === "stopping") {
        continue;
      }
      out.push(
        s.phase === "starting"
          ? { conversation_id: s.conversation_id, state: "starting", detail: s.resume ? "resuming the conversation" : "starting a new session" }
          : { conversation_id: s.conversation_id, state: "live" }
      );
    }
    for (const w of queue) {
      const detail = sessions.has(w.conversation_id) ? "waiting for its last session to stop" : `waiting for a free session (${max} running at once)`;
      out.push({ conversation_id: w.conversation_id, state: "queued", detail });
    }
    return out.slice(0, MAX_REPORTED).map((e) => (e.detail ? { ...e, detail: e.detail.slice(0, DETAIL_MAX) } : e));
  }

  /** PUTs what runs when it changed since the last report, or every reportEveryMs. A failed report is sent again on the next. */
  async function report({ force = false }: { force?: boolean } = {}): Promise<ReportOutcome> {
    const body = { sessions: entries(), max };
    const key = JSON.stringify(body);
    if (!force && key === reported && now() - reportedAt < reportEveryMs) {
      return "unchanged";
    }
    try {
      await api.putSessions(id, body);
    } catch (e) {
      say(`reporting the sessions failed: ${(e as Error).message}`);
      reported = null;
      return "error";
    }
    reported = key;
    reportedAt = now();
    return "reported";
  }

  async function wake(data: unknown): Promise<void> {
    const w = parseWake(data);
    if (!w) {
      say(`ignoring a wake without a conversation and session id: ${JSON.stringify(data).slice(0, 200)}`);
      return;
    }
    const running = sessions.get(w.conversation_id);
    if (running && running.phase !== "stopping") {
      return;
    }
    const queued = queue.find((q) => q.conversation_id === w.conversation_id);
    if (queued) {
      Object.assign(queued, w);
    } else {
      queue.push(w);
    }
    await fill();
    await report();
  }

  /**
   * Ends the turn a conversation's session is in the middle of, without stopping the session: `Escape` is Claude
   * Code's own `chat:cancel` binding, which that session's own keyboard would send, so the conversation, the
   * transcript and the pane all survive it. Not `C-c`, which the same gesture chain also exits the app on, and not
   * a signal or `kill-session`, either of which would cost the person the session the stop was meant to preserve.
   *
   * The status file is written `idle` with it, because **Claude Code runs no `Stop` hook for a turn the user
   * interrupted** — that hook is what normally clears the `busy` the `UserPromptSubmit` hook set. Left alone, the
   * file would say `busy` until the person's *next* prompt finished a turn, the bridge would keep heartbeating it,
   * and the hub's "working" line would spin for ever on an answer that had already stopped. The idle sweep cannot
   * save it either: heartbeats are still arriving.
   *
   * Written before the keys rather than after, so a `sendKeys` that throws still leaves the status honest: the worst
   * case then is a turn that is still running and reads as idle for the few seconds until its own `Stop` hook fires,
   * which is the error worth having of the two.
   *
   * Nothing to interrupt is the common case rather than an error: the hub sends an `interrupt` once and never
   * replays it, so one arriving for a conversation with no session, or with a session already on its way out, is a
   * stop whose turn has already ended. Escape with no turn running is a key that pane's binding is not listening
   * for, so acting anyway would be harmless — but saying so in the log is more use than sending it.
   */
  async function interrupt(data: unknown): Promise<void> {
    const cid = asRecord(data)?.conversation_id;
    const s = typeof cid === "string" ? sessions.get(cid) : undefined;
    if (!s || s.phase === "stopping") {
      say(`ignoring an interrupt for conversation ${String(cid)}: ${s ? "its session is stopping" : "it has no session here"}`);
      return;
    }
    try {
      // `refresh` reads this file back for `busy` and for the idle clock, so nothing in memory is set here.
      fs.writeFileSync(statePath(s.session_id, "status"), "idle\n");
    } catch (e) {
      say(`conversation ${s.conversation_id}: could not mark its session idle: ${(e as Error).message}`);
    }
    try {
      await tmux.sendKeys(s.name, "Escape");
      say(`conversation ${s.conversation_id}: interrupted its session`);
    } catch (e) {
      say(`conversation ${s.conversation_id}: could not interrupt its session: ${(e as Error).message}`);
    }
  }

  async function close(data: unknown): Promise<void> {
    const cid = asRecord(data)?.conversation_id;
    const queued = queue.findIndex((w) => w.conversation_id === cid);
    if (queued !== -1) {
      queue.splice(queued, 1);
    }
    const s = typeof cid === "string" ? sessions.get(cid) : undefined;
    if (s) {
      await stop(s, "the conversation was deleted");
    }
    // The chat is gone, so the files the person attached to it have nothing left to belong to. A conversation deleted
    // while this pod was stopped sends no `close`; `reconcileUploads` is what catches that one.
    if (typeof cid === "string") {
      try {
        removeConversationUploads(uploadsDir, cid, fs);
      } catch (e) {
        say(`conversation ${cid}: could not remove its uploads: ${(e as Error).message}`);
      }
    }
    await report();
  }

  // Frees the slots of sessions that have exited, kills those that outstayed their /exit, stops idle ones,
  // then starts whatever is queued.
  async function tick(): Promise<void> {
    for (const s of [...sessions.values()]) {
      if (!(await tmux.has(s.name))) {
        drop(s, s.phase === "stopping" ? "its session has stopped" : "its session exited by itself");
        continue;
      }
      if (s.phase === "stopping") {
        if (now() - (s.stopping_at ?? 0) < exitGraceMs) {
          continue;
        }
        await tmux.kill(s.name).catch(() => {});
        drop(s, `killed its session, still running ${Math.round(exitGraceMs / 1000)}s after /exit`);
        continue;
      }
      refresh(s);
      const idleFor = now() - s.active_at;
      if (!s.busy && idleFor >= idleMs) {
        await stop(s, `idle for ${Math.round(idleFor / 60000)} minutes`);
      }
    }
    await fill();
    await report();
  }

  // A tmux session this supervisor has no record of cannot be reported or resumed, so it is stopped.
  async function adopt(): Promise<void> {
    const known = new Map<string, SavedSession>();
    for (const entry of load()) {
      const s = parseSavedSession(entry);
      if (s) {
        known.set(s.name, s);
      }
    }
    for (const name of await tmux.list()) {
      if (!SESSION_NAME_RE.test(name)) {
        continue;
      }
      const s = known.get(name);
      if (!s || tmuxName(s.conversation_id) !== name) {
        say(`stopping tmux session ${name}: there is no record of its conversation`);
        await tmux.kill(name).catch(() => {});
        continue;
      }
      const adopted: ConversationSession = { ...s, phase: "starting", busy: false, started_at: s.started_at || now(), active_at: now() };
      refresh(adopted);
      sessions.set(s.conversation_id, adopted);
      say(`conversation ${s.conversation_id}: adopted tmux session ${name}`);
    }
    save();
    await report({ force: true });
  }

  return {
    sessions,
    queue,
    max,
    wake: (data) => serial(() => wake(data)),
    interrupt: (data) => serial(() => interrupt(data)),
    close: (data) => serial(() => close(data)),
    tick: () => serial(tick),
    adopt: () => serial(adopt),
    report: (opts) => serial(() => report(opts))
  };
}
