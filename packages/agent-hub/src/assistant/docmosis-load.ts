// The pod's half of `docmosis.load`: a template the person picked from their template library, loaded into their
// conversation. The blob is read with the owner's own `gh` token, kept on disk by its git SHA-1, read for its form
// schema with the docmosis CLI and published through the agent API with `pick` naming the job, which is what makes the
// hub record the version as the person's own and finish the job in the same write. See "Docmosis template library"
// in dtsse-agent-hub's docs/agent-api.md.
import { createHash, randomUUID } from "node:crypto";
import nodeFs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { ApiError } from "../api.ts";
import { checkDocx, checkSchemaObject, DocmosisConversationMissingError, publishDocmosis } from "../cli/docmosis.ts";
import type { Env } from "../env.ts";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE, ghAuthToken } from "../github.ts";
import { REDACTED, redactTokens } from "../virtual/process.ts";
import { isLibraryFolder } from "./docmosis-library.ts";
import { DOCMOSIS_LOAD_KIND, LOAD_BUDGET_MS } from "./docmosis-load-kind.ts";
import { BlobTooLargeError, blob, type FetchLike, GithubRestError, isGitSha, isLibraryPath } from "./github-rest.ts";
import type { Run } from "./lookups.ts";
import { type PodJobContext, PodJobError, type PodJobHandler } from "./pod-jobs.ts";

/** The hub's cap on a template's .docx. */
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
/** Roughly how much the blob cache keeps, newest first; a pick needs one blob, and the rest only save a fetch. */
export const CACHE_BYTES = 200 * 1024 * 1024;
/**
 * The parts of `LOAD_BUDGET_MS`, each a cap on one step. Together with what the publish is kept they leave a margin
 * inside the budget, so a load whose every step runs to its cap still ends before the budget aborts it.
 */
export const TOKEN_TIMEOUT_MS = 10_000;
export const GITHUB_TIMEOUT_MS = 25_000;
export const SCHEMA_TIMEOUT_MS = 40_000;
export const PUBLISH_RESERVE_MS = 15_000;
const MAX_NAME = 200;
const MAX_DETAIL = 300;

export type DocmosisLoadArgs = {
  owner: string;
  repo: string;
  folder: string;
  path: string;
  blob_sha: string;
  base_version: number;
  base_revision: number;
};

const ARG_KEYS: readonly string[] = ["owner", "repo", "folder", "path", "blob_sha", "base_version", "base_revision"];

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * The job's arguments, checked again as the hub's schema checked them, with the library the hub added: the path must
 * be under the folder it names. `null` for anything else.
 */
export function parseLoadArgs(value: unknown): DocmosisLoadArgs | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    !raw ||
    Object.keys(raw).some((key) => !ARG_KEYS.includes(key)) ||
    typeof raw.owner !== "string" ||
    !GITHUB_OWNER_RE.test(raw.owner) ||
    typeof raw.repo !== "string" ||
    !GITHUB_REPO_RE.test(`${raw.owner}/${raw.repo}`) ||
    !isLibraryFolder(raw.folder) ||
    typeof raw.path !== "string" ||
    !isLibraryPath(raw.path, raw.folder) ||
    !isGitSha(raw.blob_sha) ||
    !isCount(raw.base_version) ||
    !isCount(raw.base_revision)
  ) {
    return null;
  }
  return {
    owner: raw.owner,
    repo: raw.repo,
    folder: raw.folder,
    path: raw.path,
    blob_sha: raw.blob_sha,
    base_version: raw.base_version,
    base_revision: raw.base_revision
  };
}

/** Git's SHA-1 of a blob, `blob <length>\0` and then the bytes: how the library's index names each template. */
export function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** At most `max` UTF-16 units, the hub's measure, cut between code points so a surrogate pair is never split. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let out = "";
  for (const point of text) {
    if (out.length + point.length > max - 1) {
      break;
    }
    out += point;
  }
  return `${out}…`;
}

/** The cache's folder under the pod's home. */
export function blobCacheDir(env: Env): string {
  return nodePath.join(env.HOME || os.homedir(), ".agent-hub", "docmosis-library", "blobs");
}

/**
 * The command and environment the docmosis CLI runs with. The image installs it into nvm's global bin, beside the node
 * this supervisor runs on, and not onto `/usr/local/bin`, so that directory goes first on the PATH it is looked up on.
 */
export function docmosisCommand(env: Env, execPath: string = process.execPath): { cmd: string; env: Env } {
  const bin = nodePath.dirname(execPath);
  return { cmd: "docmosis", env: { ...env, PATH: env.PATH ? `${bin}${nodePath.delimiter}${env.PATH}` : bin } };
}

export type CacheFs = Pick<typeof nodeFs, "readFile" | "writeFile" | "rename" | "mkdir" | "readdir" | "stat" | "rm" | "utimes">;

/** The cached blob when its bytes still hash to `sha`, touched so the prune keeps it; `undefined` otherwise. */
async function cached(fs: CacheFs, file: string, sha: string): Promise<Uint8Array | undefined> {
  const bytes = await fs.readFile(file).catch(() => undefined);
  if (bytes === undefined || gitBlobSha1(bytes) !== sha) {
    return undefined;
  }
  const now = new Date();
  await fs.utimes(file, now, now).catch(() => undefined);
  return new Uint8Array(bytes);
}

/** Written beside its name and renamed into place, so a reader never sees half a blob. */
async function store(fs: CacheFs, dir: string, file: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    await fs.writeFile(partial, bytes);
    await fs.rename(partial, file);
  } catch (e) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Removes the oldest blobs until what is left fits `limit`, never `keep`, the one in hand. Best effort. */
export async function pruneCache(fs: CacheFs, dir: string, keep: string, limit: number = CACHE_BYTES): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const blobs: { file: string; size: number; mtime: number }[] = [];
  for (const name of names) {
    const file = nodePath.join(dir, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile()) {
      blobs.push({ file, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  blobs.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  let total = 0;
  for (const entry of blobs) {
    total += entry.size;
    if (total > limit && entry.file !== keep) {
      await fs.rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}

const tooLarge = (name: string) => new PodJobError("too_large", `${name} is larger than ${MAX_TEMPLATE_BYTES} bytes, more than the Assistant can open.`);

/**
 * A blob, refused as the hub would refuse it, with the code the panel words. `sha` is left out for a cached blob,
 * which `cached` has already hashed.
 */
function checkBlob(bytes: Uint8Array, name: string, sha?: string): Uint8Array {
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw tooLarge(name);
  }
  if (sha !== undefined && gitBlobSha1(bytes) !== sha) {
    throw new PodJobError("checksum", `What GitHub sent for ${name} is not the template you picked. Try again.`);
  }
  // The size is checked above, so all `checkDocx` can still refuse is the zip signature.
  try {
    return checkDocx(bytes, name);
  } catch {
    throw new PodJobError("not_docx", `${name} is not a .docx.`);
  }
}

export type DocmosisLoadDeps = {
  run: Run;
  fetch?: FetchLike;
  fs?: CacheFs;
  /** The node binary the docmosis CLI is installed beside; a test passes its own. */
  execPath?: string;
};

async function readTemplate(deps: DocmosisLoadDeps, fs: CacheFs, ctx: PodJobContext, args: DocmosisLoadArgs, token: string, file: string): Promise<Uint8Array> {
  const name = basename(args.path);
  const hit = await cached(fs, file, args.blob_sha);
  if (hit !== undefined) {
    return checkBlob(hit, name);
  }
  const gh = { fetch: deps.fetch ?? globalThis.fetch, token, signal: ctx.signal, timeoutMs: GITHUB_TIMEOUT_MS };
  const fetched = await blob(gh, args.owner, args.repo, args.blob_sha, MAX_TEMPLATE_BYTES).catch((e: unknown) => {
    throw e instanceof BlobTooLargeError ? tooLarge(name) : e;
  });
  const bytes = checkBlob(fetched, name, args.blob_sha);
  const dir = nodePath.dirname(file);
  await store(fs, dir, file, bytes);
  await pruneCache(fs, dir, file);
  return bytes;
}

async function readSchema(deps: DocmosisLoadDeps, ctx: PodJobContext, file: string, name: string) {
  const { cmd, env } = docmosisCommand(ctx.env, deps.execPath);
  const result = await deps.run(cmd, ["schema", file], { env, timeoutMs: SCHEMA_TIMEOUT_MS, signal: ctx.signal });
  stopIfAborted(ctx.signal);
  if (result.code !== 0) {
    const why = result.stderr.trim() || result.stdout.trim() || `docmosis schema exited ${result.code}`;
    throw new PodJobError("schema_failed", `The form could not be read from ${name}: ${why}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new PodJobError("schema_failed", `The form could not be read from ${name}: docmosis schema printed something that is not JSON.`);
  }
  try {
    return checkSchemaObject(parsed, name);
  } catch (e) {
    throw new PodJobError("schema_failed", `The form could not be read from ${name}: ${(e as Error).message}`);
  }
}

/**
 * Ends a load whose budget ran out. The runner has answered `timeout` by then, so what this throws is never sent; it
 * is there so nothing after it, the publish above all, runs once the person has been told the load failed.
 */
function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PodJobError("failed", "The load ran out of time.");
  }
}

async function load(deps: DocmosisLoadDeps, raw: unknown, ctx: PodJobContext, held: { token: string | null }): Promise<{ version: number; revision: number }> {
  const args = parseLoadArgs(raw);
  if (args === null) {
    throw new PodJobError("failed", "That is not a template from the library.");
  }
  if (ctx.agentId === undefined) {
    throw new PodJobError("failed", "This chat's session is not ready yet. Try again in a moment.");
  }
  const token = await ghAuthToken((cmd, argv, opts) => deps.run(cmd, argv, { ...opts, signal: ctx.signal }), ctx.env, TOKEN_TIMEOUT_MS).catch(() => null);
  held.token = token;
  stopIfAborted(ctx.signal);
  if (token === null) {
    throw new PodJobError("signed_out", "Your assistant isn't signed in to GitHub. Sign in to GitHub again.");
  }
  const fs = deps.fs ?? nodeFs;
  const name = clip(basename(args.path), MAX_NAME);
  const file = nodePath.join(blobCacheDir(ctx.env), `${args.blob_sha}.docx`);
  const docx = await readTemplate(deps, fs, ctx, args, token, file);
  const schema = await readSchema(deps, ctx, file, name);
  // Checked again between the asset and the version, which is the write that records the pick and finishes the job.
  const api: Pick<PodJobContext["api"], "putDocmosisAsset" | "putDocmosis"> = {
    putDocmosisAsset: (agentId, sha256, bytes) => {
      stopIfAborted(ctx.signal);
      return ctx.api.putDocmosisAsset(agentId, sha256, bytes);
    },
    putDocmosis: (agentId, body) => {
      stopIfAborted(ctx.signal);
      return ctx.api.putDocmosis(agentId, body);
    }
  };
  const published = await publishDocmosis(api, ctx.agentId, {
    docx,
    schema,
    data: {},
    name,
    base: args.base_version,
    baseRevision: args.base_revision,
    summary: clip(`Loaded ${name}`, MAX_NAME),
    pick: ctx.jobId
  });
  if ("conflict" in published) {
    throw new PodJobError("conflict", "The template in this chat changed while yours was loading.");
  }
  return { version: published.written.version, revision: published.written.revision };
}

/**
 * What a failure answers, its words cleaned of the token in case anything it came from ever said the header, and of
 * anything else credential-shaped, as the library's index check cleans its own.
 */
function failure(e: unknown, token: string | null): PodJobError {
  const hide = (text: string) => clip(redactTokens((token === null ? text : text.replaceAll(token, REDACTED)).replace(/\s+/g, " ").trim()), MAX_DETAIL);
  if (e instanceof PodJobError) {
    return new PodJobError(e.code, e.detail === undefined ? undefined : hide(e.detail));
  }
  if (e instanceof GithubRestError) {
    return new PodJobError(e.failure.error, hide(e.failure.detail));
  }
  if (e instanceof DocmosisConversationMissingError) {
    return new PodJobError("failed", "This chat is not on the hub any more.");
  }
  if (e instanceof ApiError) {
    return new PodJobError("failed", hide(`The hub would not take the template: ${e.message}`));
  }
  return new PodJobError("failed", hide(`Loading the template failed: ${e instanceof Error ? e.message : String(e)}`));
}

/**
 * The `docmosis.load` handler. It answers `done` with the version written even though the hub finished the job in that
 * same write: the hub ignores an answer to a job no longer pending, with the same 204, so the answer is harmless, and
 * sending it keeps this handler like every other.
 */
export function docmosisLoadHandler(deps: DocmosisLoadDeps): PodJobHandler {
  return {
    kind: DOCMOSIS_LOAD_KIND,
    budgetMs: LOAD_BUDGET_MS,
    run: async (raw, ctx) => {
      const held: { token: string | null } = { token: null };
      try {
        return await load(deps, raw, ctx, held);
      } catch (e) {
        throw failure(e, held.token);
      }
    }
  };
}
