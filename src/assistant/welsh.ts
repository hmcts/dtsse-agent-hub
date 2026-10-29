import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { PRODUCTS } from "./products.ts";

/**
 * Welsh translation jobs for the Assistant's Welsh page: the kinds, what each takes, the limits, what the pod may
 * answer, and what the browser is shown. Pure. Every job is one run of cft-workspace's `scripts/welsh` in the person's
 * pod, with their own GitHub and `twg` sign-ins, so the hub holds neither and calls nothing; `welsh-store.ts` records
 * the job and reads back the answer. No job goes through a model turn, and none generates Welsh: it comes from the
 * service's catalogue or a Welsh Language Unit return, and `scripts/welsh verify` refuses anything else. See "Welsh
 * translation jobs" in docs/agent-api.md.
 */

export const WELSH_KINDS = [
  "info",
  "search",
  "scan",
  "import_check",
  "import",
  "apply_preview",
  "apply",
  "story_candidates",
  "story_preview",
  "story_write"
] as const;
export type WelshKind = (typeof WELSH_KINDS)[number];

/** The Welsh page's tasks, which `?task=` can open directly. */
export const WELSH_TASK_IDS = ["search", "scan", "return", "story"] as const;
export type WelshTask = (typeof WELSH_TASK_IDS)[number];

export function isWelshTask(value: unknown): value is WelshTask {
  return typeof value === "string" && (WELSH_TASK_IDS as readonly string[]).includes(value);
}

/** The kinds the page waits for, as a lookup does; every other kind is read back while it runs. */
export const QUICK_WELSH_KINDS: readonly WelshKind[] = ["info", "search"];

/** How long a quick job's request waits for the pod. */
export const WELSH_QUICK_WAIT_MS = 10_000;
/** How long any job may stay unanswered before it reads as timed out: a scan or a PR on a large repo takes minutes. */
export const WELSH_JOB_TIMEOUT_MS = 15 * 60_000;
/** How long a job and its files are kept: long enough to download a request a week after it was made. */
export const WELSH_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const WELSH_RATE_WINDOW_MS = 60_000;
export const WELSH_RATE_LIMIT = 30;

export const MAX_WELSH_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_WELSH_FILES_PER_JOB = 4;
export const MAX_WELSH_RESULT_BYTES = 512 * 1024;
export const MAX_WELSH_DETAIL = 500;
export const MAX_WELSH_QUERY = 100;
export const MAX_WELSH_STRINGS = 200;
export const MAX_WELSH_STRING = 2000;
export const MAX_WELSH_CHOICES = 200;

export const WELSH_REF_RE = /^CY-[0-9A-F]{8}$/;
export const WELSH_ROW_ID_RE = /^[0-9a-f]{10}$/;
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,7}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The public-facing services: those whose screens or letters reach the public, and so must be offered in Welsh.
 * Platform and staff-only products (CCD, XUI, Work Allocation, Access Management, Reference Data, bulk scan and print,
 * document stores, HMC, FPL's professional-only service, DTSSE tooling) are not offered, and `general` and
 * `platform` are not workspace products at all. A slug here must be a workspace `apps/<product>` directory.
 */
export const PUBLIC_FACING_SERVICES: readonly string[] = [
  "adoption",
  "cath",
  "civil",
  "cmc",
  "cuiys",
  "et",
  "fact",
  "finrem",
  "fis",
  "ia",
  "idam",
  "nfdiv",
  "payment",
  "pcs",
  "prl",
  "probate",
  "pt",
  "sptribs",
  "sscs"
];

/** The services the Welsh page offers, in the product list's order. */
export const WELSH_PRODUCTS = PRODUCTS.filter((product) => PUBLIC_FACING_SERVICES.includes(product.slug));

export function isWelshProduct(value: unknown): value is string {
  return typeof value === "string" && WELSH_PRODUCTS.some((product) => product.slug === value);
}

export function isWelshKind(value: unknown): value is WelshKind {
  return typeof value === "string" && (WELSH_KINDS as readonly string[]).includes(value);
}

const fileId = z.string().regex(UUID_RE, "that is not a file id");
const choices = boundedArray(z.object({ ref: z.string().regex(WELSH_REF_RE), row_id: z.string().regex(WELSH_ROW_ID_RE) }).strict(), MAX_WELSH_CHOICES);
const key = z.string().regex(JIRA_KEY_RE, "that is not a Jira key, like PUB-1234");

/** A repo is one of the product's own: `apps/<product>/<name>`, checked against the product separately. */
const repo = z.string().max(200);

const applyArgs = z.object({ repo: repo.optional(), file_id: fileId.optional(), choices: choices.optional() }).strict();

const ARG_SCHEMAS: Record<WelshKind, z.ZodTypeAny> = {
  info: z.object({}).strict(),
  search: z.object({ query: z.string().trim().min(1).max(MAX_WELSH_QUERY), mode: z.enum(["contains", "exact", "fuzzy"]).default("contains") }).strict(),
  scan: z.object({ repo: repo.optional() }).strict(),
  import_check: z.object({ file_id: fileId }).strict(),
  import: z.object({ file_id: fileId }).strict(),
  apply_preview: applyArgs,
  apply: applyArgs,
  story_candidates: z.object({ key }).strict(),
  story_preview: z
    .object({
      key,
      strings: boundedArray(z.string().trim().min(1).max(MAX_WELSH_STRING), MAX_WELSH_STRINGS, {
        message: `pick at most ${MAX_WELSH_STRINGS} English strings`
      }).refine((strings) => strings.length > 0, "pick at least one English string"),
      choices: choices.optional()
    })
    .strict(),
  story_write: z.object({ key }).strict()
};

export type WelshArgs = Record<string, unknown>;

/** A job's arguments, checked for its kind and its product, or the sentence saying what is wrong with them. */
export function welshArgs(kind: WelshKind, product: string, raw: unknown): { args: WelshArgs } | { error: string } {
  const parsed = ARG_SCHEMAS[kind].safeParse(raw ?? {});
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "those are not the right details for that" };
  }
  const args = parsed.data as WelshArgs;
  if (typeof args.repo === "string" && !isRepoOf(product, args.repo)) {
    return { error: `that is not one of ${product}'s repos` };
  }
  return { args };
}

/** Whether a repo path is `apps/<product>/<name>`, and nothing that could leave that directory. */
export function isRepoOf(product: string, path: string): boolean {
  const [apps, slug, name, ...rest] = path.split("/");
  return apps === "apps" && slug === product && rest.length === 0 && name !== undefined && REPO_NAME_RE.test(name) && name !== "." && name !== "..";
}

/** The file ids a job's arguments name, which the store checks are the person's own. */
export function fileIdsOf(args: WelshArgs): string[] {
  return typeof args.file_id === "string" ? [args.file_id] : [];
}

/** The pod's answer to one job: what scripts/welsh printed, or why it did not run. */
export const welshAnswerBody = z.union([
  z.object({ result: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ error: z.enum(["signed_out", "failed"]), detail: z.string().trim().max(MAX_WELSH_DETAIL).optional() }).strict()
]);
export type WelshAnswer = z.infer<typeof welshAnswerBody>;

/** Whether a result is small enough to keep: the page shows it, and nothing it shows needs more. */
export function resultFits(result: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_WELSH_RESULT_BYTES;
}

/** An `.xlsx` is a zip, and every zip starts `PK\x03\x04`. Not proof it is a spreadsheet, but enough to refuse a typo. */
export function isXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** A file name as stored and offered back: the last path part, safe characters only, ending `.xlsx`. */
export function welshFileName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return /\.xlsx$/i.test(clean) && clean.length > 5 ? clean : null;
}

export interface WelshFileView {
  file_id: string;
  name: string;
  bytes: number;
}

/** What the browser is answered: see "Welsh translation jobs" in docs/agent-api.md. */
export type WelshResponse =
  | { status: "done"; kind: WelshKind; result: Record<string, unknown>; files: WelshFileView[] }
  | { status: "pending"; job_id: string }
  | { status: "waking" }
  | { status: "unsupported" }
  | { status: "signed_out"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "timeout" };

/** A stored job as the browser's request reads it back. */
export interface WelshJobRow {
  id: string;
  kind: string;
  status: string;
  result: unknown;
  error: string | null;
  detail: string | null;
  createdAt: Date;
}

/** What a stored job answers now. */
export function welshResponse(row: WelshJobRow, files: WelshFileView[], now: Date = new Date()): WelshResponse {
  if (row.status === "pending") {
    return now.getTime() - row.createdAt.getTime() > WELSH_JOB_TIMEOUT_MS ? { status: "timeout" } : { status: "pending", job_id: row.id };
  }
  if (row.status === "done" && isWelshKind(row.kind) && isRecord(row.result)) {
    return { status: "done", kind: row.kind, result: row.result, files };
  }
  if (row.error === "signed_out") {
    return { status: "signed_out", detail: row.detail ?? "Your assistant needs you to sign in again." };
  }
  return { status: "failed", detail: row.detail ?? "That did not work. Try again." };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
