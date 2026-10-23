// The supervisor's decisions against a fake tmux and a fake clock: which conversations get a session, which wait,
// which are stopped, and what the hub is told. The sessions stream itself is in `run.test.ts`.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { conversation, fakeTmux } from "../__fixtures__/fake-tmux.ts";
import type { SessionsBody } from "../api.ts";
import { ensureStateDir, hubHome, projectTranscriptPath, statePath } from "../session.ts";
import { createAssistantSupervisor, EXIT_GRACE_MS, idleMinutes, maxSessions, parseSavedSession, parseWake } from "./supervisor.ts";
import { claudeCommand, PROMPT_FILE, tmuxName } from "./tmux.ts";

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

// A supervisor on a fake clock that starts at the real time, so the hooks' status files written now are "now".
function setup({ max = 2, idleMs = 20 * MINUTE }: { max?: number; idleMs?: number } = {}) {
  fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
  const tmux = fakeTmux();
  const reports: SessionsBody[] = [];
  const api = {
    putSessions: async (_id: string, body: SessionsBody) => {
      reports.push(body);
      return null;
    }
  };
  const clock = { t: Date.now() };
  const supervisor = createAssistantSupervisor({ api, id: "va-assist", tmux, now: () => clock.t, cwd: CWD, max, idleMs });
  return { tmux, reports, clock, supervisor, lastReport: () => reports.at(-1) as SessionsBody };
}

// What the hooks write for a session that has registered, as busy or idle, last changed `at` (ms).
function hookStatus(sid: string, status: "busy" | "idle", at = Date.now()): void {
  ensureStateDir(sid);
  fs.writeFileSync(statePath(sid, "enabled"), "x");
  fs.writeFileSync(statePath(sid, "status"), `${status}\n`);
  fs.utimesSync(statePath(sid, "status"), at / 1000, at / 1000);
}

describe("parseWake", () => {
  it("should keep the conversation, the session and the resume flag when the wake is one the pod can run", () => {
    // Arrange
    const c = conversation();

    // Act & Assert
    expect(parseWake({ ...c, resume: true, product: "pcs" })).toEqual({ conversation_id: c.conversation_id, session_id: c.session_id, resume: true });
    expect(parseWake(c)).toEqual({ conversation_id: c.conversation_id, session_id: c.session_id, resume: false });
    expect(parseWake({ ...c, resume: "yes" })).toEqual({ conversation_id: c.conversation_id, session_id: c.session_id, resume: false });
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
    const written = { ...c, resume: true, name: tmuxName(c.conversation_id), started_at: 1700000000000 };

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
    expect(start?.command).toBe(`hai --dangerously-skip-permissions --session-id ${c.session_id} --append-system-prompt-file ${PROMPT_FILE}`);
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

  it("should not stop a session when it is busy, however long ago it started", async () => {
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
    const supervisor = createAssistantSupervisor({ api, id: "va-assist", tmux: fakeTmux(), cwd: CWD });

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
    const supervisor = createAssistantSupervisor({ api: { putSessions: async () => null }, id: "va-assist", tmux, cwd: CWD, say: (m) => said.push(m) });
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
    const supervisor = createAssistantSupervisor({ api: { putSessions: async () => null }, id: "va-assist", tmux, cwd: CWD, say: (m) => said.push(m) });
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
