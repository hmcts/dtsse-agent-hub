// The supervisor on a real sessions stream: the mock hub's wakes and closes, and how it reconnects.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { conversation, fakeTmux } from "../__fixtures__/fake-tmux.ts";
import { createMockHub } from "../__fixtures__/mock-hub.ts";
import { ApiError, createApi } from "../api.ts";
import { hubHome } from "../session.ts";
import { runAssistantSupervisor } from "./run.ts";
import { tmuxName } from "./tmux.ts";

const CWD = "/workspace/cft-workspace";
const VID = "va-assist";
const LAUNCH = `launch-${"s".repeat(16)}`;
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) {
    savedEnv[key] = process.env[key];
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

async function waitUntil(fn: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("runAssistantSupervisor", () => {
  it("should start sessions for the wakes on the sessions stream, reconnect at once at its lifetime and stop one on close", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const hub = createMockHub({ pingMs: 5000, maxLifetimeMs: 600, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const tmux = fakeTmux();
    const stop = new AbortController();
    const [pending, live] = [conversation(), conversation()];
    hub.sendWake(VID, pending);
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux,
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50
    });
    const opens = () => hub.calls.filter((c) => c.method === "GET" && c.path === `/api/virtual/${VID}/sessions`);
    const reports = () => hub.virtuals.get(VID)?.sessionReports ?? [];

    try {
      // Act & Assert
      await waitUntil(() => tmux.starts().length === 1, "the pending wake to start a session");
      await waitUntil(() => opens().length >= 3, "two reconnects");
      expect(tmux.starts(), "a wake replayed on reconnect started a second session").toHaveLength(1);
      for (const [i, open] of opens().entries()) {
        if (i) {
          expect((open.at ?? 0) - (opens()[i - 1]?.at ?? 0), "reconnected after a backoff").toBeLessThan(600 + 500);
        }
      }

      // Act
      hub.sendWake(VID, live);

      // Assert
      await waitUntil(() => tmux.starts().length === 2, "the live wake to start a session");
      await waitUntil(() => reports().at(-1)?.sessions.length === 2, "both sessions reported");
      expect(
        reports()
          .at(-1)
          ?.sessions.map((e) => e.state)
      ).toEqual(["starting", "starting"]);

      // Act
      hub.sendClose(VID, { conversation_id: live.conversation_id });

      // Assert
      await waitUntil(() => tmux.sent(tmuxName(live.conversation_id)).length === 1, "the closed conversation to be stopped");
      await waitUntil(() => reports().at(-1)?.sessions.length === 1, "the closed one left out of the report");
    } finally {
      stop.abort();
      await running;
      await hub.close();
    }
  });

  it("should log a refused sessions stream as an ordinary error and retry it with backoff when the hub answers 403", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const opens: number[] = [];
    const said: string[] = [];
    const stop = new AbortController();
    const api = {
      putSessions: async () => null,
      sessionsStream: async (): Promise<Response> => {
        opens.push(Date.now());
        throw new ApiError(403, { error: "forbidden" }, "GET", `/api/virtual/${VID}/sessions`);
      }
    };
    const running = runAssistantSupervisor({
      api,
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      say: (m) => said.push(m)
    });

    try {
      // Act
      await waitUntil(() => opens.length >= 2, "the refused stream to be opened again");

      // Assert
      expect((opens[1] as number) - (opens[0] as number), "retried without a backoff").toBeGreaterThanOrEqual(900);
      expect(
        said.some((m) => m.startsWith(`sessions stream error: GET /api/virtual/${VID}/sessions failed: 403`)),
        said.join("; ")
      ).toBe(true);
    } finally {
      stop.abort();
      await running;
    }
  });

  it("should say so and fall back to a backoff when sessions streams keep ending as they open, without a reconnect event", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const said: string[] = [];
    const stop = new AbortController();
    const api = { putSessions: async () => null, sessionsStream: async () => new Response("", { status: 200 }) };
    const running = runAssistantSupervisor({
      api,
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      say: (m) => said.push(m)
    });

    try {
      // Act
      await waitUntil(() => said.some((m) => m.startsWith("sessions streams keep ending within")), "the backoff to be announced");

      // Assert
      expect(said).toContain("sessions stream ended without a reconnect event");
      expect(
        said.some((m) => m === "sessions streams keep ending within 2000ms; backing off 1000ms"),
        said.join("; ")
      ).toBe(true);
    } finally {
      // Aborting during the backoff wait, which is the only thing that wakes it early.
      stop.abort();
      await running;
    }
  });

  it("should reconnect when the sessions stream goes quiet for longer than the idle timeout", async () => {
    // Arrange: a stream that is opened, says nothing, and is aborted from the inside.
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const said: string[] = [];
    const stop = new AbortController();
    let opens = 0;
    const api = {
      putSessions: async () => null,
      sessionsStream: async (_id: string, opts: { signal?: AbortSignal } = {}): Promise<Response> => {
        opens += 1;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // A hand-made body is not ended by the AbortController the way fetch's is.
            opts.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          }
        });
        return new Response(body, { status: 200 });
      }
    };
    const running = runAssistantSupervisor({
      api,
      id: VID,
      env: {},
      tmux: fakeTmux(),
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      idleTimeoutMs: 60,
      say: (m) => said.push(m)
    });

    try {
      // Act
      await waitUntil(() => opens >= 2, "the quiet stream to be opened again");

      // Assert
      expect(said).toContain("no sessions stream traffic for 60ms; reconnecting");
    } finally {
      stop.abort();
      await running;
    }
  });

  it("should log an event it cannot parse and carry on when the stream sends one", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const said: string[] = [];
    const stop = new AbortController();
    const api = {
      putSessions: async () => null,
      sessionsStream: async () => new Response("event: wake\ndata: {oops\n\nevent: close\ndata: nope\n\nevent: reconnect\ndata: {}\n\n", { status: 200 })
    };
    const running = runAssistantSupervisor({
      api,
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      say: (m) => said.push(m)
    });

    try {
      // Act
      await waitUntil(() => said.includes("unparseable wake event") && said.includes("unparseable close event"), "both events to be refused");

      // Assert
      expect(said).not.toContain("sessions stream ended without a reconnect event");
    } finally {
      stop.abort();
      await running;
    }
  });
});
