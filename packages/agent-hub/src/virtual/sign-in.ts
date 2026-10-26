// Sign-ins a pod cannot do for itself. There is no browser and nobody at the keyboard, so every device-code
// flow is started here, its code read off the command's own output and relayed to the agent's owner through
// the hub, and the command left running until the owner completes it. No output of these commands is ever
// printed: the token is in it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Writable } from "node:stream";
import type { Api } from "../api.ts";
import { ApiError, createApi, DEFAULT_SCOPE } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { azureDir, restoreAzureCache, syncAzureCache } from "./azure-cache.ts";
import { deviceFlowRetryable, oauthAppLabel, pollDeviceToken, requestDeviceCode } from "./github-device-flow.ts";
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

/**
 * Runs a device-code sign-in, relays its code to the owner through the hub as soon as it is printed, and
 * waits for the command to finish (the owner signing in is what finishes it). With `respond`, the command's
 * stdin is a pipe and `respond(output, stdin)` sees all output so far on every chunk, to answer its prompts.
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
      reject(new Error(`${cmd} could not start: ${e.message}`));
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      await relayed;
      const relayError: Error | null = failed;
      if (relayError) {
        reject(new Error(`could not relay the ${label} sign-in code: ${relayError.message}`));
        return;
      }
      if (!relayed) {
        reject(new Error(`${cmd} printed no sign-in code (exit ${code})`));
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
 * How much of a command's own complaint is worth repeating, as one line. Bounded and **not** redacted: the one
 * caller hands gh its token on stdin, so the stream this quotes carries gh's words about a token and never the
 * token, which is what makes quoting it at all acceptable. Nothing else may be put through it.
 */
export function ghSaid(stderr: string): string {
  const text = stderr.replace(/\s+/g, " ").trim();
  return text === "" ? "it said nothing" : text.slice(0, 200);
}

/**
 * A detail the hub will take: it bounds `detail` at 500 characters and **rejects** anything longer rather than
 * truncating it, and a `400` is not retryable, so an over-long detail is a report that never arrives.
 */
export const MAX_LOGIN_DETAIL_CHARS = 500;

export function loginDetail(detail: string): string {
  return detail.slice(0, MAX_LOGIN_DETAIL_CHARS);
}

/** How many times gh is asked to store a token the owner has already granted. */
export const GH_STORE_ATTEMPTS = 3;

export type GithubLoginOptions = LoginOptions & {
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Relays a GitHub device code to the owner and polls for the token itself, then hands the token to gh.
 *
 * The flow is not run through `gh auth login --web`, because gh ends a sign-in on the first poll answer that
 * is not `authorization_pending` or a single `slow_down` — see `github-device-flow.ts`. gh still stores the
 * token: `--with-token` validates it as it writes it, so a token GitHub will not accept is caught here rather
 * than at the clone, and the pod's git credentials come from the same place they always did.
 */
export async function githubLogin({ api = createApi(), env = process.env, fetchImpl, wait }: GithubLoginOptions = {}): Promise<"signed-in"> {
  const { id } = requireVirtualAgent(env);
  const ghEnv = childEnv(env, GH_CLEAN);
  say(`github: signing in through ${oauthAppLabel(env)}`);
  const code = await withRetry(() => requestDeviceCode({ env, fetchImpl }), { retryable: deviceFlowRetryable, wait });
  await withRetry(
    async () => {
      await api.loginPrompt(id, "github", {
        prompt: "device_code",
        verification_uri: code.verification_uri,
        user_code: code.user_code,
        expires_in: code.expires_in
      });
      await api.virtualStatus(id, "awaiting_login", `github: the owner must enter code ${code.user_code} at ${code.verification_uri}`);
    },
    { wait }
  );
  say("github: sign-in code relayed to the owner through agent-hub");
  const polled = await pollDeviceToken({ code, env, fetchImpl, wait, onWait: (detail) => say(`github: ${detail}`) });
  if (polled.outcome !== "token") {
    const expired = polled.outcome === "expired";
    const detail = expired ? "github: the sign-in code ran out before it was used" : `github: the sign-in was refused (${polled.detail})`;
    say(detail);
    await reportGithubFailure({ api, id, state: expired ? "expired" : "failed", detail, wait });
    throw new Error(detail);
  }
  const token = polled.token;
  // Stored before gh is handed it, because the owner's grant is the scarce thing in this function: a token they
  // have already authorised must not be lost to a fault while gh validates it, and a stored token that GitHub
  // has since revoked costs one line of the next start's log, which reports it and relays a fresh code.
  await withRetry(() => api.putCredential(id, "github", token), { wait });
  const refusal = await withRetry(
    async () => {
      const r = await run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
        env: ghEnv,
        input: `${token}\n`
      });
      if (r.code !== 0) {
        // gh's own words: it validates the token against the API as it writes it, and what GitHub answered is
        // the difference between a scope the app no longer grants and a token already revoked. Retried because
        // a fault reaching the API reads exactly the same as a refusal from it, and three tries cost seconds.
        throw new Error(`gh would not store the GitHub token the owner signed in for (exit ${r.code}): ${ghSaid(r.stderr)}`);
      }
    },
    { attempts: GH_STORE_ATTEMPTS, wait }
  ).then(
    () => null,
    (e: unknown) => e as Error
  );
  if (refusal) {
    const detail = `github: ${refusal.message}; the token is stored, so the next start will try it`;
    say(detail);
    await reportGithubFailure({ api, id, state: "failed", detail, wait });
    throw refusal;
  }
  const login = (await run("gh", ["api", "user", "--jq", ".login"], { env: ghEnv })).stdout.trim();
  await withRetry(() => api.loginComplete(id, "github", login ? { account_label: login } : {}), { wait });
  say(`github: signed in${login ? ` as ${login}` : ""}`);
  return "signed-in";
}

/**
 * The hub is owed one of `complete` or `failed` for every sign-in shown to an owner, who is otherwise left
 * holding a code that no longer works and an agent that reads as waiting for them. Few attempts, and never
 * fatal: the caller is about to be told the sign-in failed either way.
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
  await withRetry(() => api.loginFailed(id, "github", { state, detail: loginDetail(detail) }), { attempts: 3, wait }).catch((e: unknown) => {
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
