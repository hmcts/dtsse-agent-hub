// How a conversation's Claude is started and stopped: one detached tmux session per conversation, named after
// it, so a restarted supervisor can find the sessions it left running and a person can attach to one.
import { execFile } from "node:child_process";

/** The system prompt the pod appends for a conversation's session. It is a cft-workspace file, not this package's. */
export const PROMPT_FILE = ".devcontainer/virtual-agent/assistant-prompt.md";

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

// `hai` is the HMCTS wrapper around `claude`: it forwards these arguments and never adds one of its own, so
// `--dangerously-skip-permissions` has to be here. Nobody can answer a prompt in a pod, and the first one would
// hang the session. The prompt file is appended on a resume too: Claude Code keeps no system prompt in the transcript.
export function claudeCommand(sessionId: string, resume: boolean): string {
  return `hai --dangerously-skip-permissions ${resume ? "--resume" : "--session-id"} ${sessionId} --append-system-prompt-file ${PROMPT_FILE}`;
}

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
    async sendKeys(name, ...keys) {
      await tmux(["send-keys", "-t", name, ...keys]);
    },
    async kill(name) {
      await tmux(["kill-session", "-t", name]);
    }
  };
}
