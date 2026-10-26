// What `agent-hub jira export` and `agent-hub confluence export` share: the lock that keeps one export to one run,
// the check that twg is signed in as the owner, and the one line said when twg refuses. Each export keeps its own
// wording of what could not be made; these only take it.
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./env.ts";
import type { AtlassianLoginResult } from "./virtual/atlassian.ts";
import { type RunResult, stripAnsi } from "./virtual/sign-in.ts";

// The hub's export timeout: a lock older than this belongs to an export the hub has already given up on.
const LOCK_STALE_MS = 15 * 60_000;
const WHOAMI_TIMEOUT_MS = 30000;

/**
 * Claims the export for this process, so two messages delivered while it is pending cannot each run twg. False when
 * another live command holds it; a lock older than the hub's timeout is taken over.
 */
export function claimExport(dir: string, exportId: string): boolean {
  const lock = path.join(dir, `${exportId}.lock`);
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
  } catch {}
  fs.writeFileSync(lock, "", { mode: 0o600 });
  return true;
}

export function releaseExport(dir: string, exportId: string): void {
  fs.rmSync(path.join(dir, `${exportId}.lock`), { force: true });
}

export type TwgSignInDeps = {
  env: Env;
  run: (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;
  /** Signs twg in, relaying a device code to the owner; null outside a pod, where there is nobody to relay it to. */
  login: (() => Promise<AtlassianLoginResult>) | null;
  print: (message: string) => void;
};

/**
 * Null when twg is signed in, signing it in first when it is not and there is an owner to ask; otherwise why `what`
 * (such as "the ticket") could not be created, in a sentence the person is shown.
 */
export async function twgSignInProblem(deps: TwgSignInDeps, what: string): Promise<string | null> {
  const whoami = await deps.run("twg", ["whoami"], { env: deps.env, timeoutMs: WHOAMI_TIMEOUT_MS });
  if (whoami.code === 0) {
    return null;
  }
  if (whoami.code === 127) {
    return `twg is not installed here, so ${what} could not be created.`;
  }
  if (!deps.login) {
    return `twg is not signed in to Atlassian, so ${what} could not be created.`;
  }
  deps.print("agent-hub: twg is not signed in; asking the user to sign in to Atlassian");
  return (await deps.login()) === "not-signed-in" ? `The Atlassian sign-in was not completed, so ${what} could not be created.` : null;
}

/**
 * Why twg failed, in one line the person can read, after `refused` (such as "Jira refused the ticket"): its JSON
 * error message when it gave one, else the first line of its output. At most `max` characters.
 */
export function twgFailureLine(result: RunResult, refused: string, max: number): string {
  let message: unknown;
  try {
    const parsed = JSON.parse(result.stdout) as { error?: { message?: unknown } | string; message?: unknown } | null;
    message = typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.message ?? parsed?.message);
  } catch {}
  const line =
    (typeof message === "string" && message.trim()) ||
    stripAnsi(`${result.stderr}\n${result.stdout}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "");
  const why = line ? `${refused}: ${line}` : `twg exited ${result.code} without saying why.`;
  return why.length > max ? `${why.slice(0, max - 1)}…` : why;
}
