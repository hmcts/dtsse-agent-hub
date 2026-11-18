import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";

/**
 * The Docmosis template library: an index of the `.docx` files in one folder of a GitHub repository, read by the
 * person's own pod with their own `gh` sign-in and kept by the hub so the browser can search it without asking the pod
 * per keystroke. See "Docmosis template library" in docs/agent-api.md.
 */

export const DOCMOSIS_LIBRARY = { owner: "hmcts", repo: "rdo-docmosis", ref: "HEAD", path: "Templates" } as const;

export const DOCMOSIS_LIBRARY_ID = `${DOCMOSIS_LIBRARY.owner}/${DOCMOSIS_LIBRARY.repo}@${DOCMOSIS_LIBRARY.ref}:${DOCMOSIS_LIBRARY.path}`;

export const MAX_INDEX_ENTRIES = 10_000;
/** The pod's answer, and the stored entries, which the migration checks too. */
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_LIBRARY_PATH = 400;
/** How old the last check may be before opening the library asks for another. */
export const INDEX_REVALIDATE_MS = 5 * 60_000;
/** The least time between two forced checks: each one is GitHub API calls on the person's own rate limit. */
export const FORCED_REFRESH_MIN_MS = 30_000;
/** How long a check sent to the pod is waited for; past this it counts as lost, and its answer is ignored. */
export const INDEX_REFRESH_PENDING_MS = 2 * 60_000;
export const MAX_INDEX_DETAIL = 300;
export const MAX_ETAG = 200;
const MAX_SSO_URL = 500;

export const INDEX_FAILURES = ["signed_out", "sso", "not_found", "rate_limited", "failed"] as const;
export type IndexFailureReason = (typeof INDEX_FAILURES)[number];

const SHA1_RE = /^[0-9a-f]{40}$/;
export const ETAG_RE = /^(W\/)?"[\x21\x23-\x7e]*"$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && SHA1_RE.test(value);
}

/**
 * Whether `path` is one the library holds: a `.docx` under the library's folder that is not one of Word's `~$` lock
 * files. Every segment is a real name, so a path can never climb out of the folder or name it twice.
 */
export function isLibraryPath(path: unknown, folder: string = DOCMOSIS_LIBRARY.path): path is string {
  if (typeof path !== "string" || path.length > MAX_LIBRARY_PATH || !path.startsWith(`${folder}/`)) {
    return false;
  }
  if (CONTROL_RE.test(path) || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  const name = segments.at(-1) as string;
  return name.toLowerCase().endsWith(".docx") && !name.startsWith("~$");
}

/** One entry of an index: the path, the blob's git SHA-1, and its size in bytes. */
export type IndexEntry = [path: string, blobSha: string, size: number];

const etag = z.string().max(MAX_ETAG).regex(ETAG_RE, "is not an entity tag");

const entry = z.tuple([
  z.string().max(MAX_LIBRARY_PATH),
  z.string().regex(SHA1_RE, "is not a git SHA-1"),
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
]);

const indexBody = z.strictObject({
  commit: z.string().regex(SHA1_RE, "is not a commit SHA-1"),
  etag: etag.nullable(),
  entries: boundedArray(entry, MAX_INDEX_ENTRIES, {
    message: `an index holds at most ${MAX_INDEX_ENTRIES} entries`,
    refine: { check: (entries) => new Set(entries.map(([path]) => path)).size === entries.length, message: "names a path more than once" }
  })
});

const unchangedBody = z.strictObject({ unchanged: z.literal(true), etag: etag.nullable().optional() });

const failureBody = z.strictObject({
  error: z.enum(INDEX_FAILURES),
  detail: z.string().trim().min(1).max(MAX_INDEX_DETAIL).optional(),
  sso_url: z
    .string()
    .max(MAX_SSO_URL)
    .refine((url) => url.startsWith("https://github.com/") && URL.canParse(url), "is not a page on github.com")
    .optional(),
  reset_at: z.iso.datetime({ offset: true }).optional()
});

/** The pod's answer to one check: a new index, the one held is still current, or why there is neither. */
export const indexAnswerBody = z.union([indexBody, unchangedBody, failureBody]);

export type IndexAnswer = z.output<typeof indexAnswerBody>;

/**
 * The size of `entries` as Postgres prints the jsonb column, which the migration's CHECK measures: JSON with a space
 * after every comma. An upper bound, so a set that passes here never fails the CHECK.
 */
export function storedEntriesBytes(entries: readonly IndexEntry[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength + 3 * entries.length;
}

/** The columns of an index row that decide what opening the library does and what the browser is told. */
export interface LibraryRow {
  ownerOid: string;
  commitSha: string | null;
  entryCount: number;
  checkedAt: Date | null;
  refreshId: string | null;
  refreshRequestedAt: Date | null;
  refreshForced: boolean;
  error: string | null;
  detail: string | null;
  ssoUrl: string | null;
  resetAt: Date | null;
}

/** Whether a check has been sent to the pod and may still be answered. */
export function refreshPending(row: Pick<LibraryRow, "refreshId" | "refreshRequestedAt">, now: Date): boolean {
  return row.refreshId !== null && row.refreshRequestedAt !== null && now.getTime() - row.refreshRequestedAt.getTime() < INDEX_REFRESH_PENDING_MS;
}

/**
 * Whether a forced check is refused because the last forced one was asked for within `FORCED_REFRESH_MIN_MS`. One
 * still pending is joined instead, which costs nothing, so it is never refused.
 */
export function forcedTooSoon(row: LibraryRow | null, now: Date): boolean {
  if (row === null || !row.refreshForced || row.refreshRequestedAt === null || refreshPending(row, now)) {
    return false;
  }
  return now.getTime() - row.refreshRequestedAt.getTime() < FORCED_REFRESH_MIN_MS;
}

/**
 * What opening the library asks of the pod: nothing, a new check, or the one already pending. A check is asked for
 * when there is no index, when the last check is `INDEX_REVALIDATE_MS` old, or when forced.
 */
export function refreshDecision(row: LibraryRow | null, now: Date, force: boolean): "none" | "ask" | "join" {
  if (row === null) {
    return "ask";
  }
  if (refreshPending(row, now)) {
    return "join";
  }
  if (force || row.checkedAt === null || row.commitSha === null) {
    return "ask";
  }
  return now.getTime() - row.checkedAt.getTime() >= INDEX_REVALIDATE_MS ? "ask" : "none";
}

/** Whether the pod can be asked now; `stopped` is a stopped pod the hub has an index for, and so does not start. */
export type LibraryPodGate = "ok" | "waking" | "stopped" | "unsupported";

export interface IndexFailure {
  reason: IndexFailureReason;
  detail?: string;
  sso_url?: string;
  reset_at?: string;
}

export interface LibraryStatus {
  library: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  pod: LibraryPodGate;
  commit: string | null;
  entry_count: number;
  checked_at: string | null;
  refreshing: boolean;
  failure: IndexFailure | null;
}

function failureOf(row: LibraryRow): IndexFailure | null {
  if (row.error === null || !(INDEX_FAILURES as readonly string[]).includes(row.error)) {
    return null;
  }
  return {
    reason: row.error as IndexFailureReason,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.ssoUrl === null ? {} : { sso_url: row.ssoUrl }),
    ...(row.resetAt === null ? {} : { reset_at: row.resetAt.toISOString() })
  };
}

/** What `POST /api/ui/assistant/docmosis-library` answers, from the row as it stands after any check was asked for. */
export function libraryStatus(row: LibraryRow | null, gate: LibraryPodGate, now: Date): LibraryStatus {
  return {
    library: DOCMOSIS_LIBRARY_ID,
    ...DOCMOSIS_LIBRARY,
    pod: gate,
    commit: row?.commitSha ?? null,
    entry_count: row === null || row.commitSha === null ? 0 : row.entryCount,
    checked_at: row?.checkedAt?.toISOString() ?? null,
    refreshing: row !== null && refreshPending(row, now),
    failure: row === null ? null : failureOf(row)
  };
}
