// The pod's Claude sign-in: `claude setup-token` driven under a pty, its authorize link relayed to the owner and the
// code they paste typed back in.
import { spawn } from "node:child_process";
import { type Api, createApi } from "../api.ts";
import { withRetry } from "../retry.ts";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
    api.virtualStatus(id, "awaiting_credentials", `claude: run "claude setup-token" and paste the token at ${hub}/assistant?settings=credentials`)
  );
  await waitForClaudeCredential(api, id, fallbackPollMs);
  return "stored";
}
