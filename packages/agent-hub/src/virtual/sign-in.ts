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
import { withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { azureDir, restoreAzureCache, syncAzureCache } from "./azure-cache.ts";
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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
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

// `gh auth login --web` without a TTY (2.97) writes to stderr:
// "! First copy your one-time code: 7B7F-C198" then "Open this URL to continue in your web browser: https://github.com/login/device"
export function parseGhDeviceCode(text: string): DeviceCodePrompt | null {
  const code = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text);
  const url = /(https:\/\/github\.com\/login\/device)\b/.exec(text);
  return code && url ? { verification_uri: url[1] as string, user_code: code[1] as string } : null;
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
 * Every credential shape, so that redacting cannot be narrower than storing. `relayDeviceLogin` quotes output
 * for all three of its callers — `gh`, `az` and `twg` — so a list that knew only GitHub's shapes would be a
 * safety net for one of them.
 *
 * The first three are the hub's own `GITHUB_TOKEN` check in `src/credentials/validate.ts` — a prefixed token and
 * a fine-grained PAT — widened by `r` for the refresh tokens `gh` also writes, plus the 40-hex classic token. A
 * git SHA matches that one and goes with it, which costs nothing: no SHA is why a sign-in failed. Then its
 * `CLAUDE_TOKEN` shape, the `oauth-*-token` lines of the `atlassian` credential, and a JWT, which is what an
 * access token looks like whoever issued it.
 *
 * Add a shape to both the validator and here, or to neither: a value the hub would store and this would print is
 * the one thing that must not happen.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b[0-9a-f]{40}\b/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // A lookbehind rather than a group, so every shape here replaces whole and the key is left to read.
  /(?<=oauth-(?:access|refresh)-token=)\S+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*/g
];

/**
 * Replaces every credential-shaped run, so a command's own words can be logged. A device code is left alone: it
 * is relayed to the owner and logged beside the relay anyway, and it is what says whether an error is about the
 * code the owner is holding.
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
  const line = redactTokens(stripAnsi(text)).replace(/\s+/g, " ").trim();
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
    const timer = setTimeout(() => child.kill("SIGTERM"), (expiresIn + 30) * 1000);
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
          child.kill("SIGTERM");
        }
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new DeviceLoginError(`${cmd} could not start: ${e.message}`, shown));
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await relayed;
      const relayError: Error | null = failed;
      if (relayError) {
        reject(new DeviceLoginError(`could not relay the ${label} sign-in code: ${relayError.message}`, shown));
        return;
      }
      if (!relayed) {
        // Quoting output is safe here: a command that printed no code never reached a signed-in state, so it has
        // no token to have printed, and `outputTail` redacts every credential shape regardless.
        reject(new DeviceLoginError(`${cmd} printed no sign-in code (exit ${code}): ${outputTail(output)}`, false));
        return;
      }
      const ranOut = Date.now() - relayedAt >= Math.max(0, expiresIn - EXPIRY_TOLERANCE_S) * 1000;
      resolve({ code: code ?? 1, output, expired: isExpiry?.(output) === true || ranOut });
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
 * It is not conditioned on why an attempt failed, because the two reasons both deserve the next code: a code
 * that ran out unused means the owner was not there yet, and a poll GitHub answered with a fault means the
 * attempt never got a verdict out of them at all. Spending the budget on a fault that turns out to be permanent
 * costs three codes nobody uses; withholding it would turn one bad answer from GitHub into a pod that stops
 * asking, which is the fault this bound exists to stop, only reached sooner.
 */
export const GITHUB_SIGN_IN_CODES = 3;

/**
 * Whether gh's output says it gave up waiting for the code rather than the sign-in breaking. `ErrTimeout` is
 * what it prints when the code reaches its `expires_in` unused; `expired_token` is GitHub retiring the code
 * first. Read before the clock, which can only under-count: `relayedAt` is when the code was parsed off gh's
 * stderr, which is after gh started its own timer, so a busy node makes a genuine expiry look like a break.
 */
export const ghLoginExpired = (raw: string): boolean => /authentication timed out|\bexpired_token\b|device code has expired/i.test(stripAnsi(raw));

export type GithubLoginOptions = LoginOptions & {
  /** How long each relayed code is offered for, and how many are offered; both only a test moves. */
  expiresIn?: number;
  codes?: number;
};

export type GithubLoginResult = "signed-in" | "not-signed-in";

/**
 * The token gh holds, or `""` for none. Tolerates a `gh auth token` that fails, because having no sign-in yet is
 * one of the ways it does: only safe where no sign-in has been run, which is the reuse check below.
 */
const storedGhToken = async (env: NodeJS.ProcessEnv): Promise<string> =>
  (await run("gh", ["auth", "token", "--hostname", "github.com"], { env })).stdout.trim();

/**
 * The token a `gh auth login` that exited 0 was granted. It exited 0, so there is one, and failing to read it is
 * a fault of this pod's rather than a sign-in the owner did not finish — `run` answers 127 for a gh it could not
 * spawn and 1 for one it killed at the timeout, neither of which is an answer about the owner.
 */
async function grantedGhToken(env: NodeJS.ProcessEnv): Promise<string> {
  const r = await run("gh", ["auth", "token", "--hostname", "github.com"], { env });
  const token = r.stdout.trim();
  if (!token) {
    throw new Error(`gh auth login exited 0 but gh auth token gave no token (exit ${r.code}): ${outputTail(r.stderr)}`);
  }
  return token;
}

/**
 * Relays `gh auth login` device codes to the owner and stores the token the sign-in grants, up to `codes` of
 * them. Returns 'not-signed-in' once they are spent, having told the hub so, which is the one outcome its caller
 * must not retry: the owner has been asked as often as this will ask, and only they can act now.
 *
 * A failure the owner was never asked about throws instead, so that a caller rides it out — a hub that cannot be
 * reached, a `gh` that will not run or will not give up the token it was granted. Reporting one of those as the
 * other is what leaves somebody told they did not sign in when nothing ever reached their screen.
 *
 * What ended an attempt does not decide which of the two it is; whether a code reached the owner does. A poll
 * GitHub answers with a fault spends a code, because a code was on their screen for it, and the next code is a
 * real second chance at a fault that may not last. `expired` only words what the hub is told.
 */
export async function githubLogin({
  api = createApi(),
  env = process.env,
  expiresIn = DEVICE_CODE_EXPIRES_S,
  codes = GITHUB_SIGN_IN_CODES
}: GithubLoginOptions = {}): Promise<GithubLoginResult> {
  const { id } = requireVirtualAgent(env);
  // gh opens the device page with $GH_BROWSER/$BROWSER; `true` makes that a no-op in a pod with no browser.
  const ghEnv = { ...childEnv(env, GH_CLEAN), GH_BROWSER: "true", BROWSER: "true", GH_PROMPT_DISABLED: "1" };
  // user:email lets git-identity check that the owner's HMCTS email is on their GitHub account.
  const args = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--scopes", "user:email", "--web"];
  // An earlier call in this pod may have signed gh in and failed only to store what it got. gh's config is a
  // memory-backed emptyDir, so a token here is one this pod was granted, and relaying another code for it would
  // ask the owner to authorise what they have authorised already.
  let token = await storedGhToken(ghEnv);
  let last: RelayDeviceLoginResult | null = null;
  let thrown: unknown;
  // Whether any code reached the owner's screen, which is what makes the outcome theirs to act on rather than a
  // fault to ride out, and what the hub is owed a `failed` for.
  let shown = false;
  // Whether a `gh auth login` exited 0 this call, so there is a token to read.
  let granted = false;
  if (token) {
    say("github: gh is already signed in; storing the token it holds");
  } else {
    try {
      for (let attempt = 1; attempt <= codes; attempt++) {
        last = await relayDeviceLogin({
          api,
          id,
          kind: "github",
          cmd: "gh",
          args,
          env: ghEnv,
          parse: parseGhDeviceCode,
          expiresIn,
          isExpiry: ghLoginExpired,
          label: "github"
        });
        shown = true;
        if (last.code === 0) {
          granted = true;
          break;
        }
        // The log is where every attempt but the last says what gh said; the last one says it on the way out.
        if (attempt < codes) {
          const why = last.expired ? "the sign-in code ran out before it was used" : "GitHub ended the sign-in";
          say(`github: ${why} (gh said: ${outputTail(last.output)}); relaying a fresh code, which replaces it`);
        }
      }
    } catch (e) {
      thrown = e;
      // A relay that failed after the hub had the code still put one on the owner's screen.
      if (e instanceof DeviceLoginError && e.shown) {
        shown = true;
      }
    }
  }

  // Both of these are outside the try, because by here the owner has done everything that was asked of them: a
  // gh that signed in and will not give up its token, and a hub that will not take it, are this pod's faults and
  // throw to be ridden out rather than being reported as a sign-in somebody did not finish.
  if (granted) {
    token = await grantedGhToken(ghEnv);
  }
  if (token) {
    const login = (await run("gh", ["api", "user", "--jq", ".login"], { env: ghEnv })).stdout.trim();
    await withRetry(() => api.loginComplete(id, "github", login ? { account_label: login } : {}));
    await withRetry(() => api.putCredential(id, "github", token));
    say(`github: signed in${login ? ` as ${login}` : ""}`);
    return "signed-in";
  }

  // Reported before anything is rethrown, because the hub is owed one of `complete` or `failed` for every code
  // it showed the owner. Without it a pending row keeps a live code on their screen and the agent reads as
  // waiting for them until the sweep expires the row, which does not put the status right.
  if (shown) {
    const expired = thrown === undefined && last?.expired === true;
    const detail = expired
      ? "github: the sign-in code ran out before it was used; start the agent again to be sent another"
      : thrown !== undefined
        ? "github: the sign-in could not be finished; start the agent again to be sent another code"
        : "github: GitHub stopped the sign-in before it could be completed, so the code is no longer any use";
    // Few attempts: the detail is worth telling the hub, and a hub that cannot be told is not worth half a minute.
    await withRetry(() => api.loginFailed(id, "github", { state: expired ? "expired" : "failed", detail }), { attempts: 3 }).catch((e: unknown) => {
      say(`github: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`);
    });
    // gh's own words, redacted, are the only thing that says why it stopped polling: a sign-in that fails in a
    // pod is diagnosed from this line and nothing else.
    const said = thrown === undefined ? `gh auth login exited ${last?.code}; gh said: ${outputTail(last?.output ?? "")}` : (thrown as Error).message;
    say(`${detail} (${said})`);
    // The owner has had every code this offers, so asking again is not what is wanted even though an attempt
    // threw: a caller that retried would relay a fresh code on each pass, for as long as the pod ran.
    return "not-signed-in";
  }
  // Nobody was asked, so there is nothing to report and nothing about the owner to conclude. The message carries
  // whatever the command said, and `runVirtual` logs it for the pod on the way out.
  throw thrown ?? new Error("github: the sign-in relayed no code and gave no reason");
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
