// The supervisor on a real sessions stream: the mock hub's wakes and closes, and how it reconnects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { conversation, fakeTmux } from "../__fixtures__/fake-tmux.ts";
import { createMockHub } from "../__fixtures__/mock-hub.ts";
import { ApiError, createApi } from "../api.ts";
import { hubHome } from "../session.ts";
import type { MemoryFs } from "./memory.ts";
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
  it("should answer a lookup on the sessions stream with what twg found, without waiting on the supervisor", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const lookupId = "5b0e7c1a-1111-4222-8333-444455556666";
    const projects = JSON.stringify({ data: { status: 200, body: { values: [{ key: "VIBE", name: "Vibe-Coding Enablement" }] } } });
    const twg: string[][] = [];
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      lookups: {
        run: async (_cmd, args) => {
          twg.push(args);
          return { code: 0, stdout: projects, stderr: "" };
        },
        login: async () => true
      }
    });

    try {
      await waitUntil(() => hub.sessionStreams.has(VID), "the sessions stream to open");

      // Act
      hub.sendLookup(VID, { lookup_id: lookupId, kind: "jira_project", query: "vibe", space: null, sign_in: false });

      // Assert
      await waitUntil(() => hub.lookupAnswers.length === 1, "the lookup to be answered");
      expect(hub.lookupAnswers[0]).toEqual({ virtual_id: VID, lookup_id: lookupId, body: { results: [{ key: "VIBE", name: "Vibe-Coding Enablement" }] } });
      expect(twg[0]?.slice(0, 2)).toEqual(["api", "jira:/rest/api/3/project/search"]);
    } finally {
      stop.abort();
      await running;
      await hub.close();
    }
  });

  it("should run a Welsh job on the sessions stream with the welsh plugin's script and answer what it printed", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const jobId = "6c1f8d2b-1111-4222-8333-444455556666";
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "welsh-ws-"));
    const plugin = path.join(workspace, "welsh", ".claude");
    fs.mkdirSync(path.join(workspace, ".claude-plugin"));
    fs.writeFileSync(path.join(workspace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "welsh", source: "./welsh/.claude" }] }));
    fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(plugin, "scripts"));
    fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "welsh" }));
    fs.writeFileSync(path.join(plugin, "scripts", "welsh"), "#!/bin/sh\n");
    const ran: { cmd: string; args: string[] }[] = [];
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: { AGENT_HUB_PLUGINS: "welsh" },
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      welsh: {
        workspace,
        run: async (cmd, args) => {
          ran.push({ cmd, args });
          return { code: 0, stdout: JSON.stringify({ total: 0, hits: [] }), stderr: "0 match(es)" };
        }
      }
    });

    try {
      await waitUntil(() => hub.sessionStreams.has(VID), "the sessions stream to open");

      // Act
      hub.sendWelsh(VID, { job_id: jobId, kind: "search", product: "cath", args: { query: "back" } });

      // Assert
      await waitUntil(() => hub.welshAnswers.length === 1, "the Welsh job to be answered");
      expect(hub.welshAnswers[0]).toEqual({ virtual_id: VID, job_id: jobId, body: { result: { total: 0, hits: [], message: "0 match(es)" } } });
      expect(ran[0]?.cmd).toBe(path.join(plugin, "scripts", "welsh"));
      expect(ran[0]?.args.at(-1)).toBe("back");
    } finally {
      stop.abort();
      await running;
      await hub.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

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

  it("should send Escape to a conversation's pane, and keep its session, when the sessions stream carries an interrupt", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const tmux = fakeTmux();
    const stop = new AbortController();
    const c = conversation();
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
    const name = tmuxName(c.conversation_id);

    try {
      hub.sendWake(VID, c);
      await waitUntil(() => tmux.starts().length === 1, "the wake to start a session");

      // Act
      hub.sendInterrupt(VID, { conversation_id: c.conversation_id });

      // Assert
      await waitUntil(() => tmux.sent(name).length === 1, "the pane to be sent a key");
      expect(tmux.sent(name)).toEqual([["send-keys", name, "Escape"]]);
      expect(tmux.alive.has(name), "the session outlives the interrupt").toBe(true);
      expect(tmux.killed(name)).toBe(false);
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
      conversations: async () => ({ conversations: [] }),
      putUploads: async () => null,
      putLookup: async () => null,
      putWelsh: async () => null,
      putWelshFile: async () => ({ file_id: "f" }),
      welshFile: async () => new Uint8Array(),
      putMemory: async () => null,
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

  it("should reconcile the uploads on disk against the hub's conversations on its own interval", async () => {
    // Arrange: a directory for a conversation the hub no longer has, as a conversation deleted while this pod was
    // stopped would leave behind — it sends no close anybody was there to hear.
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const uploads = fs.mkdtempSync(path.join(home.root, "run-uploads-"));
    const gone = "99999999-8888-7777-6666-555555555555";
    fs.mkdirSync(path.join(uploads, gone), { recursive: true });
    const said: string[] = [];
    const stop = new AbortController();
    const running = runAssistantSupervisor({
      api: {
        putSessions: async () => null,
        conversations: async () => ({ conversations: [] }),
        putUploads: async () => null,
        putLookup: async () => null,
        putWelsh: async () => null,
        putWelshFile: async () => ({ file_id: "f" }),
        welshFile: async () => new Uint8Array(),
        putMemory: async () => null,
        sessionsStream: async () => new Response("", { status: 200 })
      },
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      uploadsDir: uploads,
      signal: stop.signal,
      tickMs: 1000,
      reconcileMs: 20,
      say: (m) => said.push(m)
    });

    try {
      // Act & Assert
      await waitUntil(() => !fs.existsSync(path.join(uploads, gone)), "the stale uploads to be removed");
      expect(said).toContain(`removed the uploads of conversation ${gone}, which the hub no longer has`);
    } finally {
      stop.abort();
      await running;
      fs.rmSync(uploads, { recursive: true, force: true });
    }
  });

  // A session starting or ending steps the container's `anon` by about one conversation, and nothing else steps it.
  // It is also what the hub's low-memory warning is computed from, so a report that waited for the ten-minute
  // reconcile would leave the warning describing a pod the person has already changed. Work inside a session moves
  // `anon` with no step to trigger on, which is what keeps that reconcile worth having.
  it("should report its memory as soon as the number of sessions changes, not on the next reconcile", async () => {
    // Arrange: a reconcile far longer than the test, so only the session change can have caused a report.
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const memoryFs = {
      readFileSync: (file: string) => (String(file).endsWith("memory.stat") ? "anon 1717986918\n" : "4096\n")
    } as unknown as MemoryFs;
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 20,
      reconcileMs: 10 * 60 * 1000,
      memoryFs
    });
    const memoryPuts = () => hub.calls.filter((c) => c.method === "PUT" && c.path === `/api/virtual/${VID}/memory`);

    try {
      // Act
      hub.sendWake(VID, conversation());

      // Assert
      await waitUntil(() => memoryPuts().length >= 1, "the session starting to be reported as memory");
    } finally {
      stop.abort();
      await running;
      await hub.close();
    }
  });

  // The guard on `sendMemory`, which the tick and the reconcile both reach. Two overlapping PUTs can be stored in
  // either order and the later-stored one wins, so an in-flight report must not be joined by a second: the hub would
  // be left showing whichever measurement happened to land last rather than the newest one. Skipped rather than
  // queued, because every caller only ever wants the latest reading.
  it("should send no second memory report while one is still in flight", async () => {
    // Arrange: a report that never settles, and a tick and reconcile fast enough to ask for several more.
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const stop = new AbortController();
    const attempts: unknown[] = [];
    let release: () => void = () => {};
    const held = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const api = {
      putSessions: async () => null,
      conversations: async () => ({ conversations: [] }),
      putUploads: async () => null,
      putLookup: async () => null,
      putWelsh: async () => null,
      putWelshFile: async () => ({ file_id: "f" }),
      welshFile: async () => new Uint8Array(),
      putMemory: async (_id: string, body: unknown) => {
        attempts.push(body);
        return await held;
      },
      sessionsStream: async () => new Response("", { status: 200 })
    };
    const memoryFs = {
      readFileSync: (file: string) => (String(file).endsWith("memory.stat") ? "anon 1717986918\n" : "4096\n")
    } as unknown as MemoryFs;
    const running = runAssistantSupervisor({
      api,
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 10,
      reconcileMs: 10,
      memoryFs
    });

    try {
      // Act: the report sent before the loop takes the guard; every tick and reconcile after it asks for another.
      await waitUntil(() => attempts.length === 1, "the first memory report to be in flight");
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Assert
      expect(attempts).toHaveLength(1);
    } finally {
      release();
      stop.abort();
      await running;
    }
  });

  it("should say so and fall back to a backoff when sessions streams keep ending as they open, without a reconnect event", async () => {
    // Arrange
    fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
    const said: string[] = [];
    const stop = new AbortController();
    const api = {
      putSessions: async () => null,
      conversations: async () => ({ conversations: [] }),
      putUploads: async () => null,
      putLookup: async () => null,
      putWelsh: async () => null,
      putWelshFile: async () => ({ file_id: "f" }),
      welshFile: async () => new Uint8Array(),
      putMemory: async () => null,
      sessionsStream: async () => new Response("", { status: 200 })
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
      conversations: async () => ({ conversations: [] }),
      putUploads: async () => null,
      putLookup: async () => null,
      putWelsh: async () => null,
      putWelshFile: async () => ({ file_id: "f" }),
      welshFile: async () => new Uint8Array(),
      putMemory: async () => null,
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
      conversations: async () => ({ conversations: [] }),
      putUploads: async () => null,
      putLookup: async () => null,
      putWelsh: async () => null,
      putWelshFile: async () => ({ file_id: "f" }),
      welshFile: async () => new Uint8Array(),
      putMemory: async () => null,
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

describe("runAssistantSupervisor and the uploads on its volume", () => {
  const CONVERSATION = "11111111-2222-3333-4444-555555555555";
  const UPLOAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const KEEP = "11112222-3333-4444-5555-666677778888";

  /** A `statfs` that answers for any path, so the measurement does not depend on the test machine's own volume. */
  function volume(): { statfsSync: () => ReturnType<typeof fs.statfsSync> } {
    return { statfsSync: () => ({ type: 0, bsize: 4096, frsize: 4096, blocks: 1024, bfree: 512, bavail: 512, files: 0, ffree: 0 }) };
  }

  function written(root: string, uploadId: string): string {
    const file = path.join(root, CONVERSATION, `${uploadId}-letter.pdf`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(16));
    return file;
  }

  // The delete is replayed until a report stops naming the file, so the report straight after the deletion is what
  // ends it — without it the settings would say "waiting for your assistant" for ten minutes rather than seconds.
  it("should delete the files the hub names and report its volume straight after, when the person asks", async () => {
    const hub = createMockHub({ pingMs: 5000, maxLifetimeMs: 60_000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-run-uploads-"));
    const going = written(root, UPLOAD);
    const staying = written(root, KEEP);
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      uploadsDir: root,
      uploadsFs: { ...fs, ...volume() } as never
    });
    const reports = () => hub.virtuals.get(VID)?.uploadsReports ?? [];

    try {
      await hub.waitFor((call) => call.method === "GET" && call.path === `/api/virtual/${VID}/sessions`);
      hub.sendDeleteUploads(VID, { conversation_id: CONVERSATION, upload_ids: [UPLOAD] });
      await waitUntil(() => reports().length > 0, "a report after the deletion");

      expect(fs.existsSync(going), "the file the person asked to delete").toBe(false);
      expect(fs.existsSync(staying), "a file they did not ask about").toBe(true);
      expect(reports()[0]).toMatchObject({ uploads_bytes: 16, volume_used_bytes: 512 * 4096, volume_total_bytes: 1024 * 4096, files_total: 1 });
      expect((reports()[0]!.files as { upload_id: string }[]).map((file) => file.upload_id)).toEqual([KEEP]);
      // The acknowledgement, which is the only thing that ends the hub's request. Absence from `files` says nothing:
      // that list is the largest 200, so a file outside it is unnamed while still sitting on the volume.
      expect(reports()[0]?.deleted).toEqual([UPLOAD]);
    } finally {
      stop.abort();
      await running;
      await hub.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("should report nothing and carry on when the frame names no file this pod could act on", async () => {
    const hub = createMockHub({ pingMs: 5000, maxLifetimeMs: 60_000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-run-uploads-"));
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      uploadsDir: root,
      uploadsFs: { ...fs, ...volume() } as never
    });

    try {
      await hub.waitFor((call) => call.method === "GET" && call.path === `/api/virtual/${VID}/sessions`);
      hub.sendDeleteUploads(VID, { conversation_id: "not-a-conversation", upload_ids: [UPLOAD] });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(hub.virtuals.get(VID)?.uploadsReports ?? []).toEqual([]);
    } finally {
      stop.abort();
      await running;
      await hub.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runAssistantSupervisor and a file it cannot delete", () => {
  const CONVERSATION = "11111111-2222-3333-4444-555555555555";
  const UPLOAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  // The frame asks, the deletion fails, and a report would say so by acknowledging nothing — which the hub answers
  // with another frame. That is a loop between the two ends with no backoff and nothing giving up, so the pod sends
  // nothing at all and the hub asks again when the stream next opens.
  it("should send no report, and leave the file, when every deletion the hub asked for failed", async () => {
    const hub = createMockHub({ pingMs: 5000, maxLifetimeMs: 60_000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    const url = await hub.listen();
    const stop = new AbortController();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-run-stuck-"));
    const file = path.join(root, CONVERSATION, `${UPLOAD}-letter.pdf`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(16));
    const said: string[] = [];
    const uploadsFs = {
      ...fs,
      statfsSync: () => ({ type: 0, bsize: 4096, blocks: 1024, bfree: 512, bavail: 512, files: 0, ffree: 0 }),
      rmSync: () => {
        throw new Error("read-only volume");
      }
    };
    const running = runAssistantSupervisor({
      api: createApi({ baseUrl: url, launchToken: LAUNCH }),
      id: VID,
      env: {},
      tmux: fakeTmux(),
      canRun: () => true,
      cwd: CWD,
      signal: stop.signal,
      tickMs: 50,
      uploadsDir: root,
      uploadsFs: uploadsFs as never,
      say: (message) => said.push(message)
    });

    try {
      await hub.waitFor((call) => call.method === "GET" && call.path === `/api/virtual/${VID}/sessions`);
      hub.sendDeleteUploads(VID, { conversation_id: CONVERSATION, upload_ids: [UPLOAD] });
      await waitUntil(() => said.some((message) => message.includes("could not be deleted")), "the pod to give up on the deletion");
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(hub.virtuals.get(VID)?.uploadsReports ?? [], "no report, so the hub keeps asking rather than being told it is done").toEqual([]);
      expect(fs.existsSync(file), "the file the person asked about is still there").toBe(true);
      expect(said.join("\n")).toContain("the hub will ask again");
    } finally {
      stop.abort();
      await running;
      await hub.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
