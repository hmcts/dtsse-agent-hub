// Jira and Confluence through the `twg` CLI. twg keeps its OAuth sign-in in auth.conf; the hub holds that file
// without its access token, which lasts an hour and is most of it. Every refresh rotates the refresh token, so
// the rotated one is stored before anything else can fail — a spent token left on the hub signs the pod out.
//
// Nothing here is fatal: a pod with no Atlassian sign-in still works.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api } from "../api.ts";
import { createApi } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import { readText, sha256 } from "../session.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { say, virtualStateDir } from "./phases.ts";
import { type Respond, relayDeviceLogin, run, stripAnsi } from "./sign-in.ts";

export const ATLASSIAN_AUTH_MAX_CHARS = 24000;
// `twg login` (1.3.3) gives up on its device code after 300 seconds.
export const TWG_DEVICE_CODE_EXPIRES_S = 300;
/**
 * How many codes one call offers the owner. Five minutes is long enough to type a code already in front of you and
 * short enough to miss if you have to go and find the Atlassian sign-in page on another screen, so the first code
 * running out is not read as the owner declining. Two is where it stops: ten minutes of codes fits inside the
 * fifteen a Jira export waits, and a pod re-offering for ever would hold an agent in `awaiting_login` on behalf of
 * somebody who has walked away. Only a code that ran out unused earns another; a sign-in that broke is reported.
 */
export const ATLASSIAN_SIGN_IN_CODES = 2;
// What `twg auth refresh` (1.3.3) exits with when Atlassian rejects the refresh token.
const TWG_EXIT_AUTH_INVALID = 77;

export type PackedAtlassianAuth = {
  value: string;
  sha: string;
  user: string | null;
};

export type SyncAtlassianAuthOptions = {
  api: Pick<Api, "putCredential">;
  id: string;
  env?: Env;
  force?: boolean;
  refresh?: boolean;
};

export type SyncAtlassianAuthResult = "not-signed-in" | "no-login" | "unchanged" | "stored";

export type AtlassianLoginResult = "restored" | "signed-in" | "not-signed-in";

export type AtlassianLoginOptions = {
  api?: Api;
  env?: Env;
  /** How long each relayed code is offered for, and how many are offered; both only a test moves. */
  expiresIn?: number;
  codes?: number;
};

export function twgDir(env: Env = process.env): string {
  return env.TWG_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".config", "twg");
}

const twgAuthFile = (env: Env): string => path.join(twgDir(env), "auth.conf");
// Written only once a sign-in is stored on the hub, so cache-sync never runs `twg auth refresh` while
// atlassian-login is still restoring or signing in.
const atlassianShaFile = (): string => path.join(virtualStateDir(), "atlassian-auth.sha");

// `twg login --site hmcts` (1.3.3) on a pty, between colour codes and box-drawing characters:
// "Visit: https://auth.atlassian.com/oauth/activate?user_code=4BFC-CC3A" then "Code:  4BFC-CC3A".
export function parseTwgDeviceCode(raw: string): { verification_uri: string; user_code: string } | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: what is left after the escapes is the cursor moves twg draws its box with
  const text = stripAnsi(raw).replace(/[\r\x00-\x08\x0b-\x1f\x7f]/g, "");
  const url = /(https:\/\/[A-Za-z0-9.-]+\/oauth\/activate)\b/.exec(text);
  const code = /(?:user_code=|Code:\s*)([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9-])/.exec(text);
  return url && code ? { verification_uri: `${url[1]}?user_code=${code[1]}`, user_code: code[1] as string } : null;
}

export const twgPromptsForBrowser = (raw: string): boolean => /Open in browser\?/.test(stripAnsi(raw));

export function readAtlassianAuth(env: Env = process.env): string | null {
  try {
    return fs.readFileSync(twgAuthFile(env), "utf8");
  } catch {
    return null;
  }
}

/**
 * twg's auth.conf as agent-hub keeps it: without the access token, which lasts an hour and is most of the
 * file. Every refresh rotates the refresh token, so the value changes each time.
 */
export function packAtlassianAuth(text: string, { max = ATLASSIAN_AUTH_MAX_CHARS }: { max?: number } = {}): PackedAtlassianAuth {
  const value = String(text)
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("oauth-access-token="))
    .join("\n")
    .trim();
  if (!/^oauth-refresh-token=\S/m.test(value)) {
    throw new Error("twg auth.conf holds no oauth-refresh-token");
  }
  if (value.length > max) {
    throw new Error(`twg auth.conf without its access token is ${value.length} characters, over the hub's ${max}`);
  }
  const user = /^user=(.+)$/m.exec(value)?.[1]?.trim() || null;
  return { value, sha: sha256(value), user };
}

/** auth.conf is all twg reads: it ignores auth_oauth.conf, and refetches cloud-ids/ itself. */
export function restoreAtlassianAuth(value: string, { env = process.env }: { env?: Env } = {}): void {
  const { value: packed } = packAtlassianAuth(value);
  const dir = twgDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(twgAuthFile(env), `${packed}\n`, { mode: 0o600 });
  fs.chmodSync(twgAuthFile(env), 0o600);
}

/** PUTs auth.conf (refreshed first, if due, with `refresh`) when it differs from the last one stored. */
export async function syncAtlassianAuth({
  api,
  id,
  env = process.env,
  force = false,
  refresh = false
}: SyncAtlassianAuthOptions): Promise<SyncAtlassianAuthResult> {
  if (!force && !readText(atlassianShaFile())) {
    return "not-signed-in";
  }
  const current = readAtlassianAuth(env);
  if (!current) {
    return "no-login";
  }
  if (refresh) {
    const r = await run("twg", ["auth", "refresh"], { env, timeoutMs: 60000 });
    if (r.code !== 0) {
      say(`atlassian: twg auth refresh exited ${r.code}; the Atlassian sign-in may need renewing`);
    }
  }
  // A refresh that failed may have left no readable auth.conf at all, which is the same "no sign-in to store"
  // the unrefreshed read above reports rather than a packing error about a file that is not there.
  const refreshed = readAtlassianAuth(env);
  if (!refreshed) {
    return "no-login";
  }
  const { value, sha } = packAtlassianAuth(refreshed);
  if (!force && readText(atlassianShaFile()) === sha) {
    return "unchanged";
  }
  await withRetry(() => api.putCredential(id, "atlassian", value), { attempts: 3 });
  fs.writeFileSync(atlassianShaFile(), `${sha}\n`);
  return "stored";
}

async function twgOk(env: Env): Promise<boolean> {
  const r = await run("twg", ["doctor", "-o", "json"], { env, timeoutMs: 90000 });
  try {
    return (JSON.parse(r.stdout) as { data?: { connectivity?: { ok?: unknown } } }).data?.connectivity?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Refreshes the sign-in in auth.conf now, which also gives the restored one an access token, and stores the
 * rotated refresh token before anything else can fail. False when Atlassian rejects it.
 */
async function refreshAtlassian({ api, id, env }: { api: Pick<Api, "putCredential">; id: string; env: Env }): Promise<boolean> {
  const r = await run("twg", ["auth", "refresh", "--force"], { env, timeoutMs: 60000 });
  if (r.code === TWG_EXIT_AUTH_INVALID) {
    return false;
  }
  if (r.code !== 0) {
    throw new Error(`twg auth refresh exited ${r.code}`);
  }
  await syncAtlassianAuth({ api, id, env, force: true });
  if (!(await twgOk(env))) {
    throw new Error("twg doctor cannot reach Atlassian after a refresh");
  }
  return true;
}

/**
 * Jira and Confluence through twg are optional, so nothing here is fatal. Restores the sign-in stored on the
 * hub, or relays `twg login` device codes to the owner, up to `ATLASSIAN_SIGN_IN_CODES` of them. Returns
 * 'not-signed-in' when the owner did not complete any of them, having told the hub so: the owner's screen then
 * says the sign-in expired instead of showing a code that no longer works.
 */
export async function atlassianLogin({
  api = createApi(),
  env = process.env,
  expiresIn = TWG_DEVICE_CODE_EXPIRES_S,
  codes = ATLASSIAN_SIGN_IN_CODES
}: AtlassianLoginOptions = {}): Promise<AtlassianLoginResult> {
  const { id } = requireVirtualAgent(env);
  fs.rmSync(atlassianShaFile(), { force: true });
  // An auth.conf already here is from an earlier attempt in this pod, and at least as new as the stored one:
  // that attempt may have spent the stored refresh token.
  let local: string | null = null;
  try {
    const text = readAtlassianAuth(env);
    local = text && packAtlassianAuth(text).value;
  } catch {}
  if (local && (await refreshAtlassian({ api, id, env }))) {
    say("atlassian: kept the current sign-in");
    return "restored";
  }
  const stored = await withRetry(() => api.getCredential(id, "atlassian"));
  if (stored && stored === local) {
    say("atlassian: the stored sign-in no longer works; signing in again");
  }
  if (stored && stored !== local) {
    let restored = false;
    try {
      restoreAtlassianAuth(stored, { env });
      restored = true;
    } catch (e) {
      say(`atlassian: could not restore the stored sign-in (${(e as Error).message}); signing in again`);
    }
    if (restored) {
      if (await refreshAtlassian({ api, id, env })) {
        say("atlassian: restored the stored sign-in");
        return "restored";
      }
      say("atlassian: the stored sign-in no longer works; signing in again");
    }
  }
  let last: { code: number; expired: boolean } | null = null;
  for (let attempt = 1; attempt <= codes; attempt++) {
    // Each attempt starts from no sign-in on disk, so the auth.conf read after it can only be this attempt's.
    for (const f of ["auth.conf", "auth_oauth.conf"]) {
      fs.rmSync(path.join(twgDir(env), f), { force: true });
    }
    let answered = false;
    // twg asks whether to open a browser; "n" makes it wait for the device code to be entered elsewhere.
    const respond: Respond = (output, stdin) => {
      if (answered || !twgPromptsForBrowser(output)) {
        return;
      }
      answered = true;
      stdin?.write("n\r");
    };
    last = await relayDeviceLogin({
      api,
      id,
      kind: "atlassian",
      cmd: "script",
      args: ["-q", "-e", "-c", "stty cols 1000 rows 50 2>/dev/null; exec twg login --site hmcts", "/dev/null"],
      env: { ...env, BROWSER: "true", TERM: "xterm-256color" },
      parse: parseTwgDeviceCode,
      respond,
      expiresIn,
      label: "atlassian"
    });
    const text = readAtlassianAuth(env);
    if (last.code === 0 && text) {
      const { user } = packAtlassianAuth(text);
      await withRetry(() => api.loginComplete(id, "atlassian", user ? { account_label: user } : {}));
      await syncAtlassianAuth({ api, id, env, force: true });
      say(`atlassian: signed in${user ? ` as ${user}` : ""}`);
      return "signed-in";
    }
    if (!last.expired) {
      break;
    }
    if (attempt < codes) {
      say("atlassian: the sign-in code ran out before it was used; relaying a fresh one, which replaces it");
    }
  }

  const expired = last?.expired === true;
  const detail = expired
    ? "atlassian: the sign-in code ran out before it was used; Jira and Confluence stay signed out"
    : `atlassian: the sign-in was not completed (twg login exited ${last?.code}); Jira and Confluence stay signed out`;
  say(detail);
  // The owner is otherwise left holding a code that no longer works, with nothing but this pod's stderr saying so.
  // Few attempts: nothing here is fatal, and a hub that cannot be told is not worth half a minute of the pod.
  await withRetry(() => api.loginFailed(id, "atlassian", { state: expired ? "expired" : "failed", detail }), { attempts: 3 }).catch((e: unknown) => {
    say(`atlassian: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`);
  });
  return "not-signed-in";
}
