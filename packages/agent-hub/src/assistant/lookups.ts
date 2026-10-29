// The supervisor's half of an Atlassian lookup: a search of the owner's Jira or Confluence, run with their own twg
// sign-in, for the HMCTS Assistant's document panel and settings to pick where a document goes. Fixed and read-only:
// one `twg api` GET whose every value is checked and passed as its own argument, never through a shell, and an answer
// cut down to the fields the hub accepts. See "Atlassian lookups" in dtsse-agent-hub's docs/agent-api.md.
import type { Api, ConfluencePageFound, JiraProjectFound, LookupAnswer } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";

export type LookupKind = "jira_project" | "confluence_page";

/** A lookup as the sessions stream sends it, once every value has been checked. */
export type LookupFrame = {
  lookup_id: string;
  kind: LookupKind;
  query: string;
  space: string | null;
  sign_in: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;

export const MAX_LOOKUP_RESULTS = 10;
export const MAX_ANCESTORS = 8;
/** At most two twg searches at once: the pod is also running the person's sessions, and typing makes many. */
export const MAX_RUNNING_LOOKUPS = 2;
// The hub stops waiting after 10 seconds; a search still running past this is one nobody is waiting for.
const SEARCH_TIMEOUT_MS = 12000;
const WHOAMI_TIMEOUT_MS = 30000;
const MAX_WORDS = 6;
const MAX_WORD = 40;
const MAX_TITLE = 255;
const MAX_NAME = 200;
const MAX_DETAIL = 300;
// What twg 1.3.3 exits with when it has no usable sign-in.
const TWG_EXIT_AUTH = 77;

const LOOKUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPACE_KEY_RE = /^~?[A-Za-z0-9_-]{1,100}$/;
const NUMERIC_ID_RE = /^[0-9]{1,20}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;

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
    (raw.kind !== "jira_project" && raw.kind !== "confluence_page") ||
    typeof raw.query !== "string" ||
    raw.query.length > 100 ||
    !(raw.space === null || raw.space === undefined || (typeof raw.space === "string" && SPACE_KEY_RE.test(raw.space)))
  ) {
    return null;
  }
  return {
    lookup_id: raw.lookup_id,
    kind: raw.kind,
    query: raw.query,
    space: raw.kind === "confluence_page" ? ((raw.space as string | null | undefined) ?? null) : null,
    sign_in: raw.sign_in === true
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

/** The `twg` arguments for a lookup, or null when there is nothing worth searching for. */
export function lookupArgs(frame: Pick<LookupFrame, "kind" | "query" | "space">): string[] | null {
  const tail = ["-o", "json", "--output-summary=none"];
  if (frame.kind === "jira_project") {
    const words = searchWords(frame.query);
    return words.length === 0
      ? null
      : ["api", "jira:/rest/api/3/project/search", "-X", "GET", "-f", `query=${words.join(" ")}`, "-f", `maxResults=${MAX_LOOKUP_RESULTS}`, ...tail];
  }
  const cql = confluenceCql(frame.query, frame.space);
  return cql === null
    ? null
    : [
        "api",
        "confluence:/wiki/rest/api/search",
        "-X",
        "GET",
        "-f",
        `cql=${cql}`,
        "-f",
        `limit=${MAX_LOOKUP_RESULTS}`,
        "-f",
        "expand=content.ancestors,content.space",
        ...tail
      ];
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The body of a `twg api` answer and its HTTP status, or null when the output is not one. */
function apiBody(stdout: string): { status: number; body: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const data = asRecord(asRecord(parsed)?.data);
  const body = asRecord(data?.body);
  return data && body && typeof data.status === "number" ? { status: data.status, body } : null;
}

/** The projects in Jira's `project/search` answer, as the hub accepts them. */
export function parseJiraProjects(stdout: string): JiraProjectFound[] | null {
  const answer = apiBody(stdout);
  if (answer?.status !== 200 || !Array.isArray(answer.body.values)) {
    return null;
  }
  const found: JiraProjectFound[] = [];
  for (const value of answer.body.values) {
    const raw = asRecord(value);
    const name = shortText(raw?.name, MAX_NAME);
    if (raw && typeof raw.key === "string" && PROJECT_RE.test(raw.key) && name !== null) {
      found.push({ key: raw.key, name });
    }
  }
  return found.slice(0, MAX_LOOKUP_RESULTS);
}

/** The pages in Confluence's `search` answer, as the hub accepts them: anything not quite a page is left out. */
export function parseConfluencePages(stdout: string): ConfluencePageFound[] | null {
  const answer = apiBody(stdout);
  if (answer?.status !== 200 || !Array.isArray(answer.body.results)) {
    return null;
  }
  const found: ConfluencePageFound[] = [];
  for (const value of answer.body.results) {
    const content = asRecord(asRecord(value)?.content);
    const space = asRecord(content?.space);
    const title = shortText(content?.title, MAX_TITLE);
    const spaceName = shortText(space?.name, MAX_NAME);
    const spaceId = typeof space?.id === "number" ? String(space.id) : space?.id;
    if (
      content?.type !== "page" ||
      typeof content.id !== "string" ||
      !NUMERIC_ID_RE.test(content.id) ||
      title === null ||
      typeof spaceId !== "string" ||
      !NUMERIC_ID_RE.test(spaceId) ||
      typeof space?.key !== "string" ||
      !SPACE_KEY_RE.test(space.key) ||
      spaceName === null
    ) {
      continue;
    }
    const ancestors = (Array.isArray(content.ancestors) ? content.ancestors : [])
      .map((ancestor) => shortText(asRecord(ancestor)?.title, MAX_TITLE))
      .filter((ancestor): ancestor is string => ancestor !== null)
      .slice(-MAX_ANCESTORS);
    found.push({ id: content.id, title, space_id: spaceId, space_key: space.key, space_name: spaceName, ancestors });
  }
  return found.slice(0, MAX_LOOKUP_RESULTS);
}

/** Whether twg failed for want of a sign-in, which the person can fix, rather than for some other reason. */
export function twgSignedOut(result: RunResult): boolean {
  if (result.code === TWG_EXIT_AUTH) {
    return true;
  }
  try {
    const parsed = asRecord(JSON.parse(result.stdout));
    const error = asRecord(parsed?.error);
    return error?.code === "AUTH_REQUIRED" || asRecord(parsed?.data)?.status === 401;
  } catch {
    return false;
  }
}

/** Why a search failed, in one line the person can read. */
function failure(result: RunResult, kind: LookupKind): string {
  const where = kind === "jira_project" ? "Jira" : "Confluence";
  if (result.code === 127) {
    return `twg is not installed in your assistant, so it cannot search ${where}.`;
  }
  let message: unknown;
  try {
    const parsed = asRecord(JSON.parse(result.stdout));
    message = asRecord(parsed?.error)?.message ?? asRecord(asRecord(parsed?.data)?.body)?.message;
  } catch {}
  const why =
    typeof message === "string" && message.trim() !== "" ? `${where} could not search that: ${message.trim()}` : `${where} could not be searched just now.`;
  return why.length > MAX_DETAIL ? `${why.slice(0, MAX_DETAIL - 1)}…` : why;
}

export type LookupDeps = {
  run: Run;
  env: Env;
  /** Signs twg in, relaying a device code to the owner; false when they did not finish. */
  login: () => Promise<boolean>;
};

/** Runs one lookup and answers it, signing in first when the person asked for that. Never throws. */
export async function runLookup(deps: LookupDeps, frame: LookupFrame): Promise<LookupAnswer> {
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
  const result = await deps.run("twg", args, { env: deps.env, timeoutMs: SEARCH_TIMEOUT_MS });
  if (twgSignedOut(result)) {
    return { error: "signed_out" };
  }
  const results = frame.kind === "jira_project" ? parseJiraProjects(result.stdout) : parseConfluencePages(result.stdout);
  return result.code === 0 && results !== null ? { results } : { error: "failed", detail: failure(result, frame.kind) };
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
 * sign-in at a time, shared by every lookup that asks for it.
 */
export function createLookupRunner({ api, id, say = () => {}, max = MAX_RUNNING_LOOKUPS, ...deps }: LookupRunnerOptions): LookupRunner {
  const waiting: LookupFrame[] = [];
  const running = new Set<Promise<void>>();
  let signingIn: Promise<boolean> | null = null;
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
      const job = runLookup({ ...deps, login }, frame)
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
