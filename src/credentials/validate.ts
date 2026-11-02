import { gunzipSync } from "node:zlib";
import { checkClaudeMd } from "./claude-md.ts";
import { checkGitIdentity } from "./git-identity.ts";
import type { CredentialKind } from "./names.ts";

/** A Key Vault secret value is at most 25 KB; this leaves room for the encoding overhead. */
export const MAX_CREDENTIAL_LENGTH = 24_000;

/** How far an Azure token cache may expand when gunzipped, so a crafted value cannot exhaust the pod's memory. */
const MAX_AZURE_CACHE_BYTES = 1024 * 1024;

const GITHUB_TOKEN = /^(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/** `claude setup-token` prints an `sk-ant-oat…` OAuth token; an API key is `sk-ant-api…`, and both fit this. */
const CLAUDE_TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** A Jenkins API token from `/me/configure`: opaque, so only its length and printable, space-free ASCII are checked. */
const JENKINS_TOKEN = /^[\x21-\x7e]{20,200}$/;

/** Other tokens pasted by mistake for a Jenkins API token. */
const NOT_JENKINS: readonly (readonly [RegExp, string])[] = [
  [/^(gh[a-z]_|github_pat_)/, "that is a GitHub token, not a Jenkins API token"],
  [/^sk-ant-/, "that is a Claude token, not a Jenkins API token"],
  [/^(AKIA|ASIA)[A-Z0-9]{16}$/, "that is an AWS access key id, not a Jenkins API token"]
];

/** Tokens pasted or sent by mistake for a `twg` sign-in. */
const NOT_ATLASSIAN: readonly (readonly [RegExp, string])[] = [
  [/^(gh[a-z]_|github_pat_)/, "that is a GitHub token, not an Atlassian twg sign-in"],
  [/^sk-ant-/, "that is a Claude token, not an Atlassian twg sign-in"]
];

/** One setting of `twg`'s `auth.conf`. Its keys are lowercase words joined by hyphens, such as `oauth-refresh-token`. */
const AUTH_CONF_LINE = /^([a-z0-9-]+)=(.*)$/;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type CheckedCredential = { ok: true; value: string; accountLabel: string | null } | { ok: false; error: string };

const LABELS: Record<CredentialKind, string> = {
  github: "a GitHub token",
  azure: "an Azure token cache",
  claude: "a Claude token",
  jenkins: "a Jenkins API token",
  claude_md: "your CLAUDE.md",
  git_identity: "a git identity",
  atlassian: "an Atlassian twg sign-in"
};

/** The username of the first account an MSAL token cache holds, as the `az` login it came from shows it. */
function accountUsername(accounts: unknown): string | null {
  if (typeof accounts !== "object" || accounts === null) {
    return null;
  }
  for (const account of Object.values(accounts)) {
    const username = (account as { username?: unknown } | null)?.username;
    if (typeof username === "string" && username !== "") {
      return username;
    }
  }
  return null;
}

/**
 * An Azure CLI token cache as the pod sends it, decoded: the MSAL cache JSON, gzipped and base64-encoded. `undefined`
 * when it does not decode, gunzip and parse to a JSON object.
 */
export function decodeAzureCache(value: string): Record<string, unknown> | undefined {
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(Buffer.from(value, "base64"), { maxOutputLength: MAX_AZURE_CACHE_BYTES }).toString("utf8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

/** It has to decode to an object with an `Account` section, or it is not something `az` can use. */
function checkAzureCache(value: string): CheckedCredential {
  const parsed = decodeAzureCache(value);
  if (parsed === undefined) {
    return { ok: false, error: "that is not an Azure token cache: expected base64 of a gzipped MSAL cache with an Account section" };
  }
  if (!("Account" in parsed)) {
    return { ok: false, error: "that Azure token cache has no Account section" };
  }
  return { ok: true, value, accountLabel: accountUsername(parsed.Account) };
}

export type AzureOwnership = { ok: true } | { ok: false; reason: "malformed" | "unconfigured" | "not-owner" | "other-tenant"; error: string };

const NOT_OWNER = { ok: false, reason: "not-owner", error: "that Azure token cache is signed in as someone other than you, or in another tenant" } as const;

/** `<oid>.<tid>`, lowercased, as MSAL writes `home_account_id`; `undefined` for anything else. */
function homeAccount(value: unknown): { id: string; oid: string; tid: string } | undefined {
  const id = typeof value === "string" ? value.toLowerCase() : "";
  const [oid, tid, ...rest] = id.split(".");
  return oid && tid && rest.length === 0 ? { id, oid, tid } : undefined;
}

/**
 * Whether an Azure token cache holds only the owner's own sign-in, so that a virtual agent cannot act in Azure as
 * anyone else. It needs at least one account, and every account's `home_account_id` must be `<oid>.<tid>`. One whose
 * tid is this hub's tenant is a member's, and its oid must be the owner's, whatever its `realm`: `az login` without
 * `--tenant` writes one account per tenant the person can reach, all with the same `home_account_id`. One whose tid
 * is another tenant is a B2B guest's, named in their home tenant, so it must instead have the owner's oid as its
 * `local_account_id` and this hub's tenant as its `realm`. MSAL keys refresh tokens by `home_account_id` alone, so
 * every entry in the `RefreshToken` section must carry the `home_account_id` of one of those accounts. Comparisons
 * are case-insensitive. A guest's account in another realm is `other-tenant`, unless something else in the cache is
 * not the owner's.
 */
export function checkAzureCacheOwner(raw: unknown, ownerOid: string, tenantId: string | undefined): AzureOwnership {
  const parsed = decodeAzureCache(typeof raw === "string" ? raw.trim() : "");
  if (parsed === undefined || typeof parsed.Account !== "object" || parsed.Account === null) {
    return { ok: false, reason: "malformed", error: "that is not an Azure token cache with an Account section" };
  }
  const tenant = tenantId?.trim().toLowerCase();
  if (!tenant) {
    return { ok: false, reason: "unconfigured", error: "ENTRA_TENANT_ID is not set, so an Azure token cache's account cannot be checked" };
  }
  const accounts = Object.values(parsed.Account);
  if (accounts.length === 0) {
    return { ok: false, reason: "not-owner", error: "that Azure token cache holds no account" };
  }
  const owner = ownerOid.toLowerCase();
  const owned = new Set<string>();
  let otherRealm = false;
  for (const account of accounts) {
    const { home_account_id, local_account_id, realm } = (account ?? {}) as { home_account_id?: unknown; local_account_id?: unknown; realm?: unknown };
    const home = homeAccount(home_account_id);
    if (home === undefined) {
      return NOT_OWNER;
    }
    if (home.tid === tenant) {
      if (home.oid !== owner) {
        return NOT_OWNER;
      }
    } else if (typeof local_account_id !== "string" || local_account_id.toLowerCase() !== owner) {
      return NOT_OWNER;
    } else if (typeof realm !== "string" || realm.toLowerCase() !== tenant) {
      otherRealm = true;
    }
    owned.add(home.id);
  }
  const section = parsed.RefreshToken;
  const refreshTokens = section === undefined ? [] : typeof section === "object" && section !== null ? Object.values(section) : [section];
  for (const refreshToken of refreshTokens) {
    const home = (refreshToken as { home_account_id?: unknown } | null)?.home_account_id;
    if (typeof home !== "string" || !owned.has(home.toLowerCase())) {
      return NOT_OWNER;
    }
  }
  if (otherRealm) {
    return {
      ok: false,
      reason: "other-tenant",
      error: `that Azure token cache is signed in to another tenant, not this hub's: sign in to the hub's tenant, with az login --tenant ${tenant}`
    };
  }
  return { ok: true };
}

/**
 * Whether `raw` is a credential of `kind`, trimmed, except a CLAUDE.md, which is text kept as written, and a git
 * identity, which is stored as JSON of the fields set. The value never appears in a refusal, which is shown to the
 * person and may be logged.
 */
export function checkCredential(kind: CredentialKind, raw: unknown): CheckedCredential {
  if (kind === "claude_md") {
    const checked = checkClaudeMd(raw);
    return checked.ok ? { ok: true, value: checked.value, accountLabel: null } : checked;
  }
  if (kind === "git_identity") {
    const checked = checkGitIdentity(raw);
    return checked.ok ? { ok: true, value: checked.value, accountLabel: null } : checked;
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") {
    return { ok: false, error: `paste ${LABELS[kind]}` };
  }
  if (value.length > MAX_CREDENTIAL_LENGTH) {
    return { ok: false, error: `${LABELS[kind]} is at most ${MAX_CREDENTIAL_LENGTH} characters` };
  }
  switch (kind) {
    case "github":
      return GITHUB_TOKEN.test(value)
        ? { ok: true, value, accountLabel: null }
        : { ok: false, error: "that is not a GitHub token: expected one starting ghp_, gho_, ghs_, ghu_ or github_pat_" };
    case "claude":
      return CLAUDE_TOKEN.test(value)
        ? { ok: true, value, accountLabel: null }
        : { ok: false, error: "that is not a Claude token: expected the sk-ant-… token `claude setup-token` prints" };
    case "jenkins":
      return checkJenkinsToken(value);
    case "azure":
      return checkAzureCache(value);
    case "atlassian":
      return checkAtlassianAuth(value);
  }
}

/**
 * `twg`'s sign-in as the pod sends it, without its short-lived access tokens: `auth-profiles.json` (twg 1.3.9 on)
 * or `auth.conf` (1.3.3). Either must hold the refresh token `twg` signs in again with. Any site and any account
 * are accepted, because which Atlassian account an agent uses is its owner's choice; the account becomes the label.
 */
function checkAtlassianAuth(value: string): CheckedCredential {
  const mistake = NOT_ATLASSIAN.find(([shape]) => shape.test(value));
  if (mistake !== undefined) {
    return { ok: false, error: mistake[1] };
  }
  return value.startsWith("{") ? checkAtlassianProfiles(value) : checkAtlassianAuthConf(value);
}

type TwgProfile = { id?: unknown; user?: unknown; credentials?: unknown };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * A JSON object whose `profiles` array has at least one profile with a credential holding a non-empty
 * `oauthRefreshToken`. The label is the `user` of the active environment's default profile, else of the first
 * profile that can refresh.
 */
function checkAtlassianProfiles(value: string): CheckedCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "that is not a twg auth-profiles.json: it is not JSON" };
  }
  const file = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const profiles = Array.isArray(file.profiles) ? (file.profiles as TwgProfile[]) : [];
  const credentials = (p: TwgProfile) =>
    typeof p?.credentials === "object" && p.credentials !== null ? (Object.values(p.credentials) as { user?: unknown; oauthRefreshToken?: unknown }[]) : [];
  const signedIn = profiles.filter((p) => credentials(p).some((c) => nonEmpty(c?.oauthRefreshToken)));
  if (signedIn.length === 0) {
    return { ok: false, error: "that twg auth-profiles.json has no oauthRefreshToken: sign in to twg with OAuth again" };
  }
  const defaults = typeof file.defaults === "object" && file.defaults !== null ? (file.defaults as Record<string, unknown>) : {};
  const active = typeof file.activeEnvironment === "string" ? defaults[file.activeEnvironment] : undefined;
  const profile = signedIn.find((p) => p.id === active) ?? (signedIn[0] as TwgProfile);
  const user = [profile.user, ...credentials(profile).map((c) => c?.user)].find(nonEmpty);
  return { ok: true, value, accountLabel: user?.trim() || null };
}

/** `#` comments and `key=value` lines, which must include `oauth-refresh-token`. The label is `user=`. */
function checkAtlassianAuthConf(value: string): CheckedCredential {
  const settings = new Map<string, string>();
  for (const [index, raw] of value.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const setting = AUTH_CONF_LINE.exec(line);
    if (setting === null) {
      return { ok: false, error: `that is not a twg auth.conf: line ${index + 1} is not a key=value setting or a # comment` };
    }
    settings.set(setting[1] as string, (setting[2] as string).trim());
  }
  if (!settings.get("oauth-refresh-token")) {
    return { ok: false, error: "that twg auth.conf has no oauth-refresh-token: sign in to twg with OAuth again" };
  }
  return { ok: true, value, accountLabel: settings.get("user") || null };
}

function checkJenkinsToken(value: string): CheckedCredential {
  const mistake = NOT_JENKINS.find(([shape]) => shape.test(value));
  if (mistake !== undefined) {
    return { ok: false, error: mistake[1] };
  }
  return JENKINS_TOKEN.test(value)
    ? { ok: true, value, accountLabel: null }
    : { ok: false, error: "that is not a Jenkins API token: expected 20 to 200 printable characters with no spaces, from your Jenkins user's Configure page" };
}
