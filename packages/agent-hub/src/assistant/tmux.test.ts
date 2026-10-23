// The tmux wrapper: the argv each call builds, and the real `execFile` path against a fake tmux on PATH.
//
// The workspace suite tested none of this — `assistant.test.mjs` only ever used a fake tmux — so these are new,
// and the fake tmux below is the one the supervisor's own tests drive through `createAssistantSupervisor`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canRunProgram, claudeCommand, commandProgram, createTmux, PROMPT_FILE, type TmuxExec, type TmuxResult, tmuxName } from "./tmux.ts";

let binDir: string;

// A `tmux` on PATH that prints its arguments and exits 7 for any call naming the session "fail".
beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-tmux-"));
  fs.writeFileSync(
    path.join(binDir, "tmux"),
    [
      "#!/bin/sh",
      'echo "$@"',
      'for a in "$@"; do',
      '  if [ "$a" = "fail" ]; then',
      '    echo "no server running" >&2',
      "    exit 7",
      "  fi",
      "done",
      "exit 0",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
});

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

function recorder(result: Partial<TmuxResult> = {}): { args: string[][]; exec: TmuxExec } {
  const args: string[][] = [];
  const exec: TmuxExec = async (a) => {
    args.push(a);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { args, exec };
}

describe("tmuxName", () => {
  it("should name the session after the first 8 hex digits of the conversation when given its id", () => {
    // Act & Assert
    expect(tmuxName("0F8A6A1E-1234-4000-8000-000000000001")).toBe("c-0f8a6a1e");
    expect(tmuxName("0f8a6a1e-1234-4000-8000-000000000001")).toBe("c-0f8a6a1e");
  });
});

describe("claudeCommand", () => {
  it("should append the prompt file and choose --resume or --session-id when told whether to resume", () => {
    // Act & Assert
    expect(claudeCommand("sess-1", false)).toBe(`hai --dangerously-skip-permissions --session-id sess-1 --append-system-prompt-file ${PROMPT_FILE}`);
    expect(claudeCommand("sess-1", true)).toBe(`hai --dangerously-skip-permissions --resume sess-1 --append-system-prompt-file ${PROMPT_FILE}`);
  });
});

describe("commandProgram", () => {
  it("should be the first word when given a command of either shape the launcher has had", () => {
    // Act & Assert
    expect(commandProgram(claudeCommand("sess-1", false))).toBe("hai");
    expect(commandProgram(".claude/run.sh --session-id sess-1")).toBe(".claude/run.sh");
    expect(commandProgram("  hai  --resume sess-1 ")).toBe("hai");
    expect(commandProgram("")).toBe("");
  });
});

// The real check, against files on disk, with the pane's working directory and PATH given explicitly rather than
// inherited: a bare name is looked up on PATH and a path is resolved against that directory.
describe("canRunProgram", () => {
  let paneDir: string;
  let launcherBin: string;

  beforeAll(() => {
    paneDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-pane-"));
    launcherBin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-launcher-"));
    fs.writeFileSync(path.join(launcherBin, "faux-launcher"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(paneDir, "launcher.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(paneDir, "not-executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    fs.mkdirSync(path.join(paneDir, "a-directory"));
  });

  afterAll(() => {
    fs.rmSync(paneDir, { recursive: true, force: true });
    fs.rmSync(launcherBin, { recursive: true, force: true });
  });

  it("should be true for a bare name when it is on PATH, and false when it is not", () => {
    // Act & Assert
    expect(canRunProgram("faux-launcher", { cwd: paneDir, env: { PATH: `${launcherBin}:/usr/bin:/bin` } })).toBe(true);
    expect(canRunProgram("faux-launcher", { cwd: paneDir, env: { PATH: "/usr/bin:/bin" } })).toBe(false);
  });

  it("should be true for a relative path when it resolves in the pane's working directory, and false when it does not", () => {
    // Act & Assert
    expect(canRunProgram("./launcher.sh", { cwd: paneDir, env: {} })).toBe(true);
    expect(canRunProgram("./nothing-here.sh", { cwd: paneDir, env: {} })).toBe(false);
  });

  it("should be false for a relative path that resolves against another directory", () => {
    // Act & Assert: the same program, asked of a directory it is not in.
    expect(canRunProgram("./launcher.sh", { cwd: launcherBin, env: {} })).toBe(false);
  });

  // A shell's `command -v` disagrees with itself here: bash says no, dash says yes for any path it can spell.
  it("should be false for a file that exists but is not executable", () => {
    // Act & Assert
    expect(fs.existsSync(path.join(paneDir, "not-executable.sh"))).toBe(true);
    expect(canRunProgram("./not-executable.sh", { cwd: paneDir, env: {} })).toBe(false);
  });

  it("should be false for a directory, which carries the execute bit but cannot be run", () => {
    // Act & Assert
    expect(canRunProgram("./a-directory", { cwd: paneDir, env: {} })).toBe(false);
    expect(canRunProgram("a-directory", { cwd: paneDir, env: { PATH: paneDir } })).toBe(false);
  });

  it("should be false for an empty program when the command line is empty", () => {
    // Act & Assert
    expect(canRunProgram("", { cwd: paneDir, env: { PATH: launcherBin } })).toBe(false);
  });

  it("should treat an empty PATH entry as the pane's working directory, as a shell does", () => {
    // Act & Assert
    expect(canRunProgram("launcher.sh", { cwd: paneDir, env: { PATH: "/usr/bin:" } })).toBe(true);
  });
});

describe("createTmux", () => {
  it("should pass the name, size, working directory and environment when it starts a session", async () => {
    // Arrange
    const { args, exec } = recorder();

    // Act
    await createTmux({ exec }).start({ name: "c-0f8a6a1e", cwd: "/w", vars: { AGENT_HUB_CONVERSATION_ID: "c1" }, command: "hai" });

    // Assert
    expect(args).toEqual([["new-session", "-d", "-s", "c-0f8a6a1e", "-x", "220", "-y", "50", "-c", "/w", "-e", "AGENT_HUB_CONVERSATION_ID=c1", "hai"]]);
  });

  it("should throw with the exit code and stderr when new-session fails", async () => {
    // Arrange
    const { exec } = recorder({ code: 3, stderr: "  no space left\n" });

    // Act & Assert
    await expect(createTmux({ exec }).start({ name: "c-1", cwd: "/w", command: "x" })).rejects.toThrow("tmux new-session exited 3: no space left");
  });

  it("should throw the exit code alone when new-session fails silently", async () => {
    // Arrange
    const { exec } = recorder({ code: 1 });

    // Act & Assert
    await expect(createTmux({ exec }).start({ name: "c-1", cwd: "/w", command: "x" })).rejects.toThrow("tmux new-session exited 1");
  });

  it("should send the keys to the named session and kill it by name when asked", async () => {
    // Arrange
    const { args, exec } = recorder();
    const tmux = createTmux({ exec });

    // Act
    await tmux.sendKeys("c-1", "/exit", "Enter");
    await tmux.kill("c-1");

    // Assert
    expect(args).toEqual([
      ["send-keys", "-t", "c-1", "/exit", "Enter"],
      ["kill-session", "-t", "c-1"]
    ]);
  });

  it("should list the trimmed session names and say a session exists when tmux answers 0", async () => {
    // Arrange
    const tmux = createTmux({ env: { PATH: binDir } });

    // Act
    const names = await tmux.list();

    // Assert: the fake tmux echoes its arguments, one line.
    expect(names).toEqual(["list-sessions -F #{session_name}"]);
    expect(await tmux.has("c-0f8a6a1e")).toBe(true);
  });

  it("should list nothing and say a session is absent when tmux exits non-zero, which is what no server looks like", async () => {
    // Arrange
    const { exec } = recorder({ code: 1, stdout: "c-0f8a6a1e\n" });
    const tmux = createTmux({ exec });

    // Act & Assert
    expect(await tmux.list()).toEqual([]);
    expect(await tmux.has("c-0f8a6a1e")).toBe(false);
  });

  it("should report the exit code and stderr of the real tmux when it fails", async () => {
    // Arrange
    const tmux = createTmux({ env: { PATH: binDir } });

    // Act & Assert
    await expect(tmux.start({ name: "fail", cwd: "/w", command: "x" })).rejects.toThrow("tmux new-session exited 7: no server running");
  });

  it("should report a code of 1 when tmux is not on PATH at all", async () => {
    // Arrange
    const tmux = createTmux({ env: { PATH: path.join(binDir, "empty") } });

    // Act & Assert
    expect(await tmux.list()).toEqual([]);
    await expect(tmux.start({ name: "c-1", cwd: "/w", command: "x" })).rejects.toThrow("tmux new-session exited 1");
  });
});
