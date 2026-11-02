// The bearer token a person's client sends: an Azure CLI access token for the hub's scope, cached until shortly
// before it expires.
import { execFile } from "node:child_process";

export const DEFAULT_SCOPE = "api://dtsse-agent-hub/.default";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type RunAz = (args: string[]) => Promise<string>;

function runAz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("az", args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const hint = (err as NodeJS.ErrnoException).code === "ENOENT" ? "az is not installed" : (stderr || err.message).trim();
        reject(new Error(`az ${args.slice(0, 2).join(" ")} failed: ${hint}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function requireAzureLogin(run: RunAz = runAz): Promise<void> {
  try {
    await run(["account", "show", "-o", "none"]);
  } catch (e) {
    throw new Error(`not logged in to Azure — run: az login\n(${(e as Error).message})`);
  }
}

export type AzToken = { token: string; expiresAt: number };

export function parseAzToken(stdout: string, now: number = Date.now()): AzToken {
  const parsed = JSON.parse(stdout) as { accessToken?: string; expires_on?: unknown; expiresOn?: string };
  if (!parsed.accessToken) {
    throw new Error("az returned no accessToken");
  }
  let expiresAt: number | undefined;
  if (Number.isFinite(Number(parsed.expires_on))) {
    expiresAt = Number(parsed.expires_on) * 1000;
  } else if (parsed.expiresOn) {
    expiresAt = Date.parse(parsed.expiresOn);
  }
  if (!Number.isFinite(expiresAt)) {
    expiresAt = now + 30 * 60 * 1000;
  }
  return { token: parsed.accessToken, expiresAt: expiresAt as number };
}

export type TokenProviderOptions = {
  scope?: string;
  run?: RunAz;
  now?: () => number;
};

export function createTokenProvider({ scope = DEFAULT_SCOPE, run = runAz, now = Date.now }: TokenProviderOptions = {}): () => Promise<string> {
  let cached: AzToken | null = null;
  let pending: Promise<string> | null = null;
  return async function getToken() {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
      return cached.token;
    }
    if (!pending) {
      pending = run(["account", "get-access-token", "--scope", scope, "-o", "json"])
        .then((out) => {
          cached = parseAzToken(out, now());
          return cached.token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}
