// Running the commands a pod signs in with, and making their output fit to log. A token can be in that output, so
// none of it reaches a log whole: the only output the sign-ins print anywhere goes through `outputTail`, which
// redacts every credential shape the hub itself recognises first. A `say(output)` that does not is a sign-in's
// token in `kubectl logs`.
import { spawn } from "node:child_process";
import type { Env } from "../env.ts";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
};

/**
 * How long a sign-in command gets to end on its own after SIGTERM before it is killed. Long enough for one that
 * is writing its credential file to finish, short enough that nothing waits on it: the caller above has no
 * timeout of its own, so a child that never closes is a pod that never gets any further.
 */
export const SIGKILL_AFTER_MS = 5000;

/** The environment a child gets: `Env` plus the variables only the command being run knows about. */
export function childEnv(env: Env, drop: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of drop) {
    delete out[name];
  }
  return out;
}

/** Runs a command to completion; its output is returned, never printed, because some of it is secret. */
export function run(cmd: string, args: string[], { env = process.env, timeoutMs = 60000, input }: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout, stderr: (e as Error).message });
      return;
    }
    // Declared before `finish` closes over them rather than after, so that a synchronous caller added later is
    // an undefined timer to clear and not a temporal dead zone to throw out of the promise.
    let timer: NodeJS.Timeout | undefined;
    let abandon: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (abandon) {
        clearTimeout(abandon);
      }
      resolve(result);
    };
    // The kill is certain and `close` is not: it waits for these pipes to close, and a command that forked
    // leaves descendants holding the write ends, so the timeout alone bounds nothing. `relayDeviceLogin` gives
    // up the same way and for the same reason — the handles are ref'd, and the CLI exits only when the loop
    // drains, so a caller would wait on this for ever rather than for `timeoutMs`.
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      abandon ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: 1, stdout, stderr });
      }, SIGKILL_AFTER_MS);
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      finish({ code: 127, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** OSC sequences, CSI sequences, charset selections and the single-character escapes, in that order. */
export function stripAnsi(text: string): string {
  return (
    String(text)
      // biome-ignore-start lint/suspicious/noControlCharactersInRegex: ESC and BEL are what these sequences are made of
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[()][A-Za-z0-9]/g, "")
      .replace(/\x1b[=>78]/g, "")
    // biome-ignore-end lint/suspicious/noControlCharactersInRegex: as above
  );
}

export const REDACTED = "[redacted]";

/**
 * The credential shapes worth matching, for the commands whose output is quoted: `relayDeviceLogin` does that
 * for all three of its callers — `gh`, `az` and `twg` — so a list that knew only GitHub's shapes would be a
 * safety net for one of them.
 *
 * This is a denylist and cannot be more than that. The first three are the hub's own `GITHUB_TOKEN` check in
 * `src/credentials/validate.ts` — a prefixed token and a fine-grained PAT — widened by `r` for the refresh
 * tokens `gh` also writes, plus the 40-hex classic token. A git SHA matches that one and goes with it, which
 * costs nothing: no SHA is why a sign-in failed. Then its `CLAUDE_TOKEN` shape, the token values of the
 * `atlassian` credential's `*-token=` lines, and a JWT, which is what an access token looks like whoever issued
 * it. A twg refresh token written any other way — as JSON, say — is not matched.
 *
 * One kind the hub stores has no shape here and can have none: a `jenkins` token is any printable string. It does
 * not appear in these three commands' output, which is why quoting it is safe today; a fourth caller, or a command
 * that learns to print one, is not covered by anything here.
 *
 * A shape added to the validator belongs here too wherever it can be written as one.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_\w{20,}/g,
  /\b[0-9a-f]{40}\b/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // A lookbehind rather than a group, so every shape here replaces whole and the key is left to read. The value
  // class takes `%` as well, because a token under one of these keys is as likely to be percent-encoded in a
  // redirect or a form body as it is to be raw, and stopping at the escape printed the rest of it.
  /(?<=\b(?:oauth-access-token|oauth-refresh-token|access_token|refresh_token)[=:]\s?"?)[A-Za-z0-9._~+/=%-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*/g
];

/**
 * Replaces every credential-shaped run, so a command's own words can be logged. A device code is left alone: it
 * is relayed to the owner and logged beside the relay anyway, and it is what says whether an error is about the
 * code the owner is holding.
 *
 * Give it text whose whitespace is already collapsed, as `outputTail` does: the shapes that read a key before
 * their value allow one space between them, so a value the command wrapped or indented away from its key goes
 * unmatched. `outputTail` is the way in for anything a command printed; this is exported for a caller that has
 * one string and knows its shape.
 */
export function redactTokens(text: string): string {
  let out = text;
  for (const shape of CREDENTIAL_SHAPES) {
    out = out.replace(shape, REDACTED);
  }
  return out;
}

export const OUTPUT_TAIL_CHARS = 400;

/**
 * A command's output as one line fit to log: escapes gone, tokens redacted, whitespace collapsed and at most
 * `max` characters kept. The tail rather than the head, because the reason a command stopped is its last word.
 */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string {
  // Whitespace is collapsed before anything is matched, not after: the shapes that read a key before their value
  // allow one space after it, and a command that wrapped the line or indented it would otherwise slip the value
  // past them and have this print it on one tidy line.
  const line = redactTokens(stripAnsi(text).replace(/\s+/g, " ")).trim();
  return line.length <= max ? line : `…${line.slice(line.length - max)}`;
}
