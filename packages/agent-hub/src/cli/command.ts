// What every command is handed, and the argument checks the commands share.
import fs from "node:fs";
import { loadAgent, normaliseTopics, type StoredAgent } from "../agent.ts";
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import { CLI } from "../envelope.ts";
import { findSecret } from "../secret-scan.ts";
import { isEnabled } from "../session.ts";

/** Everything a command may print, read or call, so none of it reaches for the process directly. */
export type Cli = {
  env: Env;
  /** A hub client; one per call, as each command made its own. */
  api: () => Api;
  /** Raw writes: a credential value and a hook's JSON go out exactly as they are. */
  stdout: Pick<NodeJS.WriteStream, "write">;
  print: (message: string) => void;
  printError: (message: string) => void;
  readStdin: () => string;
  cwd: () => string;
};

export type Command = (cli: Cli, args: string[]) => Promise<number>;

/** A command the caller got wrong, which exits 2; anything else that fails exits 1. */
export class UsageError extends Error {}

export type ParsedFlags = {
  flags: Record<string, string>;
  rest: string[];
};

/** `--name value` and `--name=value`, with anything else kept in order; an unknown name is a usage error. */
export function parseFlags(argv: string[], spec: readonly string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!spec.includes(name)) {
        throw new UsageError(`unknown option --${name}`);
      }
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length) {
        flags[name] = argv[++i] as string;
      } else {
        throw new UsageError(`--${name} needs a value`);
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

/** stdin as one string. A terminal and an unreadable stdin both read as empty, which each caller refuses. */
export function readStdinText(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A saved agent the hub has answered for: without an id there is nothing for a command to act as. */
type EnabledAgent = StoredAgent & { agent_id: string };

export function requireAgent(sid: string): EnabledAgent {
  const agent = loadAgent(sid);
  if (!agent?.agent_id || !isEnabled(sid)) {
    throw new Error(`agent-hub is not enabled for this session. Run /enable-comms (${CLI} enable) first.`);
  }
  return { ...agent, agent_id: agent.agent_id };
}

export type TopicsOrDieOptions = {
  min?: number;
  max?: number;
};

export function topicsOrDie(list: readonly unknown[], { min = 1, max = Number.POSITIVE_INFINITY }: TopicsOrDieOptions = {}): string[] {
  const { good, bad } = normaliseTopics(list);
  if (bad.length) {
    throw new UsageError(`invalid topic slug(s): ${bad.join(", ")} (must match ^[a-z0-9][a-z0-9-]{0,63}$)`);
  }
  if (good.length < min) {
    throw new UsageError(`at least ${min} topic(s) required`);
  }
  if (good.length > max) {
    throw new UsageError(`at most ${max} topics allowed`);
  }
  return good;
}

export function refuseSecrets(text: string): void {
  const pattern = findSecret(text);
  if (pattern) {
    throw new Error(`refusing to send: the text contains a secret-shaped string (pattern ${pattern}). Remove it and retry.`);
  }
}

export function textArg(cli: Cli, rest: string[], what: string): string {
  const text = rest.length && rest[0] !== "-" ? rest.join(" ") : cli.readStdin();
  if (!text.trim()) {
    throw new UsageError(`${what} is empty`);
  }
  return text;
}
