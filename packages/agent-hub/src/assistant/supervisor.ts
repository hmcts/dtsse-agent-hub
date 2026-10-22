// The supervisor's state and every decision it makes, with its side effects injected: which conversations have a
// session, which are waiting for a free slot, which are stopping, and what the hub is told about them. See the
// sessions stream in dtsse-agent-hub's docs/agent-api.md.
import nodeFs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../agent.ts";
import type { Api, SessionReport } from "../api.ts";
import type { Env } from "../env.ts";
import { hubHome, projectTranscriptPath, statePath, validSessionId } from "../session.ts";
import { claudeCommand, createTmux, type Tmux, tmuxName } from "./tmux.ts";

export const DEFAULT_MAX_SESSIONS = 2;
export const MAX_SESSIONS_LIMIT = 20;
export const DEFAULT_IDLE_MINUTES = 20;
// How long a session has to leave after `/exit` before its tmux session is killed.
export const EXIT_GRACE_MS = 15000;
export const REPORT_EVERY_MS = 60000;
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
  close: (data: unknown) => Promise<void>;
  tick: () => Promise<void>;
  adopt: () => Promise<void>;
  report: (opts?: { force?: boolean }) => Promise<ReportOutcome>;
};

export type ReportOutcome = "unchanged" | "reported" | "error";

/** The filesystem calls the supervisor makes; a test passes `node:fs` or its own. */
export type SupervisorFs = Pick<typeof nodeFs, "statSync" | "readFileSync" | "writeFileSync" | "existsSync" | "mkdirSync" | "renameSync">;

export type CreateAssistantSupervisorOptions = {
  api: Pick<Api, "putSessions">;
  id: string;
  env?: Env;
  tmux?: Tmux;
  fs?: SupervisorFs;
  now?: () => number;
  say?: (message: string) => void;
  /** Where each conversation's session runs. The workspace checkout root, because `claudeCommand` reaches the
   * launcher through a path relative to it. */
  cwd?: string;
  max?: number;
  idleMs?: number;
  exitGraceMs?: number;
  reportEveryMs?: number;
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
  fs = nodeFs,
  now = Date.now,
  say = () => {},
  cwd = workspaceRoot(),
  max = maxSessions(env),
  idleMs = idleMinutes(env) * 60000,
  exitGraceMs = EXIT_GRACE_MS,
  reportEveryMs = REPORT_EVERY_MS
}: CreateAssistantSupervisorOptions): AssistantSupervisor {
  const sessions = new Map<string, ConversationSession>();
  // Wakes waiting for a free slot, oldest first. A conversation whose session is stopping waits here too.
  const queue: Wake[] = [];
  let reported: string | null = null;
  let reportedAt = 0;
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

  // Busy while the hooks say so. Otherwise last active when the status file or the transcript last changed:
  // the Stop hook writes the one, and every turn appends to the other.
  function refresh(s: ConversationSession): void {
    const status = statePath(s.session_id, "status");
    let text = "";
    try {
      text = (fs.readFileSync(status, "utf8") as string).trim();
    } catch {}
    s.busy = text === "busy";
    s.active_at = Math.max(s.active_at, s.busy ? now() : 0, mtime(status), mtime(transcript(s.session_id)));
    if (s.phase === "starting" && fs.existsSync(statePath(s.session_id, "enabled"))) {
      s.phase = "live";
    }
  }

  function drop(s: ConversationSession, why: string): void {
    sessions.delete(s.conversation_id);
    save();
    say(`conversation ${s.conversation_id}: ${why}`);
  }

  async function start(w: Wake): Promise<void> {
    const resume = w.resume || fs.existsSync(transcript(w.session_id));
    const name = tmuxName(w.conversation_id);
    try {
      await tmux.start({ name, cwd, vars: { AGENT_HUB_CONVERSATION_ID: w.conversation_id }, command: claudeCommand(w.session_id, resume) });
    } catch (e) {
      // Nothing registered for it, so the hub sends the wake again on the next connection.
      say(`conversation ${w.conversation_id}: could not start a session: ${(e as Error).message}`);
      return;
    }
    const at = now();
    sessions.set(w.conversation_id, { ...w, name, resume, phase: "starting", busy: false, started_at: at, active_at: at });
    save();
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

  // Starts queued wakes while there is room. At the cap, it stops the least recently active idle session for
  // each wake that no stopping session will make room for; with none idle, the wakes stay queued.
  async function fill(): Promise<void> {
    for (;;) {
      const next = queue.find((w) => !sessions.has(w.conversation_id));
      if (!next) {
        return;
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
    close: (data) => serial(() => close(data)),
    tick: () => serial(tick),
    adopt: () => serial(adopt),
    report: (opts) => serial(() => report(opts))
  };
}
