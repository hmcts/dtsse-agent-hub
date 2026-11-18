// The supervisor's half of the Docmosis template library: one check of the library's index for the hub, read from
// GitHub's REST API with the owner's own `gh` token. An unchanged library is an ETag'd `304`, and only a commit that
// moved costs a tree read. Every value in the frame is checked again here. See "Docmosis template library" in
// dtsse-agent-hub's docs/agent-api.md.
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE } from "../github.ts";
import { withRetry } from "../retry.ts";
import type { DocmosisIndexAnswer, DocmosisIndexEntry } from "../wire.ts";
import { commitCheck, type FetchLike, GithubRestError, githubToken, isGitRef, isGitSha, type Template, templates } from "./github-rest.ts";
import type { Run } from "./lookups.ts";

/** The hub's limits on an answer. */
export const MAX_INDEX_ENTRIES = 10_000;
export const MAX_INDEX_BYTES = 1024 * 1024;
export const MAX_LIBRARY_PATH = 400;
const MAX_DETAIL = 300;
const MAX_ETAG = 200;
/** Room in the 1 MiB for the commit, the ETag and the JSON around the entries. */
const ANSWER_OVERHEAD = 1024;
/** Inside the two minutes the hub waits for an answer, so one is never thrown away. */
export const INDEX_BUDGET_MS = 100_000;

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const ETAG_RE = /^(W\/)?"[\x21\x23-\x7e]*"$/;
// A folder in the repository: names separated by `/`, never `.` or `..`.
const FOLDER_RE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type DocmosisIndexFrame = {
  request_id: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
  commit: string | null;
  etag: string | null;
};

function isEtag(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ETAG && ETAG_RE.test(value);
}

/** The check on a sessions stream frame, or null for anything that is not exactly one. */
export function parseIndexFrame(value: unknown): DocmosisIndexFrame | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    !raw ||
    typeof raw.request_id !== "string" ||
    !UUID_RE.test(raw.request_id) ||
    typeof raw.owner !== "string" ||
    !GITHUB_OWNER_RE.test(raw.owner) ||
    typeof raw.repo !== "string" ||
    !GITHUB_REPO_RE.test(`${raw.owner}/${raw.repo}`) ||
    !isGitRef(raw.ref) ||
    typeof raw.path !== "string" ||
    raw.path.length > 200 ||
    !FOLDER_RE.test(raw.path) ||
    !(raw.commit === null || isGitSha(raw.commit)) ||
    !(raw.etag === null || isEtag(raw.etag))
  ) {
    return null;
  }
  return { request_id: raw.request_id, owner: raw.owner, repo: raw.repo, ref: raw.ref, path: raw.path, commit: raw.commit, etag: raw.etag };
}

/** The hub's rule for a path its index holds; see `isLibraryPath` in the service's `src/assistant/docmosis-library.ts`. */
export function isLibraryPath(path: string, folder: string): boolean {
  if (path.length > MAX_LIBRARY_PATH || !path.startsWith(`${folder}/`) || CONTROL_RE.test(path) || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  const name = segments.at(-1) as string;
  return name.toLowerCase().endsWith(".docx") && !name.startsWith("~$");
}

/**
 * The templates as the hub takes them: library paths only, in the order given, and no more than fit the hub's count
 * and its 1 MiB, measured as it measures the stored entries, with a space after every comma.
 */
export function indexEntries(found: readonly Template[], folder: string): { entries: DocmosisIndexEntry[]; dropped: number } {
  const entries: DocmosisIndexEntry[] = [];
  let bytes = 2 + ANSWER_OVERHEAD;
  let dropped = 0;
  for (const template of found) {
    if (!isLibraryPath(template.path, folder)) {
      dropped += 1;
      continue;
    }
    const entry: DocmosisIndexEntry = [template.path, template.sha, template.size];
    const size = Buffer.byteLength(JSON.stringify(entry)) + 4;
    if (entries.length >= MAX_INDEX_ENTRIES || bytes + size > MAX_INDEX_BYTES) {
      dropped += 1;
      continue;
    }
    entries.push(entry);
    bytes += size;
  }
  return { entries, dropped };
}

const clip = (text: string): string => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL - 1)}…` : trimmed || "Something went wrong.";
};

export type DocmosisIndexDeps = {
  api: Pick<Api, "putDocmosisIndex">;
  /** The virtual agent's id. */
  id: string;
  run: Run;
  env: Env;
  fetch?: FetchLike;
  say?: (message: string) => void;
  budgetMs?: number;
};

/** One check, answered as the hub takes it. Never throws, and never says the token. */
export async function runIndex(deps: DocmosisIndexDeps, frame: DocmosisIndexFrame): Promise<DocmosisIndexAnswer> {
  const token = await githubToken(deps.run, deps.env).catch(() => null);
  if (token === null) {
    return { error: "signed_out", detail: "Your assistant isn't signed in to GitHub. Sign in to GitHub again." };
  }
  const gh = { fetch: deps.fetch ?? globalThis.fetch, token, signal: AbortSignal.timeout(deps.budgetMs ?? INDEX_BUDGET_MS) };
  try {
    // An ETag is only worth sending for an index the hub still holds: a 304 says nothing to a hub with none.
    const check = await commitCheck(gh, frame.owner, frame.repo, frame.ref, frame.commit === null ? null : frame.etag);
    const etag = isEtag(check.etag) ? check.etag : null;
    if (!check.modified || check.sha === frame.commit) {
      return etag === null ? { unchanged: true } : { unchanged: true, etag };
    }
    const found = await templates(gh, frame.owner, frame.repo, check.sha, frame.path);
    const { entries, dropped } = indexEntries(found, frame.path);
    if (dropped > 0) {
      deps.say?.(`docmosis index ${frame.request_id}: left out ${dropped} template(s) the hub cannot hold`);
    }
    return { commit: check.sha, etag, entries };
  } catch (e) {
    // What fetch threw is passed on to the person, so the token is taken out of it in case it ever says the header.
    const hidden = (text: string) => clip(text.replaceAll(token, "[redacted]"));
    if (e instanceof GithubRestError) {
      return { ...e.failure, detail: hidden(e.failure.detail) };
    }
    return { error: "failed", detail: hidden(`Reading the template library failed: ${(e as Error).message}`) };
  }
}

export type DocmosisIndexRunner = {
  /** Takes a `docmosis_index` frame's data and runs it once the check before it is done. */
  docmosisIndex: (data: unknown) => void;
  /** Resolves once nothing is running or waiting; for a test, and for the supervisor's shutdown. */
  idle: () => Promise<void>;
};

/**
 * One check at a time. A frame that arrives while one runs waits, replacing any frame already waiting: the hub sends
 * another only once it has stopped waiting for the last, so the replaced one has nobody to answer to.
 */
export function createDocmosisIndexRunner(deps: DocmosisIndexDeps): DocmosisIndexRunner {
  const say = deps.say ?? (() => {});
  let running: Promise<void> | null = null;
  let waiting: DocmosisIndexFrame | null = null;

  const start = (frame: DocmosisIndexFrame): void => {
    running = runIndex(deps, frame)
      .then((answer) => withRetry(() => deps.api.putDocmosisIndex(deps.id, frame.request_id, answer), { attempts: 2 }))
      .then(
        () => undefined,
        (e: unknown) => say(`docmosis index ${frame.request_id}: could not answer it: ${(e as Error).message}`)
      )
      .finally(() => {
        running = null;
        const next = waiting;
        waiting = null;
        if (next !== null) {
          start(next);
        }
      });
  };

  return {
    docmosisIndex(data) {
      const frame = parseIndexFrame(data);
      if (!frame) {
        say(`ignoring a docmosis index check that is not one: ${JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      if (running === null) {
        start(frame);
      } else {
        waiting = frame;
      }
    },
    async idle() {
      while (running !== null) {
        await running;
      }
    }
  };
}
