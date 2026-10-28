// How a conversation's Claude is started and stopped: one detached tmux session per conversation, named after
// it, so a restarted supervisor can find the sessions it left running and a person can attach to one.
import { execFile } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../env.ts";

/**
 * The system prompt the pod appends for a conversation's session, shipped beside the pod runtime that starts the
 * supervisor. Absolute, resolved from this module rather than named relative to anything: tmux runs the command
 * line in the workspace, and the package is installed under a global `node_modules` that the workspace says
 * nothing about. `dist/assistant/` is two directories below the package root, which is where `virtual-agent/`
 * sits in both the source tree and the tarball.
 */
export const PROMPT_FILE = fileURLToPath(new URL("../../virtual-agent/assistant-prompt.md", import.meta.url));

const TMUX_TIMEOUT_MS = 10000;

export type TmuxResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type TmuxExec = (args: string[], opts: { env: NodeJS.ProcessEnv }) => Promise<TmuxResult>;

/** The tmux session a conversation's Claude runs in. */
export function tmuxName(conversationId: string): string {
  return `c-${conversationId.slice(0, 8).toLowerCase()}`;
}

// `hai` is the HMCTS wrapper around `claude`: it passes these arguments through untouched, and the only ones it adds
// of its own are `--settings` and a `--plugin-dir` per plugin — never a permission flag. So
// `--dangerously-skip-permissions` has to be here. Nobody can answer a prompt in a pod, and the first one would
// hang the session. The prompt file is appended on a resume too: Claude Code keeps no system prompt in the transcript.
//
// tmux runs this line through `/bin/sh -c`, so the prompt file is quoted: it is an install-derived absolute path
// now rather than a fixed name, and a package root holding a space would otherwise split into two arguments and
// start the session with no system prompt. Single quotes, because a path may hold a `$` or a backslash; one
// holding a single quote is the only shape left, and no npm prefix has one.
//
// `model` is what `launcherModel` gave — a bare family alias — quoted for the same shell, so whatever the hub sends
// is one argument and nothing in it is read as a glob. Without one the session runs on hai's default for the route.
export function claudeCommand(sessionId: string, resume: boolean, model: string | null = null): string {
  const base = `hai --dangerously-skip-permissions ${resume ? "--resume" : "--session-id"} ${sessionId} --append-system-prompt-file '${PROMPT_FILE}'`;
  return model === null ? base : `${base} --model '${model}'`;
}

/** The program a command line runs: its first word, which is always a bare `hai` and never quoted. */
export function commandProgram(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/** Whether a pane's program can be run, asked of the directory the pane will run in. */
export type ProgramCheck = (program: string, opts: { cwd: string; env: Env }) => boolean;

/**
 * Where a bare name is looked up when the environment names no PATH at all: the list both dash and bash search
 * with PATH unset. A shell falls back to that rather than to the working directory, and so does this. The whole
 * list matters, not a shorter stand-in: `npm install -g` on a default prefix puts a launcher in `/usr/local/bin`,
 * so leaving that out would refuse one the pane's shell would have found.
 */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function executableFile(file: string): boolean {
  try {
    nodeFs.accessSync(file, nodeFs.constants.X_OK);
    return nodeFs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a pane's program resolves, for both shapes this launcher has had: `hai`, found on PATH, and the
 * `.claude/run.sh` that came before it, a path relative to the checkout. A path is one that holds a separator, as
 * it is for a shell, and the answer is on executability rather than mere existence.
 *
 * Done here rather than with `command -v` in a shell because the two shells a pod might have disagree: bash tests
 * a slashed path for executability, and dash answers for any path that is merely spelled, so a non-executable
 * launcher would pass. Resolving in-process has one answer whatever `/bin/sh` is.
 *
 * `cwd` is the directory tmux will start the pane in, not this process's, because that is what a relative program
 * and a relative PATH entry are resolved against; checking from anywhere else would refuse a launcher that works.
 */
export const canRunProgram: ProgramCheck = (program, { cwd, env }) => {
  if (program === "") {
    return false;
  }
  if (program.includes("/")) {
    return executableFile(path.resolve(cwd, program));
  }
  // An empty entry in a PATH that was given means the working directory, as it does for a shell; no PATH at all
  // means the system default, which is a different thing.
  const search = env.PATH ?? DEFAULT_PATH;
  return search.split(path.delimiter).some((dir) => executableFile(path.resolve(cwd, dir === "" ? "." : dir, program)));
};

function runTmux(args: string[], { env }: { env: NodeJS.ProcessEnv }): Promise<TmuxResult> {
  return new Promise((resolve) => {
    execFile("tmux", args, { env, timeout: TMUX_TIMEOUT_MS }, (err, stdout, stderr) => {
      // `code` is the exit status for a command that ran and a string like ENOENT for one that could not.
      const status = (err as (Error & { code?: number | string }) | null)?.code;
      const code = err ? (typeof status === "number" ? status : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || err?.message || "") });
    });
  });
}

export type StartSessionOptions = {
  name: string;
  cwd: string;
  vars?: Record<string, string>;
  command: string;
};

export type Tmux = {
  list: () => Promise<string[]>;
  has: (name: string) => Promise<boolean>;
  start: (opts: StartSessionOptions) => Promise<void>;
  sendKeys: (name: string, ...keys: string[]) => Promise<void>;
  kill: (name: string) => Promise<void>;
};

export type CreateTmuxOptions = {
  env?: NodeJS.ProcessEnv;
  exec?: TmuxExec;
};

export function createTmux({ env = process.env, exec = runTmux }: CreateTmuxOptions = {}): Tmux {
  const tmux = (args: string[]) => exec(args, { env });
  return {
    // No tmux server, which is what no sessions looks like, is not an error.
    async list() {
      const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
      return r.code === 0
        ? r.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    },
    async has(name) {
      return (await tmux(["has-session", "-t", name])).code === 0;
    },
    async start({ name, cwd, vars = {}, command }) {
      const args = ["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", cwd];
      for (const [key, value] of Object.entries(vars)) {
        args.push("-e", `${key}=${value}`);
      }
      const r = await tmux([...args, command]);
      if (r.code !== 0) {
        throw new Error(`tmux new-session exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      }
    },
    // Throws on a refusal, as `start` does: every caller logs what went wrong and the keys are how a session is
    // told to exit or to end a turn, so keys that never arrived must not be reported as if they had.
    async sendKeys(name, ...keys) {
      const r = await tmux(["send-keys", "-t", name, ...keys]);
      if (r.code !== 0) {
        throw new Error(`tmux send-keys exited ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      }
    },
    async kill(name) {
      await tmux(["kill-session", "-t", name]);
    }
  };
}
