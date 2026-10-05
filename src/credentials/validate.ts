import { gunzipSync } from "node:zlib";
import type { CredentialKind } from "./names.ts";

/** A Key Vault secret value is at most 25 KB; this leaves room for the encoding overhead. */
export const MAX_CREDENTIAL_LENGTH = 24_000;

/** How far an Azure token cache may expand when gunzipped, so a crafted value cannot exhaust the pod's memory. */
const MAX_AZURE_CACHE_BYTES = 1024 * 1024;

const GITHUB_TOKEN = /^(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/** `claude setup-token` prints an `sk-ant-oat…` OAuth token; an API key is `sk-ant-api…`, and both fit this. */
const CLAUDE_TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/**
 * An Amazon Bedrock API key is opaque: long-term keys usually start `ABSK` and short-term ones `bedrock-api-key-`,
 * but AWS does not promise either, so only its length and printable, space-free ASCII are required.
 */
const BEDROCK_KEY = /^[\x21-\x7e]{20,4096}$/;

/** Things people paste by mistake for a Bedrock API key, each with what it actually is. */
const NOT_BEDROCK: readonly (readonly [RegExp, string])[] = [
  [/^(gh[a-z]_|github_pat_)/, "that is a GitHub token, not an Amazon Bedrock API key"],
  [/^sk-ant-/, "that is a Claude token, not an Amazon Bedrock API key: paste the key AWS gave you for Bedrock"],
  [/^(AKIA|ASIA)[A-Z0-9]{16}$/, "that is an AWS access key id, not an Amazon Bedrock API key: create an API key in the Bedrock console"]
];

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type CheckedCredential = { ok: true; value: string; accountLabel: string | null } | { ok: false; error: string };

const LABELS: Record<CredentialKind, string> = {
  github: "a GitHub token",
  azure: "an Azure token cache",
  claude: "a Claude token",
  bedrock: "an Amazon Bedrock API key"
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

export type AzureOwnership = { ok: true } | { ok: false; reason: "malformed" | "unconfigured" | "not-owner"; error: string };

/**
 * Whether an Azure token cache holds only the owner's own sign-in: at least one account, and every account's
 * `home_account_id`, which MSAL writes as `<oid>.<tid>`, naming the owner's oid in this hub's tenant. A cache with
 * anyone else's account in it would let a virtual agent act in Azure as that person.
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
  for (const account of accounts) {
    const home = (account as { home_account_id?: unknown } | null)?.home_account_id;
    const [oid, tid, ...rest] = typeof home === "string" ? home.toLowerCase().split(".") : [];
    if (oid !== owner || tid !== tenant || rest.length > 0) {
      return { ok: false, reason: "not-owner", error: "that Azure token cache is signed in as someone other than you, or in another tenant" };
    }
  }
  return { ok: true };
}

/**
 * Whether `raw` is a credential of `kind`, trimmed. The value never appears in a refusal, which is shown to the
 * person and may be logged.
 */
export function checkCredential(kind: CredentialKind, raw: unknown): CheckedCredential {
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
    case "bedrock":
      return checkBedrockKey(value);
    case "azure":
      return checkAzureCache(value);
  }
}

function checkBedrockKey(value: string): CheckedCredential {
  const mistake = NOT_BEDROCK.find(([shape]) => shape.test(value));
  if (mistake !== undefined) {
    return { ok: false, error: mistake[1] };
  }
  return BEDROCK_KEY.test(value)
    ? { ok: true, value, accountLabel: null }
    : { ok: false, error: "that is not an Amazon Bedrock API key: expected 20 to 4096 printable characters with no spaces" };
}
