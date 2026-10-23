// Jira and Confluence through the `twg` CLI. twg keeps its OAuth sign-in in auth-profiles.json (1.3.9 on) or
// auth.conf (1.3.3, which 1.3.9 still reads but never converts); the hub holds whichever the pod has, without its
// access tokens, which last an hour and are most of it. Every refresh rotates the refresh token, so the rotated
// one is stored before anything else can fail — a spent token left on the hub signs the pod out.
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
import { childEnv, type Respond, type RunResult, relayDeviceLogin, run, stripAnsi } from "./sign-in.ts";

export const ATLASSIAN_AUTH_MAX_CHARS = 24000;
// `twg login` gives up on its device code after 300 seconds, or 120 when it sees one of these, which is why it
// runs without them.
export const TWG_DEVICE_CODE_EXPIRES_S = 300;
const TWG_AGENT_MARKERS = ["CLAUDECODE", "AI_AGENT"];
// What `twg auth refresh` 1.3.3 exits with when Atlassian rejects the refresh token. 1.3.9 exits 1 and says why
// in its JSON instead.
const TWG_EXIT_AUTH_INVALID = 77;
const TWG_REJECTED_CODES = new Set(["unauthorized_client", "invalid_grant"]);

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
};

export function twgDir(env: Env = process.env): string {
  return env.TWG_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".config", "twg");
}

const twgAuthFile = (env: Env): string => path.join(twgDir(env), "auth.conf");
const twgProfilesFile = (env: Env): string => path.join(twgDir(env), "auth-profiles.json");
// Every file a twg sign-in can leave behind: auth_oauth.conf is a copy 1.3.3 writes and never reads.
const TWG_AUTH_FILES = ["auth-profiles.json", "auth.conf", "auth_oauth.conf"];
// A stored auth-profiles.json is JSON, and an auth.conf never starts with a brace.
const isProfiles = (text: string): boolean => text.trimStart().startsWith("{");
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

/** auth-profiles.json when twg has one, which is where 1.3.9 signs in, otherwise auth.conf. */
export function readAtlassianAuth(env: Env = process.env): string | null {
  for (const file of [twgProfilesFile(env), twgAuthFile(env)]) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {}
  }
  return null;
}

type TwgCredential = { user?: unknown; oauthAccessToken?: unknown; oauthRefreshToken?: unknown };
type TwgProfile = { id?: unknown; user?: unknown; credentials?: Record<string, TwgCredential | null> | null };
type TwgProfiles = { activeEnvironment?: unknown; defaults?: Record<string, unknown> | null; profiles?: unknown };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Blanks every access token rather than deleting it, because twg 1.3.9 refuses an auth-profiles.json missing a
 * field its schema requires. The account is the default profile's for the active environment, else the first
 * that can refresh.
 */
function packProfiles(text: string): { value: string; user: string | null } {
  let parsed: TwgProfiles;
  try {
    parsed = JSON.parse(text) as TwgProfiles;
  } catch {
    throw new Error("twg auth-profiles.json is not JSON");
  }
  const profiles = Array.isArray(parsed?.profiles) ? (parsed.profiles as TwgProfile[]) : [];
  const credentials = (p: TwgProfile) => Object.values(p?.credentials ?? {}).filter((c): c is TwgCredential => typeof c === "object" && c !== null);
  for (const c of profiles.flatMap(credentials)) {
    if ("oauthAccessToken" in c) {
      c.oauthAccessToken = "";
    }
  }
  const signedIn = profiles.filter((p) => credentials(p).some((c) => nonEmpty(c.oauthRefreshToken)));
  if (signedIn.length === 0) {
    throw new Error("twg auth-profiles.json holds no oauthRefreshToken");
  }
  const active = typeof parsed.activeEnvironment === "string" ? parsed.defaults?.[parsed.activeEnvironment] : undefined;
  const profile = signedIn.find((p) => p.id === active) ?? signedIn[0];
  const user = [profile?.user, ...credentials(profile as TwgProfile).map((c) => c.user)].find(nonEmpty)?.trim() || null;
  return { value: JSON.stringify(parsed), user };
}

function packAuthConf(text: string): { value: string; user: string | null } {
  const value = String(text)
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("oauth-access-token="))
    .join("\n")
    .trim();
  if (!/^oauth-refresh-token=\S/m.test(value)) {
    throw new Error("twg auth.conf holds no oauth-refresh-token");
  }
  return { value, user: /^user=(.+)$/m.exec(value)?.[1]?.trim() || null };
}

/**
 * twg's sign-in as agent-hub keeps it: auth-profiles.json or auth.conf without its access tokens. Every refresh
 * rotates the refresh token, so the value changes each time.
 */
export function packAtlassianAuth(text: string, { max = ATLASSIAN_AUTH_MAX_CHARS }: { max?: number } = {}): PackedAtlassianAuth {
  const profiles = isProfiles(String(text));
  const { value, user } = profiles ? packProfiles(String(text)) : packAuthConf(text);
  if (value.length > max) {
    const name = profiles ? "auth-profiles.json" : "auth.conf";
    throw new Error(`twg ${name} without its access tokens is ${value.length} characters, over the hub's ${max}`);
  }
  return { value, sha: sha256(value), user };
}

/**
 * Writes the sign-in back as the file it came from, and removes the other, so twg never reads an older sign-in
 * beside it. twg ignores auth_oauth.conf, and refetches cloud-ids/ itself.
 */
export function restoreAtlassianAuth(value: string, { env = process.env }: { env?: Env } = {}): void {
  const { value: packed } = packAtlassianAuth(value);
  const dir = twgDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const [file, other] = isProfiles(packed) ? [twgProfilesFile(env), twgAuthFile(env)] : [twgAuthFile(env), twgProfilesFile(env)];
  fs.rmSync(other, { force: true });
  fs.writeFileSync(file, `${packed}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
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
 * Whether `twg auth refresh -o json` says there is no sign-in it can refresh: Atlassian refused the refresh token,
 * or (1.3.9, exit 0) twg found no OAuth sign-in to refresh at all.
 */
export function twgRefreshRejected({ code, stdout }: Pick<RunResult, "code" | "stdout">): boolean {
  if (code === TWG_EXIT_AUTH_INVALID) {
    return true;
  }
  let data: { status?: unknown; profiles?: unknown } | undefined;
  try {
    data = (JSON.parse(stdout) as { data?: typeof data }).data;
  } catch {
    return false;
  }
  if (data?.status === "not_applicable") {
    return true;
  }
  const profiles = Array.isArray(data?.profiles) ? (data.profiles as { errorCode?: unknown }[]) : [];
  return code !== 0 && profiles.some((p) => typeof p?.errorCode === "string" && TWG_REJECTED_CODES.has(p.errorCode));
}

/**
 * Refreshes the sign-in now, which also gives the restored one an access token, and stores the rotated refresh
 * token before anything else can fail. False when Atlassian rejects it.
 */
async function refreshAtlassian({ api, id, env }: { api: Pick<Api, "putCredential">; id: string; env: Env }): Promise<boolean> {
  const r = await run("twg", ["auth", "refresh", "--force", "-o", "json"], { env, timeoutMs: 60000 });
  if (twgRefreshRejected(r)) {
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
 * hub, or relays a `twg login` device code to the owner. Returns 'not-signed-in' when the owner did not
 * complete it.
 */
export async function atlassianLogin({ api = createApi(), env = process.env }: AtlassianLoginOptions = {}): Promise<AtlassianLoginResult> {
  const { id } = requireVirtualAgent(env);
  fs.rmSync(atlassianShaFile(), { force: true });
  // A sign-in already here is from an earlier attempt in this pod, and at least as new as the stored one:
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
  for (const f of TWG_AUTH_FILES) {
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
  const { code } = await relayDeviceLogin({
    api,
    id,
    kind: "atlassian",
    cmd: "script",
    args: ["-q", "-e", "-c", "stty cols 1000 rows 50 2>/dev/null; exec twg login --site hmcts", "/dev/null"],
    env: { ...childEnv(env, TWG_AGENT_MARKERS), BROWSER: "true", TERM: "xterm-256color" },
    parse: parseTwgDeviceCode,
    respond,
    expiresIn: TWG_DEVICE_CODE_EXPIRES_S,
    label: "atlassian"
  });
  const text = readAtlassianAuth(env);
  if (code !== 0 || !text) {
    say(`atlassian: the sign-in was not completed (twg login exited ${code}); Jira and Confluence stay signed out`);
    return "not-signed-in";
  }
  const { user } = packAtlassianAuth(text);
  await withRetry(() => api.loginComplete(id, "atlassian", user ? { account_label: user } : {}));
  await syncAtlassianAuth({ api, id, env, force: true });
  say(`atlassian: signed in${user ? ` as ${user}` : ""}`);
  return "signed-in";
}
