import { gunzipSync } from "node:zlib";
import type { CredentialKind } from "./names.ts";

/** A Key Vault secret value is at most 25 KB; this leaves room for the encoding overhead. */
export const MAX_CREDENTIAL_LENGTH = 24_000;

/** How far an Azure token cache may expand when gunzipped, so a crafted value cannot exhaust the pod's memory. */
const MAX_AZURE_CACHE_BYTES = 1024 * 1024;

const GITHUB_TOKEN = /^(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/** `claude setup-token` prints an `sk-ant-oat…` OAuth token; an API key is `sk-ant-api…`, and both fit this. */
const CLAUDE_TOKEN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type CheckedCredential = { ok: true; value: string; accountLabel: string | null } | { ok: false; error: string };

const LABELS: Record<CredentialKind, string> = {
  github: "a GitHub token",
  azure: "an Azure token cache",
  claude: "a Claude token"
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
 * An Azure CLI token cache as the pod sends it: the MSAL cache JSON, gzipped and base64-encoded. It has to decode,
 * gunzip and parse to an object with an `Account` section, or it is not something `az` can use.
 */
function checkAzureCache(value: string): CheckedCredential {
  const refused: CheckedCredential = { ok: false, error: "that is not an Azure token cache: expected base64 of a gzipped MSAL cache" };
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    return refused;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(Buffer.from(value, "base64"), { maxOutputLength: MAX_AZURE_CACHE_BYTES }).toString("utf8"));
  } catch {
    return refused;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("Account" in parsed)) {
    return { ok: false, error: "that Azure token cache has no Account section" };
  }
  return { ok: true, value, accountLabel: accountUsername((parsed as { Account: unknown }).Account) };
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
    case "azure":
      return checkAzureCache(value);
  }
}
