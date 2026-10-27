// The supervisor's decisions against a fake tmux and a fake clock: which conversations get a session, which wait,
// which are stopped, and what the hub is told. The sessions stream itself is in `run.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { conversation, fakeTmux } from "../__fixtures__/fake-tmux.ts";
import type { SessionsBody } from "../api.ts";
import { ensureStateDir, hubHome, projectTranscriptPath, readText, statePath } from "../session.ts";
import { launcherModel, modelPath } from "./models.ts";
import {
  BUSY_STALE_MS,
  createAssistantSupervisor,
  EXIT_GRACE_MS,
  idleMinutes,
  maxSessions,
  parseSavedSession,
  parseWake,
  REFUSAL_EVERY_MS
} from "./supervisor.ts";
import { claudeCommand, commandProgram, PROMPT_FILE, type ProgramCheck, tmuxName } from "./tmux.ts";

const CWD = "/workspace/cft-workspace";
const MINUTE = 60000;

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "AGENT_HUB_MAX_SESSIONS", "AGENT_HUB_SESSION_IDLE_MINUTES"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, home.env);
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

/**
 * A supervisor on a fake clock that starts at the real time, so the hooks' status files written now are "now".
 * `canRun` stands in for the launcher check, so these tests never depend on what is installed; `canRunProgram`
 * itself is tested in `tmux.test.ts`.
 *
 * The supervisor is told it booted ten minutes before that clock, and tests reckon against the `bootedAt` it
 * returns. Letting it default to the clock would date every status file written "now" within a tick of the boot it
 * is compared against, and a filesystem that keeps mtimes to the whole second — which the CI runner's does — then
 * dates them just before it, so whether a busy session is believed would come down to the filesystem.
 */
function setup({ max = 2, idleMs = 20 * MINUTE, canRun = () => true }: { max?: number; idleMs?: number; canRun?: ProgramCheck } = {}) {
  fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
  const tmux = fakeTmux();
  const reports: SessionsBody[] = [];
  const said: string[] = [];
  const api = {
    putSessions: async (_id: string, body: SessionsBody) => {
      reports.push(body);
      return null;
    }
  };
  const clock = { t: Date.now() };
  const bootedAt = clock.t - 10 * MINUTE;
  const supervisor = createAssistantSupervisor({
    api,
    id: "va-assist",
    tmux,
    canRun,
    now: () => clock.t,
    cwd: CWD,
    max,
    idleMs,
    bootedAt,
    say: (message) => said.push(message)
  });
  return { tmux, reports, said, clock, bootedAt, supervisor, lastReport: () => reports.at(-1) as SessionsBody };
}

// What the hooks write for a session that has registered, as busy or idle, last changed `at` (ms).
function hookStatus(sid: string, status: "busy" | "idle", at = Date.now()): void {
  ensureStateDir(sid);
  fs.writeFileSync(statePath(sid, "enabled"), "x");
  fs.writeFileSync(statePath(sid, "status"), `${status}\n`);
  fs.utimesSync(statePath(sid, "status"), at / 1000, at / 1000);
}

// What a turn appends as it runs: Claude Code's own transcript of the session, last written `at` (ms).
function transcriptWritten(sid: string, at: number): void {
  const file = projectTranscriptPath(CWD, sid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  fs.utimesSync(file, at / 1000, at / 1000);
}

describe("parseWake", () => {
  it("should keep the conversation, the session and the resume flag when the wake is one the pod can run", () => {
    // Arrange
    const c = conversation();

    // Act & Assert
    expect(parseWake({ ...c, resume: true, product: "pcs", model: "claude-opus-5-5" })).toEqual({
      conversation_id: c.conversation_id,
      session_id: c.session_id,
      resume: true,
      model: "claude-opus-5-5"
    });
    expect(parseWake(c)).toEqual({ conversation_id: c.conversation_id, session_id: c.session_id, resume: false, model: null });
    expect(parseWake({ ...c, resume: "yes" })).toEqual({ conversation_id: c.conversation_id, session_id: c.session_id, resume: false, model: null });
  });

  it("should be null when the conversation id or the session id is not one it would run", () => {
    // Arrange
    const c = conversation();

    // Act & Assert
    expect(parseWake(null)).toBeNull();
    expect(parseWake([c])).toBeNull();
    expect(parseWake({ session_id: c.session_id })).toBeNull();
    expect(parseWake({ conversation_id: "not-a-uuid", session_id: c.session_id })).toBeNull();
    expect(parseWake({ conversation_id: c.conversation_id, session_id: "../x" })).toBeNull();
  });
});

describe("parseSavedSession", () => {
  it("should keep every field the adoption reads when the file is one the supervisor wrote", () => {
    // Arrange
    const c = conversation();
    const written = { ...c, resume: true, model: "claude-haiku-5-5", name: tmuxName(c.conversation_id), started_at: 1700000000000 };

    // Act & Assert
    expect(parseSavedSession(written)).toEqual(written);
    expect(parseSavedSession({ ...written, started_at: undefined })).toEqual({ ...written, started_at: 0 });
  });

  it("should be null when the record names no conversation, session or tmux session", () => {
    // Arrange
    const c = conversation();
    const name = tmuxName(c.conversation_id);

    // Act & Assert
    expect(parseSavedSession(null)).toBeNull();
    expect(parseSavedSession({ session_id: c.session_id, name })).toBeNull();
    expect(parseSavedSession({ ...c, name: 7 })).toBeNull();
    expect(parseSavedSession({ conversation_id: c.conversation_id, session_id: "../x", name })).toBeNull();
  });
});

describe("createAssistantSupervisor wake", () => {
  it("should start a session with --session-id and the conversation id when a new conversation is woken", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();

    // Act
    await supervisor.wake(c);

    // Assert
    const [start] = tmux.starts();
    expect(start?.name).toBe(tmuxName(c.conversation_id));
    expect(start?.name).toMatch(/^c-[0-9a-f]{8}$/);
    expect(start?.cwd).toBe(CWD);
    expect(start?.vars).toEqual({ AGENT_HUB_CONVERSATION_ID: c.conversation_id });
    expect(start?.command).toBe(`hai --dangerously-skip-permissions --session-id ${c.session_id} --append-system-prompt-file '${PROMPT_FILE}'`);
  });

  it("should start the session on the wake's model and record it for the bridge when the wake names one", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = { ...conversation(), model: "claude-opus-5-5" };

    // Act
    await supervisor.wake(c);

    // Assert
    const launched = launcherModel("claude-opus-5-5");
    expect(launched).not.toBeNull();
    expect(tmux.starts()[0]?.command).toBe(claudeCommand(c.session_id, false, launched));
    expect(tmux.starts()[0]?.command).toContain(`--model '${launched}'`);
    expect(readText(modelPath(c.session_id))).toBe("claude-opus-5-5");
  });

  it("should start the session on hai's default and clear any recorded model when the wake names none", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();
    ensureStateDir(c.session_id);
    fs.writeFileSync(modelPath(c.session_id), "claude-haiku-5-5\n");

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()[0]?.command).not.toContain("--model");
    expect(fs.existsSync(modelPath(c.session_id))).toBe(false);
  });

  it("should not put a model on the command line when the wake's is not the shape of an id", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = { ...conversation(), model: "claude-opus-5-5'; touch /tmp/owned; '" };

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()[0]?.command).toBe(claudeCommand(c.session_id, false));
  });

  it("should ask for the command's program against the session's working directory when a conversation is woken", async () => {
    // Arrange
    const asked: { program: string; cwd: string }[] = [];
    const canRun: ProgramCheck = (program, { cwd }) => {
      asked.push({ program, cwd });
      return true;
    };
    const { tmux, supervisor } = setup({ canRun });
    const c = conversation();

    // Act
    await supervisor.wake(c);

    // Assert
    expect(asked).toEqual([{ program: commandProgram(claudeCommand(c.session_id, false)), cwd: CWD }]);
    expect(tmux.starts()).toHaveLength(1);
  });

  // A session started for a launcher that is not there dies with its pane, and the hub keeps waking it.
  it("should start nothing and say why when the command's program cannot be run", async () => {
    // Arrange
    const { tmux, supervisor, said, lastReport } = setup({ canRun: () => false });
    const c = conversation();

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()).toEqual([]);
    expect(supervisor.sessions.size).toBe(0);
    expect(supervisor.queue).toEqual([]);
    expect(lastReport().sessions).toEqual([]);
    expect(said).toContain(`conversation ${c.conversation_id}: not starting a session: cannot run hai from ${CWD}`);
  });

  // The refusal costs nothing: at the cap the supervisor would otherwise stop the least recently active session to
  // make room, and a pod whose launcher has gone would walk through its working sessions a wake at a time.
  it("should leave a live session running when a wake at the cap is refused", async () => {
    // Arrange
    let runnable = true;
    const { tmux, supervisor, said, lastReport } = setup({ max: 1, canRun: () => runnable });
    const live = conversation();
    const refused = conversation();
    await supervisor.wake(live);
    hookStatus(live.session_id, "idle");

    // Act
    runnable = false;
    await supervisor.wake(refused);

    // Assert
    expect(tmux.sent(tmuxName(live.conversation_id))).toEqual([]);
    expect(supervisor.sessions.get(live.conversation_id)?.phase).not.toBe("stopping");
    expect(tmux.starts()).toHaveLength(1);
    expect(supervisor.queue).toEqual([]);
    expect(lastReport().sessions.map((s) => s.conversation_id)).toEqual([live.conversation_id]);
    expect(said.filter((m) => m.includes("making room"))).toEqual([]);
  });

  it("should say a launcher it cannot run once when the hub resends the wake within the interval", async () => {
    // Arrange
    const { supervisor, said } = setup({ canRun: () => false });
    const c = conversation();

    // Act
    await supervisor.wake(c);
    await supervisor.wake(c);
    await supervisor.wake(conversation());

    // Assert
    expect(said.filter((m) => m.includes("cannot run hai"))).toHaveLength(1);
  });

  // Saying it once per process would let the log go cold: a pod that can start nothing would read, an hour later,
  // as a healthy supervisor that happens to have no sessions.
  it("should say it again when the launcher still cannot be run an interval later", async () => {
    // Arrange
    const { supervisor, said, clock } = setup({ canRun: () => false });

    // Act
    await supervisor.wake(conversation());
    clock.t += REFUSAL_EVERY_MS;
    await supervisor.wake(conversation());

    // Assert
    expect(said.filter((m) => m.includes("cannot run hai"))).toHaveLength(2);
  });

  it("should resume the session when the wake says resume", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = { ...conversation(), resume: true };

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()[0]?.command).toBe(claudeCommand(c.session_id, true));
    expect(tmux.starts()[0]?.command).toMatch(new RegExp(`^hai --dangerously-skip-permissions --resume ${c.session_id} --append-system-prompt-file `));
  });

  it("should resume the session when its transcript is already on disk, whatever the wake says", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();
    const file = projectTranscriptPath(CWD, c.session_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n");

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()[0]?.command).toBe(claudeCommand(c.session_id, true));
  });

  it("should do nothing when a conversation that already has a session is woken again", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();

    // Act
    await supervisor.wake(c);
    await supervisor.wake(c);
    await supervisor.wake({ ...c, resume: true });

    // Assert
    expect(tmux.starts()).toHaveLength(1);
    expect(supervisor.queue).toHaveLength(0);
  });

  it("should ignore a wake when it carries no conversation id or no session id it would run", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();

    // Act
    await supervisor.wake({ session_id: c.session_id });
    await supervisor.wake({ conversation_id: c.conversation_id, session_id: "../x" });

    // Assert
    expect(tmux.starts()).toHaveLength(0);
  });
});

describe("createAssistantSupervisor at the cap", () => {
  it("should queue a wake when every session is busy at the cap, and start it once a session exits", async () => {
    // Arrange
    const { tmux, supervisor, lastReport } = setup({ max: 2 });
    const [a, b, c] = [conversation(), conversation(), conversation()];
    await supervisor.wake(a);
    await supervisor.wake(b);
    hookStatus(a.session_id, "busy");
    hookStatus(b.session_id, "busy");
    await supervisor.tick();

    // Act
    await supervisor.wake(c);

    // Assert
    expect(tmux.starts()).toHaveLength(2);
    expect(supervisor.queue.map((w) => w.conversation_id)).toEqual([c.conversation_id]);
    expect(lastReport().sessions.find((e) => e.conversation_id === c.conversation_id)?.state).toBe("queued");
    expect(
      tmux.calls.filter((call) => call[0] === "send-keys"),
      "a busy session was stopped"
    ).toHaveLength(0);

    // Act
    tmux.alive.delete(tmuxName(a.conversation_id));
    await supervisor.tick();

    // Assert
    expect(tmux.starts()).toHaveLength(3);
    expect(tmux.starts()[2]?.vars?.AGENT_HUB_CONVERSATION_ID).toBe(c.conversation_id);
    expect(supervisor.sessions.has(a.conversation_id)).toBe(false);
    expect(supervisor.queue).toHaveLength(0);
  });

  it("should stop the least recently active idle session when a wake arrives at the cap", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ max: 2 });
    const [older, newer, waiting] = [conversation(), conversation(), conversation()];
    await supervisor.wake(older);
    await supervisor.wake(newer);
    clock.t += 5 * MINUTE;
    hookStatus(older.session_id, "idle", clock.t - 4 * MINUTE);
    hookStatus(newer.session_id, "idle", clock.t - MINUTE);
    await supervisor.tick();

    // Act
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(older.conversation_id))).toEqual([["send-keys", tmuxName(older.conversation_id), "/exit", "Enter"]]);
    expect(tmux.sent(tmuxName(newer.conversation_id))).toHaveLength(0);
    expect(tmux.starts(), "started before the evicted session left").toHaveLength(2);

    // Act
    tmux.alive.delete(tmuxName(older.conversation_id));
    await supervisor.tick();

    // Assert
    expect(tmux.starts().at(-1)?.vars?.AGENT_HUB_CONVERSATION_ID).toBe(waiting.conversation_id);
  });
});

describe("createAssistantSupervisor tick", () => {
  it("should send /exit to a session idle past the limit and kill it when it is still there 15s later", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ idleMs: 20 * MINUTE });
    const c = conversation();
    const name = tmuxName(c.conversation_id);
    await supervisor.wake(c);
    hookStatus(c.session_id, "idle", clock.t);

    // Act
    clock.t += 19 * MINUTE;
    await supervisor.tick();

    // Assert
    expect(tmux.sent(name), "stopped before the limit").toHaveLength(0);

    // Act
    clock.t += 2 * MINUTE;
    await supervisor.tick();

    // Assert
    expect(tmux.sent(name)).toEqual([["send-keys", name, "/exit", "Enter"]]);

    // Act
    clock.t += EXIT_GRACE_MS - 1000;
    await supervisor.tick();

    // Assert
    expect(tmux.killed(name), "killed within the grace period").toBe(false);

    // Act
    clock.t += 1000;
    await supervisor.tick();

    // Assert
    expect(tmux.killed(name)).toBe(true);
    expect(supervisor.sessions.has(c.conversation_id)).toBe(false);
  });

  it("should not stop a session when it is busy and its turn started an hour ago", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ idleMs: 20 * MINUTE });
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "busy", clock.t);

    // Act
    clock.t += 60 * MINUTE;
    await supervisor.tick();

    // Assert
    expect(tmux.sent(tmuxName(c.conversation_id))).toHaveLength(0);
  });

  it("should stop a session whose busy was written before this supervisor started once it has been idle that long", async () => {
    // Arrange: a turn the pod before this one went down in the middle of, left `busy` on the volume. `~/.claude`
    // outlives the pod, and the resumed session skips the enable that would have rewritten the file.
    const { tmux, supervisor, clock } = setup({ idleMs: 20 * MINUTE });
    const c = conversation();
    hookStatus(c.session_id, "busy", clock.t - 24 * 60 * MINUTE);
    await supervisor.wake(c);

    // Act
    clock.t += 21 * MINUTE;
    await supervisor.tick();

    // Assert
    expect(tmux.sent(tmuxName(c.conversation_id))).toEqual([["send-keys", tmuxName(c.conversation_id), "/exit", "Enter"]]);
  });
});

describe("createAssistantSupervisor and a busy it should not believe", () => {
  it("should evict a session whose busy was written before this supervisor started when a wake arrives at the cap", async () => {
    // Arrange: dated well before the boot but only twenty minutes ago, so the boot is the only thing that makes it
    // stale — the progress bound is nowhere near.
    const { tmux, supervisor, bootedAt } = setup({ max: 1 });
    const [frozen, waiting] = [conversation(), conversation()];
    hookStatus(frozen.session_id, "busy", bootedAt - 10 * MINUTE);
    await supervisor.wake(frozen);

    // Act
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(frozen.conversation_id))).toEqual([["send-keys", tmuxName(frozen.conversation_id), "/exit", "Enter"]]);
  });

  it("should not evict a session whose busy is dated a second before the boot by a coarse filesystem", async () => {
    // Arrange: a turn that began as the supervisor came up, on a filesystem that keeps mtimes to the whole second.
    const { tmux, supervisor, bootedAt } = setup({ max: 1 });
    const [working, waiting] = [conversation(), conversation()];
    await supervisor.wake(working);
    hookStatus(working.session_id, "busy", bootedAt - 1000);

    // Act
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(working.conversation_id))).toHaveLength(0);
    expect(supervisor.queue.map((w) => w.conversation_id)).toEqual([waiting.conversation_id]);
  });

  it("should not evict a session when its turn began after this supervisor started", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ max: 1 });
    const [working, waiting] = [conversation(), conversation()];
    await supervisor.wake(working);
    hookStatus(working.session_id, "busy", clock.t);

    // Act
    clock.t += 5 * MINUTE;
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(working.conversation_id))).toHaveLength(0);
    expect(supervisor.queue.map((w) => w.conversation_id)).toEqual([waiting.conversation_id]);
  });

  it("should evict a busy session when nothing has been written for longer than the busy bound", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ max: 1 });
    const [stuck, waiting] = [conversation(), conversation()];
    await supervisor.wake(stuck);
    hookStatus(stuck.session_id, "busy", clock.t);

    // Act: the turn was interrupted, so no Stop hook ran and nothing on disk has moved since.
    clock.t += BUSY_STALE_MS + MINUTE;
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(stuck.conversation_id))).toEqual([["send-keys", tmuxName(stuck.conversation_id), "/exit", "Enter"]]);
  });

  it("should not evict a busy session past the busy bound when its transcript is still growing", async () => {
    // Arrange
    const { tmux, supervisor, clock } = setup({ max: 1 });
    const [working, waiting] = [conversation(), conversation()];
    await supervisor.wake(working);
    hookStatus(working.session_id, "busy", clock.t);

    // Act: a long turn, with its last tool result appended a minute ago.
    clock.t += BUSY_STALE_MS + MINUTE;
    transcriptWritten(working.session_id, clock.t - MINUTE);
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(working.conversation_id))).toHaveLength(0);
    expect(supervisor.queue.map((w) => w.conversation_id)).toEqual([waiting.conversation_id]);
  });

  it("should take the eviction order from the session's own writes rather than from a spell of busy", async () => {
    // Arrange: `worked` starts a turn, `idle` finishes one four minutes later, so `worked` is the older of the two
    // on disk. The first tick reads `worked` as busy, which must leave its place in the order alone.
    const { tmux, supervisor, clock } = setup({ max: 2 });
    const [worked, idle, waiting] = [conversation(), conversation(), conversation()];
    await supervisor.wake(worked);
    await supervisor.wake(idle);
    hookStatus(worked.session_id, "busy", clock.t);
    hookStatus(idle.session_id, "idle", clock.t + 4 * MINUTE);
    clock.t += 5 * MINUTE;
    await supervisor.tick();

    // Act: its turn ends without a Stop hook, so the busy is eventually no longer believed.
    clock.t += BUSY_STALE_MS;
    await supervisor.wake(waiting);

    // Assert
    expect(tmux.sent(tmuxName(worked.conversation_id))).toEqual([["send-keys", tmuxName(worked.conversation_id), "/exit", "Enter"]]);
    expect(tmux.sent(tmuxName(idle.conversation_id))).toHaveLength(0);
  });
});

describe("createAssistantSupervisor interrupt", () => {
  it("should send Escape to the conversation's pane when its answer is interrupted", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "busy");

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(tmux.sent(tmuxName(c.conversation_id))).toEqual([["send-keys", tmuxName(c.conversation_id), "Escape"]]);
  });

  // Claude Code runs no `Stop` hook for a turn the user interrupted, and that hook is the only other thing that
  // clears `busy`. Left `busy`, the bridge keeps heartbeating it and the hub's working line spins for ever.
  it("should mark the session idle when its answer is interrupted, since no Stop hook will", async () => {
    // Arrange
    const { supervisor } = setup();
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "busy");

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(fs.readFileSync(statePath(c.session_id, "status"), "utf8").trim()).toBe("idle");
  });

  it("should stop reporting the session as busy once its answer is interrupted", async () => {
    // Arrange
    const { supervisor } = setup();
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "busy");
    await supervisor.tick();
    expect(supervisor.sessions.get(c.conversation_id)?.busy).toBe(true);

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });
    await supervisor.tick();

    // Assert
    expect(supervisor.sessions.get(c.conversation_id)?.busy).toBe(false);
  });

  it("should still send the keys when the status file cannot be written", async () => {
    // Arrange
    const tmux = fakeTmux();
    const said: string[] = [];
    const c = conversation();
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux,
      canRun: () => true,
      cwd: CWD,
      say: (message) => said.push(message),
      fs: {
        ...fs,
        writeFileSync: (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (String(file).endsWith("status")) {
            throw new Error("read-only file system");
          }
          return (fs.writeFileSync as (...args: unknown[]) => void)(file, ...rest);
        }
      }
    });
    await supervisor.wake(c);

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(tmux.sent(tmuxName(c.conversation_id))).toEqual([["send-keys", tmuxName(c.conversation_id), "Escape"]]);
    expect(said.some((line) => line.includes("could not mark its session idle: read-only file system"))).toBe(true);
  });

  it("should leave the session running when its answer is interrupted, so the conversation survives the stop", async () => {
    // Arrange
    const { tmux, supervisor, lastReport } = setup();
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "busy");

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });
    await supervisor.tick();

    // Assert
    expect(tmux.alive.has(tmuxName(c.conversation_id))).toBe(true);
    expect(tmux.killed(tmuxName(c.conversation_id))).toBe(false);
    expect(supervisor.sessions.get(c.conversation_id)?.phase).toBe("live");
    expect(lastReport().sessions).toEqual([{ conversation_id: c.conversation_id, state: "live" }]);
  });

  it("should do nothing but say so when the conversation has no session here", async () => {
    // Arrange
    const { tmux, supervisor, said } = setup();
    const c = conversation();

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(tmux.calls).toEqual([]);
    expect(said.at(-1)).toContain("it has no session here");
  });

  it("should not interrupt a session that is already stopping, whose turn has ended with it", async () => {
    // Arrange
    const { tmux, supervisor, said } = setup();
    const c = conversation();
    await supervisor.wake(c);
    await supervisor.close({ conversation_id: c.conversation_id });

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(tmux.sent(tmuxName(c.conversation_id))).toEqual([["send-keys", tmuxName(c.conversation_id), "/exit", "Enter"]]);
    expect(said.at(-1)).toContain("its session is stopping");
  });

  it("should ignore an interrupt naming no conversation", async () => {
    // Arrange
    const { tmux, supervisor } = setup();

    // Act
    await supervisor.interrupt({});
    await supervisor.interrupt(null);

    // Assert
    expect(tmux.calls).toEqual([]);
  });

  it("should say why when tmux refuses the keys, rather than let the failure out", async () => {
    // Arrange
    const { tmux, supervisor, said } = setup();
    const c = conversation();
    await supervisor.wake(c);
    tmux.sendKeys = async () => {
      throw new Error("no server running");
    };

    // Act
    await supervisor.interrupt({ conversation_id: c.conversation_id });

    // Assert
    expect(said.at(-1)).toContain("could not interrupt its session: no server running");
  });
});

describe("createAssistantSupervisor close", () => {
  it("should stop the session when its conversation is closed, and forget a queued wake for it", async () => {
    // Arrange
    const { tmux, supervisor, lastReport } = setup({ max: 1 });
    const [a, b] = [conversation(), conversation()];
    await supervisor.wake(a);
    hookStatus(a.session_id, "busy");
    await supervisor.tick();
    await supervisor.wake(b);

    // Act
    await supervisor.close({ conversation_id: b.conversation_id });

    // Assert
    expect(supervisor.queue).toHaveLength(0);

    // Act
    await supervisor.close({ conversation_id: a.conversation_id });

    // Assert
    expect(tmux.sent(tmuxName(a.conversation_id))).toEqual([["send-keys", tmuxName(a.conversation_id), "/exit", "Enter"]]);
    expect(lastReport().sessions).toEqual([]);
  });

  it("should remove the conversation's attached files when it is closed, since the chat they belonged to has gone", async () => {
    // Arrange
    const uploads = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-sup-uploads-"));
    const c = conversation();
    const file = path.join(uploads, c.conversation_id, "u-letter.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      uploadsDir: uploads
    });

    try {
      // Act
      await supervisor.close({ conversation_id: c.conversation_id });

      // Assert
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    } finally {
      fs.rmSync(uploads, { recursive: true, force: true });
    }
  });

  it("should say why it could not remove the files, and still report, when the uploads cannot be deleted", async () => {
    // Arrange
    const said: string[] = [];
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      uploadsDir: "/nowhere",
      say: (m) => said.push(m),
      fs: {
        ...fs,
        rmSync: () => {
          throw new Error("read-only file system");
        }
      }
    });
    const c = conversation();

    // Act
    await supervisor.close({ conversation_id: c.conversation_id });

    // Assert
    expect(said).toContain(`conversation ${c.conversation_id}: could not remove its uploads: read-only file system`);
  });

  it("should start a re-woken conversation again once its stopping session has left", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();
    await supervisor.wake(c);
    await supervisor.close({ conversation_id: c.conversation_id });

    // Act
    await supervisor.wake({ ...c, resume: true });

    // Assert
    expect(tmux.starts(), "started while the old session was still there").toHaveLength(1);

    // Act
    tmux.alive.delete(tmuxName(c.conversation_id));
    await supervisor.tick();

    // Assert
    expect(tmux.starts()).toHaveLength(2);
    expect(tmux.starts()[1]?.command).toBe(claudeCommand(c.session_id, true));
  });
});

describe("createAssistantSupervisor report", () => {
  it("should report starting, live and queued sessions with max when they change, and again every minute", async () => {
    // Arrange
    const { supervisor, reports, clock, lastReport } = setup({ max: 1 });
    const [a, b] = [conversation(), conversation()];

    // Act
    await supervisor.wake(a);

    // Assert
    expect(lastReport()).toEqual({ sessions: [{ conversation_id: a.conversation_id, state: "starting", detail: "starting a new session" }], max: 1 });

    // Act
    hookStatus(a.session_id, "busy");
    await supervisor.tick();

    // Assert
    expect(lastReport().sessions).toEqual([{ conversation_id: a.conversation_id, state: "live" }]);

    // Act
    await supervisor.wake(b);

    // Assert
    expect(lastReport().sessions.map((e) => [e.conversation_id, e.state])).toEqual([
      [a.conversation_id, "live"],
      [b.conversation_id, "queued"]
    ]);

    // Act
    const count = reports.length;
    await supervisor.tick();

    // Assert
    expect(reports, "reported an unchanged state within the minute").toHaveLength(count);

    // Act
    clock.t += MINUTE;
    await supervisor.tick();

    // Assert
    expect(reports).toHaveLength(count + 1);
  });

  it("should report again on the next tick when a report fails", async () => {
    // Arrange
    const reports: SessionsBody[] = [];
    let fail = true;
    const api = {
      putSessions: async (_id: string, body: SessionsBody) => {
        if (fail) {
          throw new Error("503");
        }
        reports.push(body);
        return null;
      }
    };
    const supervisor = createAssistantSupervisor({ api, id: "va-assist", tmux: fakeTmux(), canRun: () => true, cwd: CWD });

    // Act
    await supervisor.wake(conversation());

    // Assert
    expect(reports).toHaveLength(0);

    // Act
    fail = false;
    await supervisor.tick();

    // Assert
    expect(reports).toHaveLength(1);
  });
});

describe("createAssistantSupervisor adopt", () => {
  it("should adopt the c-* sessions it recorded and stop one it has no record of when it restarts", async () => {
    // Arrange
    const { tmux, supervisor } = setup();
    const c = conversation();
    await supervisor.wake(c);
    hookStatus(c.session_id, "idle");
    tmux.alive.add("c-deadbeef");
    tmux.alive.add("claude");
    const reports: SessionsBody[] = [];
    const restarted = createAssistantSupervisor({
      api: {
        putSessions: async (_id: string, body: SessionsBody) => {
          reports.push(body);
          return null;
        }
      },
      id: "va-assist",
      tmux,
      canRun: () => true,
      cwd: CWD
    });

    // Act
    await restarted.adopt();

    // Assert
    expect([...restarted.sessions.keys()]).toEqual([c.conversation_id]);
    expect(restarted.sessions.get(c.conversation_id)?.phase).toBe("live");
    expect(tmux.killed("c-deadbeef")).toBe(true);
    expect(tmux.killed("claude")).toBe(false);
    expect(reports).toEqual([{ sessions: [{ conversation_id: c.conversation_id, state: "live" }], max: 2 }]);

    // Act
    await restarted.wake(c);

    // Assert
    expect(tmux.starts(), "an adopted session was started again").toHaveLength(1);
  });
});

describe("createAssistantSupervisor when tmux or the state file will not play", () => {
  it("should record no session and leave the wake to the hub when tmux will not start one", async () => {
    // Arrange
    const said: string[] = [];
    const tmux = { ...fakeTmux(), start: async () => Promise.reject(new Error("no space left on device")) };
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux,
      canRun: () => true,
      cwd: CWD,
      say: (m) => said.push(m)
    });
    const c = conversation();

    // Act
    await supervisor.wake(c);

    // Assert
    expect(supervisor.sessions.size).toBe(0);
    expect(supervisor.queue).toHaveLength(0);
    expect(said).toContain(`conversation ${c.conversation_id}: could not start a session: no space left on device`);
  });

  it("should still count the session as stopping when /exit cannot be sent, and not send it twice", async () => {
    // Arrange
    const said: string[] = [];
    const tmux = { ...fakeTmux(), sendKeys: async () => Promise.reject(new Error("no such session")) };
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux,
      canRun: () => true,
      cwd: CWD,
      say: (m) => said.push(m)
    });
    const c = conversation();
    await supervisor.wake(c);

    // Act
    await supervisor.close({ conversation_id: c.conversation_id });
    await supervisor.close({ conversation_id: c.conversation_id });

    // Assert
    expect(supervisor.sessions.get(c.conversation_id)?.phase).toBe("stopping");
    expect(said.filter((m) => m.includes("could not send /exit"))).toHaveLength(1);
    expect(said.filter((m) => m.includes("stopping its session"))).toHaveLength(1);
  });

  it("should say which file it could not write when the state file cannot be saved", async () => {
    // Arrange
    const said: string[] = [];
    const supervisor = createAssistantSupervisor({
      api: { putSessions: async () => null },
      id: "va-assist",
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      say: (m) => said.push(m),
      fs: {
        ...fs,
        writeFileSync: () => {
          throw new Error("read-only file system");
        }
      }
    });

    // Act
    await supervisor.wake(conversation());

    // Assert
    expect(
      said.some((m) => /^could not save .*assistant-sessions\.json: read-only file system$/.test(m)),
      said.join("; ")
    ).toBe(true);
  });
});

describe("createAssistantSupervisor re-wakes", () => {
  it("should replace a queued wake in place when the same conversation is woken with a new session", async () => {
    // Arrange
    const { tmux, supervisor } = setup({ max: 1 });
    const [running, waiting] = [conversation(), conversation()];
    await supervisor.wake(running);
    hookStatus(running.session_id, "busy");
    await supervisor.tick();
    await supervisor.wake(waiting);
    const cleared = { ...waiting, session_id: "sess-after-clear", resume: true };

    // Act
    await supervisor.wake(cleared);

    // Assert
    expect(supervisor.queue.map((w) => w.session_id)).toEqual(["sess-after-clear"]);

    // Act
    tmux.alive.delete(tmuxName(running.conversation_id));
    await supervisor.tick();

    // Assert
    expect(tmux.starts().at(-1)?.command).toBe(claudeCommand("sess-after-clear", true));
  });

  it("should report what it runs whether or not it changed when the report is forced", async () => {
    // Arrange
    const { supervisor, reports } = setup();

    // Act
    const first = await supervisor.report();
    const unchanged = await supervisor.report();
    const forced = await supervisor.report({ force: true });

    // Assert
    expect([first, unchanged, forced]).toEqual(["reported", "unchanged", "reported"]);
    expect(reports).toEqual([
      { sessions: [], max: 2 },
      { sessions: [], max: 2 }
    ]);
  });
});

describe("maxSessions and idleMinutes", () => {
  it("should take the cap from AGENT_HUB_MAX_SESSIONS when it is a number from 1 to 20", () => {
    // Act & Assert
    expect(maxSessions({})).toBe(2);
    expect(maxSessions({ AGENT_HUB_MAX_SESSIONS: "6" })).toBe(6);
    expect(maxSessions({ AGENT_HUB_MAX_SESSIONS: "0" })).toBe(1);
    expect(maxSessions({ AGENT_HUB_MAX_SESSIONS: "99" })).toBe(20);
    expect(maxSessions({ AGENT_HUB_MAX_SESSIONS: "lots" })).toBe(2);
  });

  it("should take the idle limit from AGENT_HUB_SESSION_IDLE_MINUTES when it is a number from 1 to a day", () => {
    // Act & Assert
    expect(idleMinutes({})).toBe(20);
    expect(idleMinutes({ AGENT_HUB_SESSION_IDLE_MINUTES: "5" })).toBe(5);
    expect(idleMinutes({ AGENT_HUB_SESSION_IDLE_MINUTES: "0" })).toBe(1);
    expect(idleMinutes({ AGENT_HUB_SESSION_IDLE_MINUTES: "9999" })).toBe(1440);
    expect(idleMinutes({ AGENT_HUB_SESSION_IDLE_MINUTES: "soon" })).toBe(20);
  });
});
