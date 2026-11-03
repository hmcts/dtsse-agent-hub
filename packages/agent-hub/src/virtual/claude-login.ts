// The pod's Claude sign-in: `claude setup-token` driven under a pty, its authorize link relayed to the owner and the
// code they paste typed back in.
import { spawn } from "node:child_process";
import { type Api, createApi, trimTrailingSlashes } from "../api.ts";
import type { Env } from "../env.ts";
import { sleep, withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import type { LoginOptions } from "./device-relay.ts";
import { say } from "./phases.ts";
import { childEnv, stripAnsi } from "./process.ts";

export const PASTE_CODE_EXPIRES_S = 600;

export type ClaudeLoginOptions = LoginOptions & {
  pollMs?: number;
  fallbackPollMs?: number;
  urlTimeoutMs?: number;
  tokenTimeoutMs?: number;
};

export type ClaudeLoginResult = "stored" | "signed-in";

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

/** `claude setup-token` running under script(1), and everything it has printed so far. */
type SetupToken = {
  output: () => string;
  exited: () => boolean;
  write: (text: string) => void;
  stop: () => void;
};

function startSetupToken(env: Env): SetupToken {
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
  return {
    output: () => output,
    exited: () => exited,
    write: (text) => {
      child.stdin?.write(text);
    },
    stop: () => {
      if (!exited) {
        child.kill("SIGKILL");
      }
    }
  };
}

async function waitForAuthorizeUrl(setup: SetupToken, timeoutMs: number): Promise<string | null> {
  let url: string | null = null;
  for (const until = Date.now() + timeoutMs; !url && !setup.exited() && Date.now() < until; await sleep(200)) {
    url = parseClaudeAuthorizeUrl(setup.output());
  }
  return url;
}

/**
 * The code the owner pasted, or `stored` when they stored a token on the hub instead. Throws when neither came
 * before the sign-in expired.
 */
async function waitForPastedCode(api: Pick<Api, "loginCode" | "getCredential">, id: string, setup: SetupToken, pollMs: number): Promise<string | "stored"> {
  const deadline = Date.now() + PASTE_CODE_EXPIRES_S * 1000;
  while (!setup.exited() && Date.now() < deadline) {
    const code = await withRetry(() => api.loginCode(id, "claude"));
    if (code) {
      return code;
    }
    if (await withRetry(() => api.getCredential(id, "claude"))) {
      return "stored";
    }
    await sleep(pollMs);
  }
  throw new Error("claude: no code was pasted before the sign-in expired");
}

async function waitForToken(setup: SetupToken, timeoutMs: number): Promise<string> {
  let token: string | null = null;
  // The Enter after pasted text can be swallowed by the TUI, so it is sent again until a token shows.
  const until = Date.now() + timeoutMs;
  for (let n = 0; !token && Date.now() < until; n++) {
    if (n % 25 === 0 && !setup.exited()) {
      setup.write("\r");
    }
    await sleep(200);
    token = findClaudeToken(setup.output());
    if (setup.exited() && !token) {
      break;
    }
  }
  if (!token) {
    throw new Error("claude: setup-token printed no token after the code was entered");
  }
  return token;
}

/** Relays the authorize link, types the owner's code back in and stores the token it prints. */
async function relayClaudeSignIn(api: Api, id: string, setup: SetupToken, url: string, pollMs: number, tokenTimeoutMs: number): Promise<ClaudeLoginResult> {
  await withRetry(async () => {
    await api.loginPrompt(id, "claude", { prompt: "paste_code", verification_uri: url, expires_in: PASTE_CODE_EXPIRES_S });
    await api.virtualStatus(id, "awaiting_login", "claude: the owner must open the sign-in link and paste the code it shows");
  });
  say("claude: sign-in link relayed to the owner through agent-hub");
  const code = await waitForPastedCode(api, id, setup, pollMs);
  if (code === "stored") {
    return "stored";
  }
  setup.write(String(code).trim());
  const token = await waitForToken(setup, tokenTimeoutMs);
  setup.stop();
  await withRetry(() => api.loginComplete(id, "claude", {}));
  await withRetry(() => api.putCredential(id, "claude", token));
  say("claude: token stored on agent-hub");
  return "signed-in";
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
  const hub = trimTrailingSlashes(env.AGENT_HUB_URL || "");
  if (await withRetry(() => api.getCredential(id, "claude"))) {
    return "stored";
  }

  const setup = startSetupToken(env);
  try {
    const url = await waitForAuthorizeUrl(setup, urlTimeoutMs);
    if (url) {
      return await relayClaudeSignIn(api, id, setup, url, pollMs, tokenTimeoutMs);
    }
  } finally {
    setup.stop();
  }

  say("claude: could not drive claude setup-token; waiting for the owner to store a token on agent-hub");
  await withRetry(() =>
    api.virtualStatus(id, "awaiting_credentials", `claude: run "claude setup-token" and paste the token at ${hub}/assistant?settings=credentials`)
  );
  await waitForClaudeCredential(api, id, fallbackPollMs);
  return "stored";
}
