// The supervisor's half of a lookup: a search of the owner's Jira or Confluence, run with their own twg sign-in, or
// of their GitHub repositories or Projects with gh (`github-lookups.ts`), for the CFT Workspace's document panel and
// settings to pick where a document goes. Fixed and read-only: `twg jira space query`, or `twg confluence search
// query` and then `twg confluence space list` for the spaces of the pages it found that it has not read before, each
// value checked and passed as its own argument, never through a shell, and an answer cut down to the fields the hub
// accepts. See "Atlassian lookups" in dtsse-agent-hub's docs/agent-api.md.
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";
import { GITHUB_OWNER_RE } from "../github.ts";
import { withRetry } from "../retry.ts";
import type { ConfluencePageFound, JiraProjectFound, LookupAnswer } from "../wire.ts";
import { githubOwners, runGithubLookup } from "./github-lookups.ts";

export type LookupKind = "jira_project" | "confluence_page" | "github_repo" | "github_project";

const KINDS: readonly string[] = ["jira_project", "confluence_page", "github_repo", "github_project"];

/** A lookup as the sessions stream sends it, once every value has been checked. */
export type LookupFrame = {
  lookup_id: string;
  kind: LookupKind;
  query: string;
  space: string | null;
  /** For a GitHub Project: the repository owner whose Projects to search. */
  owner: string | null;
  sign_in: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;

export const MAX_LOOKUP_RESULTS = 10;
/** At most two twg searches at once: the pod is also running the person's sessions, and typing makes many. */
export const MAX_RUNNING_LOOKUPS = 2;
// The hub stops waiting 10 seconds after it sends the lookup. Every twg call of one search finishes inside this, which
// leaves the rest for the frame to arrive and the answer to be sent back.
const SEARCH_BUDGET_MS = 8000;
// Less than this left of the budget is too little for `space list` to answer in, so it is not started.
const MIN_SPACE_TIMEOUT_MS = 1000;
const WHOAMI_TIMEOUT_MS = 30000;
const MAX_WORDS = 6;
const MAX_WORD = 40;
const MAX_TITLE = 255;
const MAX_NAME = 200;
const MAX_DETAIL = 300;
// Enough of a page's opening words to tell it from another page of the same title.
const MAX_EXCERPT = 160;
// What twg exits with when it has no usable sign-in.
const TWG_EXIT_AUTH = 77;
const HTTP_UNAUTHORIZED = 401;

const LOOKUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A global space's key is letters, digits and `_-`; a personal space's is `~` and its owner's username, which can be
// an email address. None has a quote or a backslash, so a key is safe inside the CQL's quotes.
const SPACE_KEY_RE = /^(?:[A-Za-z0-9_-]{1,100}|~[A-Za-z0-9_.@-]{1,100})$/;
const NUMERIC_ID_RE = /^[0-9]{1,20}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const JSON_OUTPUT = ["-o", "json", "--output-summary=none"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The lookup on a sessions stream frame, or null for anything that is not exactly one. */
export function parseLookupFrame(value: unknown): LookupFrame | null {
  const raw = asRecord(value);
  if (
    !raw ||
    typeof raw.lookup_id !== "string" ||
    !LOOKUP_ID_RE.test(raw.lookup_id) ||
    typeof raw.kind !== "string" ||
    !KINDS.includes(raw.kind) ||
    typeof raw.query !== "string" ||
    raw.query.length > 100 ||
    !(raw.space === null || raw.space === undefined || (typeof raw.space === "string" && SPACE_KEY_RE.test(raw.space))) ||
    (raw.kind === "github_project" && !(typeof raw.owner === "string" && GITHUB_OWNER_RE.test(raw.owner)))
  ) {
    return null;
  }
  const kind = raw.kind as LookupKind;
  return {
    lookup_id: raw.lookup_id,
    kind,
    query: raw.query,
    space: kind === "confluence_page" ? ((raw.space as string | null | undefined) ?? null) : null,
    owner: kind === "github_project" ? (raw.owner as string) : null,
    // gh is signed in on every pod, so a GitHub search has no sign-in to ask for.
    sign_in: raw.sign_in === true && (kind === "jira_project" || kind === "confluence_page")
  };
}

/**
 * The words of a query, as letters and digits only. Nothing else can reach the CQL or the Jira query, so there is no
 * quoting to get right: a quote, a bracket or an `OR` typed into the box is a word separator or a word.
 */
export function searchWords(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS).map((word) => word.slice(0, MAX_WORD));
}

/**
 * A page id pasted as a link (`…/pages/123/Title`, `…?pageId=123`), or typed on its own, else null. A number on its own
 * counts only from six digits, so a year or a ticket number is still searched for as a word.
 */
export function pageIdOf(query: string): string | null {
  const trimmed = query.trim();
  const id =
    /\/pages\/(\d{1,20})(?:[/?#]|$)/.exec(trimmed)?.[1] ??
    /[?&]pageId=(\d{1,20})\b/.exec(trimmed)?.[1] ??
    (NUMERIC_ID_RE.test(trimmed) && trimmed.length >= 6 ? trimmed : null);
  return id ?? null;
}

/** The CQL for a Confluence lookup: that page, or pages whose titles have words starting with each word typed. */
export function confluenceCql(query: string, space: string | null): string | null {
  const id = pageIdOf(query);
  const scope = space === null ? "" : ` AND space = "${space}"`;
  if (id !== null) {
    return `type = page AND id = ${id}`;
  }
  const words = searchWords(query);
  if (words.length === 0) {
    return null;
  }
  return `type = page${scope} AND title ~ "${words.map((word) => `${word}*`).join(" ")}"`;
}

/** The `twg` arguments for a Jira or Confluence lookup's search, or null when there is nothing worth searching for. */
export function lookupArgs(frame: Pick<LookupFrame, "kind" | "query" | "space">): string[] | null {
  if (frame.kind === "jira_project") {
    const words = searchWords(frame.query);
    return words.length === 0 ? null : ["jira", "space", "query", `--query=${words.join(" ")}`, `--limit=${MAX_LOOKUP_RESULTS}`, ...JSON_OUTPUT];
  }
  const cql = confluenceCql(frame.query, frame.space);
  return cql === null ? null : ["confluence", "search", "query", `--cql=${cql}`, `--limit=${MAX_LOOKUP_RESULTS}`, ...JSON_OUTPUT];
}

/** The `twg` arguments that read the spaces a Confluence search found pages in, for the ids and names it does not give. */
export function spaceArgs(keys: string[]): string[] {
  return ["confluence", "space", "list", `--keys=${keys.join(",")}`, `--limit=${MAX_LOOKUP_RESULTS}`, ...JSON_OUTPUT];
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The `data` of a twg JSON answer, or undefined when the output is not one or is twg's `{ok: false, error}`. */
function twgData(stdout: string): unknown {
  try {
    const parsed = asRecord(JSON.parse(stdout));
    return parsed?.ok === false ? undefined : parsed?.data;
  } catch {
    return undefined;
  }
}

/** The projects in `twg jira space query`'s answer, as the hub accepts them. */
export function parseJiraProjects(stdout: string): JiraProjectFound[] | null {
  const projects = asRecord(twgData(stdout))?.projects;
  if (!Array.isArray(projects)) {
    return null;
  }
  const found: JiraProjectFound[] = [];
  for (const value of projects) {
    const raw = asRecord(value);
    const name = shortText(raw?.name, MAX_NAME);
    if (raw && typeof raw.key === "string" && PROJECT_RE.test(raw.key) && name !== null) {
      found.push({ key: raw.key, name });
    }
  }
  return found.slice(0, MAX_LOOKUP_RESULTS);
}

/**
 * HTML entities decoded: a search result's excerpt is escaped HTML (`&amp;`, `&quot;`, `&#39;`), and is shown as text.
 * Anything not an entity is left as it is.
 */
function unescapeHtml(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (entity, dec?: string, hex?: string, name?: string) => {
    const code = dec !== undefined ? Number(dec) : hex !== undefined ? Number.parseInt(hex, 16) : null;
    if (code !== null) {
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return named[(name as string).toLowerCase()] ?? entity;
  });
}

/**
 * The key of the space a search result's page is in, from the page's own space link or else the result's container,
 * or null when neither names one a lookup could narrow to.
 */
export function spaceKeyOf(result: unknown): string | null {
  const record = asRecord(result);
  const spacePath = asRecord(asRecord(record?.content)?._expandable)?.space;
  const spaceUrl = asRecord(record?.resultGlobalContainer)?.displayUrl;
  const key =
    (typeof spacePath === "string" ? /^\/rest\/api\/space\/([^/]+)$/.exec(spacePath)?.[1] : undefined) ??
    (typeof spaceUrl === "string" ? /^\/spaces\/([^/]+)$/.exec(spaceUrl)?.[1] : undefined);
  return key !== undefined && SPACE_KEY_RE.test(key) ? key : null;
}

/** A page `twg confluence search query` found: its space only by key, which is all the search gives of it. */
export type ConfluenceHit = { id: string; title: string; space_key: string; excerpt: string | null };

/**
 * The pages in `twg confluence search query`'s answer: anything not quite a page is left out. A search narrowed to one
 * space found pages in that space alone, so `space` is each page's when it is given.
 */
export function parseConfluenceHits(stdout: string, space: string | null = null): ConfluenceHit[] | null {
  const results = asRecord(twgData(stdout))?.results;
  if (!Array.isArray(results)) {
    return null;
  }
  const found: ConfluenceHit[] = [];
  for (const value of results) {
    const result = asRecord(value);
    const content = asRecord(result?.content);
    const title = shortText(content?.title, MAX_TITLE);
    const spaceKey = space ?? spaceKeyOf(result);
    if (content?.type !== "page" || typeof content.id !== "string" || !NUMERIC_ID_RE.test(content.id) || title === null || spaceKey === null) {
      continue;
    }
    const excerpt = typeof result?.excerpt === "string" ? shortText(unescapeHtml(result.excerpt), MAX_EXCERPT) : null;
    found.push({ id: content.id, title, space_key: spaceKey, excerpt });
  }
  return found.slice(0, MAX_LOOKUP_RESULTS);
}

/** A Confluence space as `twg confluence space list` gives it: its key as Confluence spells it, its id and its name. */
export type ConfluenceSpace = { key: string; id: string; name: string };

/**
 * The spaces already read, by lower-cased key, since Confluence matches a key whatever its case. Kept for the life of
 * the lookup runner: a space's id never changes, and a search in it is typed again and again.
 */
export type SpaceCache = Map<string, ConfluenceSpace>;

/** The spaces in `twg confluence space list`'s answer, by lower-cased key. */
export function parseConfluenceSpaces(stdout: string): SpaceCache | null {
  const spaces = twgData(stdout);
  if (!Array.isArray(spaces)) {
    return null;
  }
  const found: SpaceCache = new Map();
  for (const value of spaces) {
    const raw = asRecord(value);
    const id = typeof raw?.id === "number" ? String(raw.id) : raw?.id;
    const name = shortText(raw?.name, MAX_NAME);
    if (typeof raw?.key === "string" && SPACE_KEY_RE.test(raw.key) && typeof id === "string" && NUMERIC_ID_RE.test(id) && name !== null) {
      found.set(raw.key.toLowerCase(), { key: raw.key, id, name });
    }
  }
  return found;
}

/**
 * The pages a search found, as the hub accepts them, each with its space's id and name; a page in a space not read is
 * left out. No twg command gives a page's ancestors, so a page is placed by its space, and told from another of the
 * same title by its opening words.
 */
export function confluencePages(hits: ConfluenceHit[], spaces: SpaceCache): ConfluencePageFound[] {
  return hits.flatMap((hit) => {
    const space = spaces.get(hit.space_key.toLowerCase());
    if (!space) {
      return [];
    }
    const page: ConfluencePageFound = { id: hit.id, title: hit.title, space_id: space.id, space_key: space.key, space_name: space.name, ancestors: [] };
    return [hit.excerpt === null ? page : { ...page, excerpt: hit.excerpt }];
  });
}

/** Whether twg failed for want of a sign-in, which the person can fix, rather than for some other reason. */
export function twgSignedOut(result: RunResult): boolean {
  if (result.code === TWG_EXIT_AUTH) {
    return true;
  }
  try {
    const error = asRecord(asRecord(JSON.parse(result.stdout))?.error);
    // A sign-in twg still holds but Atlassian no longer accepts is the site's 401, which twg passes on as the error's.
    return error?.code === "AUTH_REQUIRED" || error?.statusCode === HTTP_UNAUTHORIZED;
  } catch {
    return false;
  }
}

/** Why a search failed, in one line the person can read. */
function failure(result: RunResult, kind: "jira_project" | "confluence_page"): string {
  const where = kind === "jira_project" ? "Jira" : "Confluence";
  if (result.code === 127) {
    return `twg is not installed in your assistant, so it cannot search ${where}.`;
  }
  let message: unknown;
  try {
    message = asRecord(asRecord(JSON.parse(result.stdout))?.error)?.message;
  } catch {}
  const why =
    typeof message === "string" && message.trim() !== "" ? `${where} could not search that: ${message.trim()}` : `${where} could not be searched just now.`;
  return why.length > MAX_DETAIL ? `${why.slice(0, MAX_DETAIL - 1)}…` : why;
}

const TOO_SLOW = "Confluence did not answer in time. Try again in a moment.";
const NO_SPACES = "Confluence found pages but did not say which spaces they are in, so none can be chosen.";

export type LookupDeps = {
  run: Run;
  env: Env;
  /** Signs twg in, relaying a device code to the owner; false when they did not finish. */
  login: () => Promise<boolean>;
  /** The GitHub accounts a repository search looks in; `githubOwners` unless a test says otherwise. */
  githubOwners?: () => Promise<string[] | null>;
  /** The Confluence spaces already read; a lookup reads only the ones it is missing, and adds them. */
  spaces?: SpaceCache;
};

/**
 * The pages of a Confluence search with their spaces' ids and names, reading in one `space list` only the spaces not
 * already known, and only when there is time left before `deadline`. A page whose space is not known is left out;
 * only when that leaves none is the lookup said to have failed, and why.
 */
async function withSpaces(deps: LookupDeps, hits: ConfluenceHit[], spaces: SpaceCache, deadline: number): Promise<LookupAnswer> {
  const missing = new Map<string, string>();
  for (const hit of hits) {
    const lower = hit.space_key.toLowerCase();
    if (!spaces.has(lower) && !missing.has(lower)) {
      missing.set(lower, hit.space_key);
    }
  }
  let unread: string | null = null;
  if (missing.size > 0) {
    const left = deadline - Date.now();
    if (left < MIN_SPACE_TIMEOUT_MS) {
      unread = TOO_SLOW;
    } else {
      const listed = await deps.run("twg", spaceArgs([...missing.values()]), { env: deps.env, timeoutMs: left });
      if (twgSignedOut(listed)) {
        return { error: "signed_out" };
      }
      const read = listed.code === 0 ? parseConfluenceSpaces(listed.stdout) : null;
      if (read === null) {
        unread = failure(listed, "confluence_page");
      } else {
        for (const [lower, space] of read) {
          spaces.set(lower, space);
        }
      }
    }
  }
  const pages = confluencePages(hits, spaces);
  return pages.length > 0 ? { results: pages } : { error: "failed", detail: unread ?? NO_SPACES };
}

/** Runs one lookup and answers it, signing in first when the person asked for that. Never throws. */
export async function runLookup(deps: LookupDeps, frame: LookupFrame): Promise<LookupAnswer> {
  if (frame.kind === "github_repo" || frame.kind === "github_project") {
    return await runGithubLookup(
      { run: deps.run, env: deps.env, owners: deps.githubOwners ?? githubOwners(deps.run, deps.env) },
      { ...frame, kind: frame.kind }
    );
  }
  if (frame.sign_in) {
    const whoami = await deps.run("twg", ["whoami"], { env: deps.env, timeoutMs: WHOAMI_TIMEOUT_MS });
    if (whoami.code !== 0 && !(await deps.login().catch(() => false))) {
      return { error: "signed_out" };
    }
  }
  const args = lookupArgs(frame);
  if (args === null) {
    return { results: [] };
  }
  const kind = frame.kind;
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const result = await deps.run("twg", args, { env: deps.env, timeoutMs: SEARCH_BUDGET_MS });
  if (twgSignedOut(result)) {
    return { error: "signed_out" };
  }
  if (kind === "jira_project") {
    const projects = result.code === 0 ? parseJiraProjects(result.stdout) : null;
    return projects !== null ? { results: projects } : { error: "failed", detail: failure(result, kind) };
  }
  // A page looked up by its id is found wherever it is, so only a search by title is in the frame's space.
  const narrowedTo = pageIdOf(frame.query) === null ? frame.space : null;
  const hits = result.code === 0 ? parseConfluenceHits(result.stdout, narrowedTo) : null;
  if (hits === null) {
    return { error: "failed", detail: failure(result, kind) };
  }
  if (hits.length === 0) {
    return { results: [] };
  }
  return await withSpaces(deps, hits, deps.spaces ?? new Map(), deadline);
}

export type LookupRunnerOptions = LookupDeps & {
  api: Pick<Api, "putLookup">;
  id: string;
  say?: (message: string) => void;
  max?: number;
};

export type LookupRunner = {
  /** Takes a `lookup` frame's data and runs it as soon as there is room. */
  lookup: (data: unknown) => void;
  /** Resolves once nothing is running or waiting; for a test, and for the supervisor's shutdown. */
  idle: () => Promise<void>;
};

/**
 * Runs lookups beside the supervisor's own work rather than behind it: a wake waiting on a slow search, or a search on
 * a wake, would be felt by somebody either way. At most `max` run at once, and while one of a kind waits for room a
 * newer one of that kind replaces it, since the person has typed on; the replaced one is answered `superseded`. One
 * sign-in at a time, shared by every lookup that asks for it, and one read of each Confluence space, as of the GitHub
 * accounts.
 */
export function createLookupRunner({ api, id, say = () => {}, max = MAX_RUNNING_LOOKUPS, ...deps }: LookupRunnerOptions): LookupRunner {
  const waiting: LookupFrame[] = [];
  const running = new Set<Promise<void>>();
  let signingIn: Promise<boolean> | null = null;
  const owners = deps.githubOwners ?? githubOwners(deps.run, deps.env);
  const spaces: SpaceCache = deps.spaces ?? new Map();
  const login = () => {
    signingIn ??= deps.login().finally(() => {
      signingIn = null;
    });
    return signingIn;
  };

  async function answer(frame: LookupFrame, body: LookupAnswer): Promise<void> {
    try {
      await withRetry(() => api.putLookup(id, frame.lookup_id, body), { attempts: 2 });
    } catch (e) {
      say(`lookup ${frame.lookup_id}: could not answer it: ${(e as Error).message}`);
    }
  }

  function pump(): void {
    while (running.size < max && waiting.length > 0) {
      const frame = waiting.shift() as LookupFrame;
      const job = runLookup({ ...deps, login, githubOwners: owners, spaces }, frame)
        .catch((e) => ({ error: "failed" as const, detail: `The search did not work: ${(e as Error).message}`.slice(0, MAX_DETAIL) }))
        .then((body) => answer(frame, body))
        .finally(() => {
          running.delete(job);
          pump();
        });
      running.add(job);
    }
  }

  return {
    lookup(data) {
      const frame = parseLookupFrame(data);
      if (!frame) {
        say(`ignoring a lookup that is not one: ${JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      const older = waiting.findIndex((queued) => queued.kind === frame.kind && !queued.sign_in);
      if (older !== -1 && !frame.sign_in) {
        const [replaced] = waiting.splice(older, 1);
        void answer(replaced as LookupFrame, { error: "superseded" });
      }
      waiting.push(frame);
      pump();
    },
    async idle() {
      while (running.size > 0 || waiting.length > 0) {
        await Promise.all([...running]);
      }
    }
  };
}
