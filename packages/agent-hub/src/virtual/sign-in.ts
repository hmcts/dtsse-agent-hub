// Sign-ins a pod cannot do for itself. There is no browser and nobody at the keyboard, so every device-code
// flow is started here, its code read off the command's own output and relayed to the agent's owner through
// the hub, and the command left running until the owner completes it.
//
// A token can be in these commands' output, so none of it reaches a log whole: the only output printed anywhere
// here goes through `outputTail`, which redacts every credential shape the hub itself recognises first. A
// `say(output)` that does not is a sign-in's token in `kubectl logs`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Writable } from "node:stream";
import type { Api } from "../api.ts";
import { ApiError, createApi, DEFAULT_SCOPE } from "../api.ts";
import type { Env } from "../env.ts";
import { type RetryOptions, withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { azureDir, restoreAzureCache, syncAzureCache } from "./azure-cache.ts";
import { type DeviceCode, deviceFlowRetryable, oauthAppLabel, pollDeviceToken, requestDeviceCode } from "./github-device-flow.ts";
import { FatalError, say } from "./phases.ts";

export const DEVICE_CODE_EXPIRES_S = 900;
export const PASTE_CODE_EXPIRES_S = 600;

export type DeviceCodePrompt = {
  verification_uri: string;
  user_code: string;
};

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

/** Answers a command's prompts: it sees all of the output so far on every chunk. */
export type Respond = (output: string, stdin: Writable | null) => void;

export type RelayDeviceLoginOptions = {
  api: Pick<Api, "loginPrompt" | "virtualStatus">;
  id: string;
  kind: "azure" | "github" | "atlassian";
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  parse: (output: string) => DeviceCodePrompt | null;
  respond?: Respond;
  expiresIn?: number;
  /**
   * Whether the command's own output says it gave up waiting, for a command that says so in words. Read first,
   * because it is the command's own answer rather than an inference about it; the clock is the fallback.
   */
  isExpiry?: (output: string) => boolean;
  label: string;
};

/**
 * How much of `expiresIn` may be left on our clock and the code still count as expired. `relayedAt` is when the code
 * was parsed off the command's output, which is strictly after the command started its own timer, so our elapsed is
 * always short of its. A pty flush or a busy pod widens the gap; a command that gave up seconds early did so
 * because the code ran out, not because the sign-in broke.
 */
export const EXPIRY_TOLERANCE_S = 15;

/**
 * How long a sign-in command gets to end on its own after SIGTERM before it is killed. Long enough for one that
 * is writing its credential file to finish, short enough that nothing waits on it: the caller above has no
 * timeout of its own, so a child that never closes is a pod that never gets any further.
 */
export const SIGKILL_AFTER_MS = 5000;

export type RelayDeviceLoginResult = {
  code: number;
  output: string;
  /**
   * Whether the code was on the owner's screen until it ran out, rather than the sign-in breaking under them: the
   * two are the same exit code, and only one of them is worth offering the owner another code for.
   */
  expired: boolean;
};

export type LoginOptions = {
  api?: Api;
  env?: Env;
};

export type ClaudeLoginOptions = LoginOptions & {
  pollMs?: number;
  fallbackPollMs?: number;
  urlTimeoutMs?: number;
  tokenTimeoutMs?: number;
};

export type AzureLoginResult = "restored" | "signed-in";
export type ClaudeLoginResult = "stored" | "signed-in";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

// `az login --use-device-code` (2.88) writes this to stderr:
// "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code LNKR6UHMN to authenticate."
export function parseAzDeviceCode(text: string): DeviceCodePrompt | null {
  const m = /open the page (https:\/\/\S+?)\.? and enter the code ([A-Z0-9-]+)/.exec(text);
  return m ? { verification_uri: m[1] as string, user_code: m[2] as string } : null;
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

// `claude setup-token` draws a TUI: the URL comes as an OSC 8 hyperlink and again as plain text.
export function parseClaudeAuthorizeUrl(raw: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC 8 hyperlink is delimited by ESC and BEL
  const osc = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b\s]+)/.exec(raw);
  if (osc && /oauth\/authorize/.test(osc[1] as string)) {
    return osc[1] as string;
  }
  const plain = stripAnsi(raw);
  const m = /(https:\/\/\S+?\/oauth\/authorize\?\S+?)(?=https:\/\/|\s|$)/.exec(plain);
  return m ? (m[1] as string) : null;
}

export function findClaudeToken(raw: string): string | null {
  return /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/.exec(stripAnsi(raw))?.[0] ?? null;
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
 * Two kinds the hub stores have no shape here and can have none: `bedrock` and `jenkins` are any printable
 * string. Neither appears in these three commands' output, which is why quoting it is safe today; a fourth
 * caller, or a command that learns to print one, is not covered by anything here.
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

/**
 * A device-code sign-in that could not be run to an answer. `shown` is whether the hub was given the code
 * before it failed, so the owner may be looking at one: that decides both whether the hub is owed a `failed`
 * for it and whether the failure counts as the owner having been asked.
 */
export class DeviceLoginError extends Error {
  readonly shown: boolean;

  constructor(message: string, shown: boolean) {
    super(message);
    this.name = "DeviceLoginError";
    this.shown = shown;
  }
}

/**
 * Runs a device-code sign-in, relays its code to the owner through the hub as soon as it is printed, and
 * waits for the command to finish (the owner signing in is what finishes it). With `respond`, the command's
 * stdin is a pipe and `respond(output, stdin)` sees all output so far on every chunk, to answer its prompts.
 *
 * Rejects with a `DeviceLoginError` when there is no answer to give back.
 */
export function relayDeviceLogin({
  api,
  id,
  kind,
  cmd,
  args,
  env,
  parse,
  respond,
  expiresIn = DEVICE_CODE_EXPIRES_S,
  isExpiry,
  label
}: RelayDeviceLoginOptions): Promise<RelayDeviceLoginResult> {
  return new Promise((resolve, reject) => {
    let output = "";
    let relayed: Promise<void> | null = null;
    let failed: Error | null = null;
    let relayedAt = 0;
    // Whether the code reached the hub, which is where the owner reads it. Set between the two calls below
    // because only the first of them puts it on their screen, and a relay that fails after it still showed them
    // a code the hub has to be told about.
    let shown = false;
    const child = spawn(cmd, args, { env, stdio: [respond ? "pipe" : "ignore", "pipe", "pipe"] });
    child.stdin?.on("error", () => {});
    // Declared before `settle` closes over them rather than after, so that a synchronous caller added later is
    // an undefined timer to clear and not a temporal dead zone to throw out of the promise.
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | null = null;
    let abandon: NodeJS.Timeout | null = null;
    let settled = false;
    // Every end of this promise goes through here, so that the last resort below cannot settle it twice.
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
      }
      if (abandon) {
        clearTimeout(abandon);
      }
      // Settling is the one thing that has to happen. `fn` builds the answer, which reads the command's output
      // and calls `isExpiry` — the caller's function, not this one's — and a throw from it would otherwise leave
      // the promise pending for ever with `settled` already true: the hang the teardown above exists to prevent,
      // reached from the other end.
      try {
        fn();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    // `finish` is async, so both places that call it mark its promise discarded rather than leaving it floating:
    // an unhandled rejection inside a timer callback takes the process down, and this is the teardown whose
    // whole purpose is to stop the process hanging. Discarding it is safe because it cannot reject — the only
    // thing it awaits is `relayed`, a `then(ok, err)` chain that handles both of its own arms, and the `settle`
    // above turns a throw from building the answer into a rejection of this promise instead.
    // SIGTERM asks, SIGKILL insists, and the third step is to stop waiting. A child can ignore the first —
    // `trap '' TERM` survives `exec` — and surviving the second is impossible, so a `close` that still has not
    // come means a descendant it forked holds these pipes. Nothing above this has a timeout of its own, so
    // without the last step the pod sits in `awaiting_login` for as long as it runs.
    //
    // Which is also why the pipes are destroyed rather than only abandoned. The very condition that gets this
    // far — somebody else holding the write ends — is two ref'd Sockets pinning the event loop open, and
    // `cli.ts` sets `process.exitCode` without calling `process.exit`, so settling the promise would leave the
    // command running for ever and the boot script's loop no further on. Destroying them also takes `onData`
    // out of the orphan's way: it would otherwise go on appending its output, and relay a code off it long
    // after this call had answered.
    const endChild = () => {
      child.kill("SIGTERM");
      escalation ??= setTimeout(() => {
        child.kill("SIGKILL");
        abandon ??= setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          void finish(null);
        }, SIGKILL_AFTER_MS);
      }, SIGKILL_AFTER_MS);
    };
    timer = setTimeout(endChild, (expiresIn + 30) * 1000);
    const onData = (d: unknown) => {
      output += d;
      respond?.(output, child.stdin);
      if (relayed) {
        return;
      }
      const prompt = parse(output);
      if (!prompt) {
        return;
      }
      relayedAt = Date.now();
      relayed = withRetry(async () => {
        await api.loginPrompt(id, kind, { prompt: "device_code", ...prompt, expires_in: expiresIn });
        shown = true;
        await api.virtualStatus(id, "awaiting_login", `${label}: the owner must enter code ${prompt.user_code} at ${prompt.verification_uri}`);
      }).then(
        () => say(`${label}: sign-in code relayed to the owner through agent-hub`),
        (e) => {
          failed = e as Error;
          endChild();
        }
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // `null` is the command having been given up on rather than seen to exit, which `run` also reports as 1.
    const finish = async (code: number | null) => {
      await relayed;
      const relayError: Error | null = failed;
      settle(() => {
        // The command's own exit is read before the relay's, because a sign-in it completed is completed whatever
        // the relay did: the token is in its config by now. Rejecting here would throw that away and leave the
        // owner told they had not signed in, where `loginComplete` puts the hub's record right by itself.
        if (relayError && code !== 0) {
          reject(new DeviceLoginError(`could not relay the ${label} sign-in code: ${relayError.message}`, shown));
          return;
        }
        if (relayError) {
          say(`${label}: the sign-in completed although its code could not be relayed (${relayError.message})`);
        }
        if (!relayed) {
          // Quoting output is safe here: a command that printed no code never reached a signed-in state, so it
          // has no token to have printed, and `outputTail` redacts every credential shape regardless.
          reject(new DeviceLoginError(`${cmd} printed no sign-in code (exit ${code}): ${outputTail(output)}`, false));
          return;
        }
        const ranOut = Date.now() - relayedAt >= Math.max(0, expiresIn - EXPIRY_TOLERANCE_S) * 1000;
        resolve({ code: code ?? 1, output, expired: isExpiry?.(output) === true || ranOut });
      });
    };
    child.on("error", (e) => {
      settle(() => reject(new DeviceLoginError(`${cmd} could not start: ${e.message}`, shown)));
    });
    child.on("close", (code) => {
      void finish(code);
    });
  });
}

async function azOk(env: Env): Promise<boolean> {
  const r = await run("az", ["account", "get-access-token", "--scope", env.AGENT_HUB_SCOPE || DEFAULT_SCOPE, "-o", "none"], { env, timeoutMs: 60000 });
  return r.code === 0;
}

/** Restores the Azure sign-in the hub holds, or relays a device-code sign-in to the owner. */
export async function azureLogin({ api = createApi(), env = process.env }: LoginOptions = {}): Promise<AzureLoginResult> {
  const { id } = requireVirtualAgent(env);
  const stored = await withRetry(() => api.getCredential(id, "azure"));
  if (stored) {
    try {
      restoreAzureCache(stored, { env });
      if (await azOk(env)) {
        say("azure: restored the stored sign-in");
        await syncAzureCache({ api, id, env });
        return "restored";
      }
      say("azure: the stored sign-in no longer works; signing in again");
    } catch (e) {
      say(`azure: could not restore the stored sign-in (${(e as Error).message}); signing in again`);
    }
  }
  const tenant = env.AZURE_TENANT_ID;
  const args = ["login", "--use-device-code", "--allow-no-subscriptions", "-o", "none"];
  if (tenant) {
    args.splice(2, 0, "--tenant", tenant);
  }
  const { code } = await relayDeviceLogin({ api, id, kind: "azure", cmd: "az", args, env, parse: parseAzDeviceCode, label: "azure" });
  if (code !== 0) {
    throw new Error(`az login exited ${code}`);
  }
  const who = await run("az", ["ad", "signed-in-user", "show", "--query", "{id:id,upn:userPrincipalName}", "-o", "json"], { env });
  if (who.code !== 0) {
    throw new Error("az ad signed-in-user show failed after sign-in");
  }
  const { id: oid, upn } = JSON.parse(who.stdout) as { id: string; upn: string };
  try {
    await withRetry(() => api.loginComplete(id, "azure", { account_oid: oid, account_label: upn }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      fs.rmSync(azureDir(env), { recursive: true, force: true });
      await withRetry(() => api.virtualStatus(id, "failed", "azure: signed in as an account that is not the agent owner")).catch(() => {});
      throw new FatalError("azure: the hub refused the sign-in: the account is not the agent owner");
    }
    throw e;
  }
  await syncAzureCache({ api, id, env, force: true });
  say(`azure: signed in as ${upn}`);
  return "signed-in";
}

const GH_CLEAN = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

/**
 * How many codes one call offers the owner, whatever ended the one before. Each replaces the last on their
 * screen, so the bound is what keeps somebody from being handed a fresh code for as long as the pod runs; three
 * fifteen-minute codes is three quarters of an hour of asking, longer than anyone needs to walk to another
 * screen and shorter than a working day.
 *
 * It is not conditioned on why an attempt failed, because every reason deserves the next code: a code that ran
 * out unused means the owner was not there yet, and a poll GitHub answered with a fault, or a hub that could not
 * be told about the code, got no verdict out of them at all. Spending the budget on a fault that turns out to be
 * permanent costs three codes nobody uses; withholding it would turn one bad answer into a pod that stops
 * asking, which is the fault this bound exists to stop, only reached sooner.
 */
export const GITHUB_SIGN_IN_CODES = 3;

/**
 * How long to leave between codes. An attempt that failed on the poll is over in seconds, so without a wait the
 * budget is three codes in half a minute — the same fault three times, and none of the second chance at a fault
 * that may not last which is why the budget is not conditioned on the reason. A minute is what GitHub's
 * secondary rate limits are usually measured in, and it is nothing beside an attempt that ran its code out.
 */
export const GITHUB_SIGN_IN_GAP_MS = 60_000;

/**
 * The longest gap `setTimeout` can keep: past a signed 32-bit millisecond count it fires after 1ms instead, so a
 * number beyond this would remove the gap rather than lengthen it.
 */
const MAX_GAP_MS = 2 ** 31 - 1;

/**
 * The gap `AGENT_HUB_GITHUB_SIGN_IN_GAP_MS` asks for, or the default. A pod being watched through a sign-in is
 * the reason this is settable at all: three codes a minute apart is three minutes before anyone sees the end.
 *
 * Anything that is not a whole number of milliseconds in range gives the default rather than being argued with,
 * and that has to include the empty string: `Number("")` is 0, so a Helm value that rendered to nothing, or an
 * `env` entry with `value: ""`, would otherwise read as a deliberate request for no gap at all — the one setting
 * that brings back what the gap exists to stop, asked for by a variable nobody set.
 */
export function githubSignInGapMs(env: Env = process.env): number {
  // Digits and nothing else: `Number` would otherwise read `1e4` as ten thousand and `0x10` as sixteen, so a
  // typo in a hex-looking value would quietly become a sixteen-millisecond gap.
  const raw = (env.AGENT_HUB_GITHUB_SIGN_IN_GAP_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return GITHUB_SIGN_IN_GAP_MS;
  }
  const asked = Number(raw);
  return asked <= MAX_GAP_MS ? asked : GITHUB_SIGN_IN_GAP_MS;
}

export type GithubLoginOptions = LoginOptions & {
  /** How many codes are offered and the wait between them; only a test moves these. How long each one lasts is GitHub's to say. */
  codes?: number;
  gapMs?: number;
  /** How the wait between codes is taken, as `withRetry` takes its own: a test passes one that does not wait. */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
};

export type GithubLoginResult = "signed-in" | "not-signed-in";

/**
 * What the owner is told when none of their codes was completed. The three cases are the three things that can
 * have happened to the last one: it ran out while they were away, something stopped the pod finishing it, or
 * GitHub ended it. Each says what to do next, because this is the agent's `status_detail` and the only thing
 * they see — the pod's log carries what `gh` said, which is for whoever is reading logs.
 */
function githubNotSignedInDetail(expired: boolean, broke: boolean): string {
  if (expired) {
    return "github: the sign-in code ran out before it was used; start the agent again to be sent another";
  }
  return broke
    ? "github: the sign-in could not be finished; start the agent again to be sent another code"
    : "github: GitHub stopped the sign-in before it could be completed, so the code is no longer any use";
}

/**
 * What the owner is told when the sign-in worked and keeping what it granted did not. Which of the two stores
 * failed is the whole of what decides whether there is anything for them to do: a token gh is holding is one
 * the pod puts right by itself, and one GitHub will not take needs a current one from them.
 */
function githubStoreFailedDetail(hubFailed: boolean, ghFailed: boolean): string {
  if (!ghFailed) {
    return "github: signed in, but the token could not be saved to agent-hub yet; this agent is holding it and will keep trying";
  }
  return hubFailed
    ? "github: signed in, but the token could not be saved either on agent-hub or in this agent"
    : "github: GitHub would not accept the token the sign-in granted; it is saved on agent-hub, so this agent will keep trying it";
}

/**
 * Runs one of the two stores and answers the error it ended with, or `null`. Each is run this way rather than
 * allowed to throw, because neither failing may end the call before the other has been tried.
 */
const storeAttempt = async (store: () => Promise<unknown>, options: RetryOptions): Promise<Error | null> =>
  withRetry(store, options).then(
    () => null,
    (e: unknown) => e as Error
  );

/**
 * The token gh holds, or `""` for none. Tolerates a `gh auth token` that fails, because having no sign-in yet is
 * one of the ways it does: only safe where no sign-in has been run, which is the reuse check below.
 */
const storedGhToken = async (env: NodeJS.ProcessEnv): Promise<string> =>
  (await run("gh", ["auth", "token", "--hostname", "github.com"], { env })).stdout.trim();

/**
 * Puts a code on the owner's screen. Throws a `DeviceLoginError` whose `shown` says whether the hub ever had
 * it: a `loginPrompt` that landed and a `virtualStatus` that did not still leaves a live code in front of
 * them, and only a code they could have used is one the hub is owed a `failed` for.
 */
async function relayGithubCode({
  api,
  id,
  code,
  wait
}: {
  api: Pick<Api, "loginPrompt" | "virtualStatus">;
  id: string;
  code: DeviceCode;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  let shown = false;
  try {
    await withRetry(
      async () => {
        await api.loginPrompt(id, "github", {
          prompt: "device_code",
          verification_uri: code.verification_uri,
          user_code: code.user_code,
          expires_in: code.expires_in
        });
        shown = true;
        await api.virtualStatus(id, "awaiting_login", `github: the owner must enter code ${code.user_code} at ${code.verification_uri}`);
      },
      { wait }
    );
  } catch (e) {
    throw new DeviceLoginError(`could not relay the github sign-in code: ${(e as Error).message}`, shown);
  }
}

/** How many times gh is asked to store a token the owner has already granted. */
export const GH_STORE_ATTEMPTS = 3;

/**
 * Relays GitHub device codes to the owner and stores the token the sign-in grants, up to `codes` of them,
 * `gapMs` apart. Returns 'not-signed-in' once they are spent, having told the hub so, which is the one outcome
 * its caller must not retry: the owner has been asked as often as this will ask, and only they can act.
 *
 * A failure the owner was never asked about throws instead, so that a caller rides it out — a hub that could not
 * be reached before the code got there, or a GitHub that would not mint one. Reporting one of those as the other
 * is what leaves somebody told they did not sign in when nothing ever reached their screen.
 *
 * The flow itself is polled here rather than by `gh auth login --web`, because gh ends a sign-in on the first
 * poll answer that is neither `authorization_pending` nor a single `slow_down` — see `github-device-flow.ts`.
 * That is why the budget and the poll are different bounds and both are wanted: this one bounds how long a
 * single code is held open, and the budget bounds how many codes an owner is ever handed.
 *
 * gh still stores the token, through `--with-token`, which validates it against the API as it writes it: a
 * token GitHub will not accept fails here rather than at the clone, and the pod's git credentials come from
 * where they always did.
 */
export async function githubLogin({
  api = createApi(),
  env = process.env,
  codes = GITHUB_SIGN_IN_CODES,
  gapMs = githubSignInGapMs(env),
  wait = sleep,
  fetchImpl
}: GithubLoginOptions = {}): Promise<GithubLoginResult> {
  const { id } = requireVirtualAgent(env);
  const ghEnv = childEnv(env, GH_CLEAN);
  say(`github: signing in through ${oauthAppLabel(env)}`);
  // An earlier call in this pod may have been granted a token and failed only to finish storing it. gh's config
  // is a memory-backed emptyDir, so a token here is one this pod was granted, and relaying another code for it
  // would ask the owner to authorise what they have authorised already.
  let token = await storedGhToken(ghEnv);
  // Whether any code reached the owner's screen, which is what makes the outcome theirs to act on rather than a
  // fault to ride out, and what the hub is owed a `failed` for.
  let shown = false;
  let expired = false;
  // Whether what ended the last attempt was this pod's side of it rather than GitHub's answer about the code.
  let broke = false;
  // What the pod's log is told, which is not what the owner is told: this one names the fault.
  let said = "";
  let thrown: unknown;
  if (token) {
    say("github: gh is already signed in; storing the token it holds");
  } else {
    for (let attempt = 1; attempt <= codes; attempt++) {
      // What is left of the gap once this attempt is over, so the wait fills the time the attempt did not: an
      // attempt that ran its code out has already waited a quarter of an hour, and one that failed on the first
      // poll has waited seconds.
      const startedAt = Date.now();
      const gapLeft = () => Math.max(0, gapMs - (Date.now() - startedAt));
      try {
        const code = await withRetry(() => requestDeviceCode({ env, fetchImpl }), { retryable: deviceFlowRetryable, wait });
        await relayGithubCode({ api, id, code, wait });
        shown = true;
        // Only the last attempt's failure words what the hub is told, so an earlier one goes once this gets a
        // code in front of the owner: it is no longer what happened.
        thrown = undefined;
        say("github: sign-in code relayed to the owner through agent-hub");
        const polled = await pollDeviceToken({ code, env, fetchImpl, wait, onWait: (detail) => say(`github: ${detail}`) });
        if (polled.outcome === "token") {
          token = polled.token;
          break;
        }
        expired = polled.outcome === "expired";
        // A refusal with no OAuth word is no poll having reached GitHub at all, which is this pod's side of it.
        broke = polled.outcome === "refused" && polled.error === "";
        said = polled.outcome === "refused" ? polled.detail : "the code reached its expires_in unused";
      } catch (e) {
        // Caught per attempt rather than around the loop, because a code the owner never answered and a relay
        // that could not be completed are the same thing to the budget: one code gone, and the next one earned.
        thrown = e;
        expired = false;
        broke = true;
        said = (e as Error).message;
        // A relay that failed after the hub had the code still put one on the owner's screen.
        if (e instanceof DeviceLoginError && e.shown) {
          shown = true;
        }
      }
      if (attempt < codes) {
        say(`github: ${said}; relaying a fresh code in ${Math.round(gapLeft() / 1000)}s, which replaces it`);
        await wait(gapLeft());
      }
    }
  }

  if (token) {
    const granted = token;
    // Two stores, attempted independently rather than as one step, because only losing **both** loses a grant
    // the owner has already given. The hub holds the copy that outlives the pod — gh's config is a
    // memory-backed emptyDir — and gh's is what lets this pod clone and what validates the token as it is
    // written. Either one left holding it is a way on that costs the owner nothing further, so neither
    // failing may end the call before the other has been tried.
    //
    // The hub goes first: that is the fault this order exists for. gh's store reaches api.github.com to
    // validate, and a token lost to a blip there is one the owner has to authorise again.
    const hubFailed = await storeAttempt(() => api.putCredential(id, "github", granted), { wait });
    const ghFailed = await storeAttempt(
      async () => {
        const r = await run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
          env: ghEnv,
          input: `${granted}\n`
        });
        if (r.code !== 0) {
          // gh's own words, redacted: what GitHub answered is the difference between a scope the app no longer
          // grants and a token already revoked. Retried, because a fault reaching the API reads exactly like a
          // refusal from it and three tries cost seconds.
          throw new Error(`gh would not store the GitHub token the owner signed in for (exit ${r.code}): ${outputTail(r.stderr)}`);
        }
      },
      { attempts: GH_STORE_ATTEMPTS, wait }
    );
    if (!hubFailed && !ghFailed) {
      const login = (await run("gh", ["api", "user", "--jq", ".login"], { env: ghEnv })).stdout.trim();
      await withRetry(() => api.loginComplete(id, "github", login ? { account_label: login } : {}), { wait });
      say(`github: signed in${login ? ` as ${login}` : ""}`);
      return "signed-in";
    }
    // Whichever failed says so in full in the pod's log; the hub gets the wording the owner can act on.
    for (const failure of [hubFailed, ghFailed]) {
      if (failure) {
        say(`github: ${failure.message}`);
      }
    }
    const unstored = (hubFailed ?? ghFailed) as Error;
    if (!shown) {
      // Nobody was asked for this token — it came out of gh's own config — so there is nothing to conclude
      // about the owner and nothing for the hub to mark. The caller rides it out, and no code is spent.
      throw unstored;
    }
    const detail = githubStoreFailedDetail(hubFailed !== null, ghFailed !== null);
    // Reported before either way out, because the owner was shown a code and the hub is owed exactly one
    // outcome for it. Leaving the row pending holds a dead code on their screen until the sweep, and the next
    // call completes it from `failed` as readily as from `pending`.
    await reportGithubFailure({ api, id, state: "failed", detail, wait });
    say(detail);
    if (hubFailed && !ghFailed) {
      // gh is holding the grant, so this is the one failure the next call repairs for free: `storedGhToken`
      // finds the token, the loop is skipped, and the hub is tried again with no code spent. A throw is what
      // gets that next call — `not-signed-in` would stop the asking and leave the boot script watching for a
      // stored token that is the very thing that could not be stored.
      throw hubFailed;
    }
    // The hub has the token and gh would not take it, or neither has it. Both are the owner's to act on: the
    // first is what the boot script's watcher retries without a new code, the second needs one from them.
    return "not-signed-in";
  }

  if (shown) {
    const detail = githubNotSignedInDetail(expired, broke);
    await reportGithubFailure({ api, id, state: expired ? "expired" : "failed", detail, wait });
    say(`${detail} (${said})`);
    // The owner has had every code this offers, so asking again is not what is wanted even though an attempt
    // threw: a caller that retried would relay a fresh code on each pass, for as long as the pod ran.
    return "not-signed-in";
  }
  // Nobody was asked, so there is nothing to report and nothing about the owner to conclude. The message carries
  // whatever failed, and `runVirtual` logs it for the pod on the way out.
  throw thrown ?? new Error("github: the sign-in relayed no code and gave no reason");
}

/**
 * The hub is owed one of `complete` or `failed` for every sign-in shown to an owner, who is otherwise left
 * holding a code that no longer works and an agent that reads as waiting for them. Few attempts, and never
 * fatal: the caller is about to be told the sign-in failed either way.
 *
 * Every `detail` that reaches here is one of the fixed wordings above, which is what keeps it inside the hub's
 * 500 characters: the hub rejects a longer one rather than truncating it, and a `400` is not retryable, so a
 * fault's own message interpolated into one would be a report that never arrives. The message goes to `say`.
 */
async function reportGithubFailure({
  api,
  id,
  state,
  detail,
  wait
}: {
  api: Pick<Api, "loginFailed">;
  id: string;
  state: "expired" | "failed";
  detail: string;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  await withRetry(() => api.loginFailed(id, "github", { state, detail }), { attempts: 3, wait }).catch((e: unknown) => {
    say(`github: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`);
  });
}

const CLAUDE_CLEAN = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS"
];

async function waitForClaudeCredential(api: Pick<Api, "getCredential">, id: string, pollMs: number, deadline = Number.POSITIVE_INFINITY): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await withRetry(() => api.getCredential(id, "claude"))) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

/**
 * `claude setup-token` only draws its prompt on a terminal, so it runs under script(1) for a pty. The
 * authorize URL is relayed as a paste_code prompt and the owner's code typed back in. If no URL appears, the
 * owner is asked to store a token on the hub instead. The token is never printed.
 */
export async function claudeLogin({
  api = createApi(),
  env = process.env,
  pollMs = 3000,
  fallbackPollMs = 10000,
  urlTimeoutMs = 60000,
  tokenTimeoutMs = 60000
}: ClaudeLoginOptions = {}): Promise<ClaudeLoginResult> {
  const { id } = requireVirtualAgent(env);
  const hub = (env.AGENT_HUB_URL || "").replace(/\/+$/, "");
  if (await withRetry(() => api.getCredential(id, "claude"))) {
    return "stored";
  }

  const child = spawn("script", ["-q", "-e", "-c", "stty cols 1000 rows 50 2>/dev/null; exec claude setup-token", "/dev/null"], {
    env: { ...childEnv(env, CLAUDE_CLEAN), BROWSER: "true", TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  let exited = false;
  child.on("error", () => {
    exited = true;
  });
  child.on("close", () => {
    exited = true;
  });
  child.stdout?.on("data", (d) => {
    output += d;
  });
  child.stderr?.on("data", (d) => {
    output += d;
  });
  const stop = () => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  };

  try {
    let url: string | null = null;
    for (const until = Date.now() + urlTimeoutMs; !url && !exited && Date.now() < until; await sleep(200)) {
      url = parseClaudeAuthorizeUrl(output);
    }
    if (url) {
      const authorizeUrl = url;
      await withRetry(async () => {
        await api.loginPrompt(id, "claude", { prompt: "paste_code", verification_uri: authorizeUrl, expires_in: PASTE_CODE_EXPIRES_S });
        await api.virtualStatus(id, "awaiting_login", "claude: the owner must open the sign-in link and paste the code it shows");
      });
      say("claude: sign-in link relayed to the owner through agent-hub");
      const deadline = Date.now() + PASTE_CODE_EXPIRES_S * 1000;
      let code: string | null = null;
      while (!code && !exited && Date.now() < deadline) {
        code = await withRetry(() => api.loginCode(id, "claude"));
        if (code) {
          break;
        }
        if (await withRetry(() => api.getCredential(id, "claude"))) {
          return "stored";
        }
        await sleep(pollMs);
      }
      if (!code) {
        throw new Error("claude: no code was pasted before the sign-in expired");
      }
      child.stdin?.write(String(code).trim());
      let token: string | null = null;
      // The Enter after pasted text can be swallowed by the TUI, so it is sent again until a token shows.
      for (let until = Date.now() + tokenTimeoutMs, n = 0; !token && Date.now() < until; n++) {
        if (n % 25 === 0 && !exited) {
          child.stdin?.write("\r");
        }
        await sleep(200);
        token = findClaudeToken(output);
        if (exited && !token) {
          break;
        }
      }
      if (!token) {
        throw new Error("claude: setup-token printed no token after the code was entered");
      }
      const setupToken = token;
      stop();
      await withRetry(() => api.loginComplete(id, "claude", {}));
      await withRetry(() => api.putCredential(id, "claude", setupToken));
      say("claude: token stored on agent-hub");
      return "signed-in";
    }
  } finally {
    stop();
  }

  say("claude: could not drive claude setup-token; waiting for the owner to store a token on agent-hub");
  await withRetry(() =>
    api.virtualStatus(id, "awaiting_credentials", `claude: run "claude setup-token" and paste the token at ${hub}/hub/settings/credentials`)
  );
  await waitForClaudeCredential(api, id, fallbackPollMs);
  return "stored";
}
