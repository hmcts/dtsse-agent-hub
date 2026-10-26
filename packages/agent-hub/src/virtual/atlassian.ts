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
import { createApi, isMissingRoute } from "../api.ts";
import type { Env } from "../env.ts";
import type { RetryOptions } from "../retry.ts";
import { withRetry } from "../retry.ts";
import { readText, sha256 } from "../session.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { say, virtualStateDir } from "./phases.ts";
import { childEnv, type Respond, type RunResult, relayDeviceLogin, run, SIGKILL_AFTER_MS, stripAnsi } from "./sign-in.ts";

export const ATLASSIAN_AUTH_MAX_CHARS = 24000;
/**
 * How long a pod's `twg login` holds its device code: the whole 300 seconds Atlassian's `expires_in` gives it.
 * twg 1.3.3 waits `min(expires_in, 120s in agent mode, 300s otherwise)`, so the figure is 300 only because
 * `twgLoginEnv` takes every agent-mode trigger out of the login's environment.
 *
 * twg prints the figure itself, as "(Ns remaining)", only outside agent mode, so the countdown appearing at all is
 * what says the drop worked: a spinner with no figure is agent mode and a two-minute code. A pod does not read it,
 * because `relayDeviceLogin` has already told the owner how long they have by then, so this constant is where the
 * figure lives.
 *
 * Overstating it is the one thing that must not happen: the wall-clock check in `relayDeviceLogin` would then never
 * call a genuine expiry an expiry, and a code nobody used would be reported as a sign-in that broke. That check is
 * why 300 is safe without having seen Atlassian's `expires_in` for twg's device-code client, which only a completed
 * sign-in would show: twg takes the lower of the two, so a shorter one would make the owner's clock run long and
 * `twgLoginExpired` would still read the expiry off twg's own error code.
 */
export const TWG_DEVICE_CODE_EXPIRES_S = 300;
/**
 * How many codes one call offers the owner: one, for the full five minutes. Five minutes is long enough to go and
 * find the Atlassian sign-in page on another screen and type a code, which is the thing a code has to survive, and
 * a code that ran out after five means the owner is not at their screen — a fresh one relayed to an empty chair runs
 * out too, while holding the agent in `awaiting_login` and a `agent-hub jira export` open on behalf of somebody who
 * has walked away. An owner who comes back late has their agent's page to sign in again from, and that is a fresh
 * code with a fresh five minutes; a code too short to use at all is what nobody can recover from.
 *
 * What bounds this is the session rather than taste. `agent-hub jira export` drives this sign-in, and the envelope
 * tells the session to run it under `JIRA_EXPORT_BASH_TIMEOUT_MS`; killed at that, the command reports nothing and
 * the owner is left with the dead code this whole path exists to prevent. The worst case through `atlassianLogin` is
 * `twg whoami`, two `twg auth refresh` calls and a `twg doctor` before the code, so the code has to fit in what is
 * left. `jiraExportSignInBudget` is where that sum is checked, and a second code at 300 seconds does not fit in it.
 *
 * `relayDeviceLogin`'s `expired` flag still earns its place with one code: it is what makes the hub report
 * `state: "expired"` rather than `"failed"`, so the owner's screen says the code ran out instead of that the
 * sign-in broke.
 */
export const ATLASSIAN_SIGN_IN_CODES = 1;
/**
 * twg 1.3.3's agent-mode gate is two parts, and this explicit one runs first: `TWG_AGENT_HOST`, the table of agent
 * hosts twg knows by name, the two generic markers, the metrics source and `TWG_AGENT_DEFAULTS` each put it in agent
 * mode on their own, short-circuiting before the environment-wide scan below is reached. Any one of them left in
 * place costs the code three of its five minutes, whatever else the environment holds.
 *
 * `__CFBundleIdentifier` is macOS's, and triggers only on Codex's bundle id.
 */
export const TWG_AGENT_VARS = [
  "TWG_AGENT_HOST",
  "TWG_AGENT_DEFAULTS",
  "TWG_METRICS_SOURCE",
  "AGENT",
  "AI_AGENT",
  "__CFBundleIdentifier",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "ROVO_AGENT",
  "ROVO_DEV",
  "ROVODEV",
  "REPLIT_AGENT",
  "REPL_ID",
  "AUGMENT_AGENT",
  "GOOSE_PROVIDER",
  "CLINE_ACTIVE",
  "OPENCODE",
  "OPENCODE_CLIENT",
  "TRAE_AI_SHELL_ID"
];
/**
 * How twg 1.3.3 reads every other name once none of the gates above has fired: `AGENT` as a word in the raw
 * uppercased name. A pod's `AGENT_HUB_*` and `VIRTUAL_AGENT_*` variables all match, which is why a pod sign-in was
 * agent mode whatever else it did.
 */
const TWG_AGENT_NAME = /(^|_)AGENT($|_)/;
/**
 * The names that scan matches and twg exempts anyway, so they are not triggers and the child keeps them: the ssh
 * and gpg agent sockets (`SSH_AGENT*`, `GPG_AGENT*`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), the user-agent strings,
 * and `AGENT_RUNTIME` and `AGENT_TRANSCRIPTS`. Keeping them is what stops this from taking a variable away from a
 * child that may want it, which is the only cost of over-dropping — the code's lifetime is not at stake either
 * way, because twg was never going to read them.
 *
 * twg narrows the scan once more and this does not: it also ignores a name that normalises to fewer than three
 * characters or to one of its own hosts. Not following that over-drops, which is the safe direction, and a pod's
 * environment carries no such name anyway.
 */
const TWG_AGENT_NAME_KEEP = new Set([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "HTTP_USER_AGENT",
  "NPM_CONFIG_USER_AGENT",
  "USER_AGENT",
  "AGENT_RUNTIME",
  "AGENT_TRANSCRIPTS"
]);
const TWG_AGENT_NAME_KEEP_PREFIXES = ["SSH_AGENT", "GPG_AGENT"];

/**
 * Everything in `env` that twg 1.3.3 would read as a marker that an agent is running it, and so has to go before
 * `twg login` is given a copy.
 *
 * This list is what buys the device code its full five minutes, and it is not an optimisation to be simplified away:
 * twg needs none of these variables, and in agent mode it holds the code for 120 seconds, which is not long enough
 * for somebody to find the Atlassian sign-in page on another screen and type the code into it. Both halves of the
 * gate have to be covered, because the explicit one above short-circuits the scan rather than the other way round.
 *
 * Measured against **twg 1.3.3**, which is what the pod image carries. The gate has to be measured again on any
 * later twg: a `twg login` printing "(300s remaining)" is outside agent mode and one drawing a spinner with no
 * figure is in it. That move does not pass through this repo — `VIRTUAL_AGENT_IMAGE` is digest-pinned in
 * cnp-flux-config, still points at the cft-workspace devcontainer image rather than `docker/virtual-agent/`, and
 * that devcontainer already pins twg 1.3.9 — so whoever bumps the digest owns the re-measure.
 *
 * A trigger a later twg adds and this misses holds the code for 120 seconds while the owner's screen counts down
 * from 300. `twgLoginExpired` reads twg's own error code, so the expiry is still reported as an expiry and the
 * owner is still told the code ran out: the only wrong thing is the clock.
 */
export function twgAgentModeVars(env: Env): string[] {
  return Object.keys(env).filter(
    (name) =>
      TWG_AGENT_VARS.includes(name) ||
      (TWG_AGENT_NAME.test(name.toUpperCase()) &&
        !TWG_AGENT_NAME_KEEP.has(name.toUpperCase()) &&
        !TWG_AGENT_NAME_KEEP_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix)))
  );
}

/**
 * The environment `twg login` runs with: the pod's, without the agent-mode triggers above, because twg needs none
 * of them and a code that lasts two minutes is one the owner cannot use. `BROWSER` is `true` so twg's offer to open
 * the device page is a no-op in a pod with no browser.
 */
export const twgLoginEnv = (env: Env): NodeJS.ProcessEnv => ({
  ...childEnv(env, twgAgentModeVars(env)),
  BROWSER: "true",
  TERM: "xterm-256color"
});
// What `twg auth refresh` 1.3.3 exits with when Atlassian rejects the refresh token. 1.3.9 exits 1 and says why
// in its JSON instead.
const TWG_EXIT_AUTH_INVALID = 77;
const TWG_REJECTED_CODES = new Set(["unauthorized_client", "invalid_grant"]);

// The twg calls `atlassianLogin` can make before the first code is relayed, at their timeouts below: one
// `twg whoami` from `jira-export.ts`, a `twg auth refresh --force` on the sign-in already on disk, another on the
// one restored from the hub, and the `twg doctor` that follows a refresh which succeeded.
const SIGN_IN_OVERHEAD_MS = 30000 + 60000 + 60000 + 90000;

/**
 * The longest `atlassianLogin` can take to report that nobody completed the sign-in. Every relayed code is asked
 * to stop `expiresIn + 30` seconds in (`relayDeviceLogin`), after the fixed twg calls above, and a command that
 * does not go then is killed `SIGKILL_AFTER_MS` later and let go of `SIGKILL_AFTER_MS` after that — so two of
 * them is the worst a code can add beyond its own time.
 *
 * This has to stay inside the Bash timeout the envelope gives `agent-hub jira export`: a command killed before it
 * reports leaves the owner the dead code and the agent in `awaiting_login`, which is the whole fault this guards.
 * At the current figures it comes to 580000 of that 600000, so there is 20000 spare and a second code is not
 * close to fitting — one at 300 seconds would take it to 920000. Anything added between codes, a gap of the kind
 * `githubLogin` has included, has that 20000 to fit into, and raising the count means raising the timeout with it.
 */
export function jiraExportSignInBudget(codes = ATLASSIAN_SIGN_IN_CODES, expiresIn = TWG_DEVICE_CODE_EXPIRES_S): number {
  return SIGN_IN_OVERHEAD_MS + codes * ((expiresIn + 30) * 1000 + 2 * SIGKILL_AFTER_MS);
}

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
  /** How the store's retries wait between attempts; only a test moves it, to avoid waiting out the real backoff. */
  wait?: RetryOptions["wait"];
};

export type SyncAtlassianAuthResult = "not-signed-in" | "no-login" | "unchanged" | "stored";

export type AtlassianLoginResult = "restored" | "signed-in" | "not-signed-in";

export type AtlassianLoginOptions = {
  api?: Api;
  env?: Env;
  /** How long each relayed code is offered for, and how many are offered; both only a test moves. */
  expiresIn?: number;
  codes?: number;
  /** How this call's retries of the hub wait between attempts; only a test moves it. */
  wait?: RetryOptions["wait"];
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

/**
 * Whether `twg login` gave up waiting rather than failing some other way. twg 1.3.3 carries one of two error codes
 * for it, `login_timeout` when its own timer runs out and `expired_token` when Atlassian retires the code first,
 * and prints the code in brackets after the message. The sentences are matched as well, in case a later twg prints
 * one without the other; the wall clock behind this is the backstop for a twg that prints neither.
 */
export const twgLoginExpired = (raw: string): boolean =>
  /\[(?:login_timeout|expired_token)\]|Login timed out after|device code has expired/i.test(stripAnsi(raw));

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
  refresh = false,
  wait
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
  // The whole module's retry budget, not a shorter one: the token just read off disk has already replaced the one
  // the hub holds, and Atlassian will take nothing else, so a store that gives up early leaves a spent token
  // behind for the next pod to be refused.
  //
  // What that budget is depends on how the hub is failing. Refusing fast — a connection reset, or the 503 an
  // ingress gives while a replica rolls — it is the 31 seconds of backoff alone, which is the case this is for.
  // Hanging instead, every attempt also waits out `REQUEST_TIMEOUT_MS`, and an aborted fetch carries no numeric
  // status so `retryableByStatus` keeps going: six attempts, up to ~121 seconds.
  //
  // One figure for two deadlines, and they disagree. A cache-sync pass between the periodic runs has no ceiling
  // and wants every one of those 121 seconds; the pass on SIGTERM has whatever is left of the pod's 60 and will
  // be SIGKILLed mid-attempt. Nothing here reads the clock, so the longer deadline is the one served — a shorter
  // budget would not save a store that needs longer than the grace period anyway, and would give up on a hub
  // that was about to answer. What the SIGTERM pass can do instead is spend its time on this store rather than
  // another, which is `cache-sync.ts`'s business and is where that reasoning lives.
  await withRetry(() => api.putCredential(id, "atlassian", value), { wait });
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
async function refreshAtlassian({
  api,
  id,
  env,
  wait
}: {
  api: Pick<Api, "putCredential">;
  id: string;
  env: Env;
  wait?: RetryOptions["wait"];
}): Promise<boolean> {
  const r = await run("twg", ["auth", "refresh", "--force", "-o", "json"], { env, timeoutMs: 60000 });
  if (twgRefreshRejected(r)) {
    return false;
  }
  if (r.code !== 0) {
    throw new Error(`twg auth refresh exited ${r.code}`);
  }
  await syncAtlassianAuth({ api, id, env, force: true, wait });
  if (!(await twgOk(env))) {
    throw new Error("twg doctor cannot reach Atlassian after a refresh");
  }
  return true;
}

/**
 * Jira and Confluence through twg are optional, so nothing here is fatal. Restores the sign-in stored on the
 * hub, or relays a `twg login` device code to the owner, `ATLASSIAN_SIGN_IN_CODES` of them in all, each lasting
 * `TWG_DEVICE_CODE_EXPIRES_S` because `twgLoginEnv` keeps twg out of agent mode. Returns 'not-signed-in' when the
 * owner completed none of them, having told the hub so: the owner's screen then says the sign-in expired instead
 * of showing a code that no longer works.
 */
export async function atlassianLogin({
  api = createApi(),
  env = process.env,
  expiresIn = TWG_DEVICE_CODE_EXPIRES_S,
  codes = ATLASSIAN_SIGN_IN_CODES,
  wait
}: AtlassianLoginOptions = {}): Promise<AtlassianLoginResult> {
  const { id } = requireVirtualAgent(env);
  fs.rmSync(atlassianShaFile(), { force: true });
  // A sign-in already here is from an earlier attempt in this pod, and at least as new as the stored one:
  // that attempt may have spent the stored refresh token.
  let local: string | null = null;
  try {
    const text = readAtlassianAuth(env);
    local = text && packAtlassianAuth(text).value;
  } catch {}
  if (local && (await refreshAtlassian({ api, id, env, wait }))) {
    say("atlassian: kept the current sign-in");
    return "restored";
  }
  const stored = await withRetry(() => api.getCredential(id, "atlassian"), { wait });
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
      if (await refreshAtlassian({ api, id, env, wait })) {
        say("atlassian: restored the stored sign-in");
        return "restored";
      }
      say("atlassian: the stored sign-in no longer works; signing in again");
    }
  }
  let last: { code: number; expired: boolean } | null = null;
  let thrown: unknown;
  // `relayDeviceLogin` throws when the relay itself fails or twg prints no code at all. Caught here rather than let
  // out, because the hub has been promised one of `complete` or `failed` for every sign-in shown to the owner, and
  // an attempt that throws has usually already shown them one.
  try {
    for (let attempt = 1; attempt <= codes; attempt++) {
      // Each attempt starts from no sign-in on disk, so the file read after it can only be this attempt's, and a
      // 1.3.9 pod never reads an auth.conf left beside the auth-profiles.json it has just written.
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
      last = await relayDeviceLogin({
        api,
        id,
        kind: "atlassian",
        cmd: "script",
        args: ["-q", "-e", "-c", "stty cols 1000 rows 50 2>/dev/null; exec twg login --site hmcts", "/dev/null"],
        env: twgLoginEnv(env),
        parse: parseTwgDeviceCode,
        respond,
        expiresIn,
        isExpiry: twgLoginExpired,
        label: "atlassian"
      });
      const text = readAtlassianAuth(env);
      if (last.code === 0 && text) {
        const { user } = packAtlassianAuth(text);
        await withRetry(() => api.loginComplete(id, "atlassian", user ? { account_label: user } : {}), { wait });
        await syncAtlassianAuth({ api, id, env, force: true, wait });
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
  } catch (e) {
    thrown = e;
  }

  const expired = thrown === undefined && last?.expired === true;
  const detail = expired
    ? "atlassian: the sign-in code ran out before it was used; Jira and Confluence stay signed out"
    : thrown !== undefined
      ? `atlassian: the sign-in could not be relayed (${(thrown as Error).message}); Jira and Confluence stay signed out`
      : `atlassian: the sign-in was not completed (twg login exited ${last?.code}); Jira and Confluence stay signed out`;
  say(detail);
  // The owner is otherwise left holding a code that no longer works, with nothing but this pod's stderr saying so.
  // Few attempts: nothing here is fatal, and a hub that cannot be told is not worth half a minute of the pod.
  await withRetry(() => api.loginFailed(id, "atlassian", { state: expired ? "expired" : "failed", detail }), { attempts: 3, wait }).catch((e: unknown) => {
    // A hub with no route for this report is older than this client, which the deploy behind it puts right on its
    // own, so it is said plainly and once. Everything else — a refusal, a fault, a hub that cannot be reached at
    // all — is a report that will not arrive, and is said as the failure it is.
    say(
      isMissingRoute(e)
        ? "atlassian: agent-hub is older than this client and has no route for a sign-in that was not completed"
        : `atlassian: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`
    );
  });
  if (thrown !== undefined) {
    throw thrown;
  }
  return "not-signed-in";
}
