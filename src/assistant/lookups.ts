import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE, GITHUB_SITE_URL } from "./github.ts";
import { JIRA_SITE_URL } from "./jira.ts";

/**
 * Searching the person's own Jira, Confluence or GitHub as them, for the document panel and the settings to pick where
 * a document goes: the kinds, the limits, what the pod may answer, and what the browser is shown. Pure. The hub holds
 * no Atlassian or GitHub credentials, so the search runs in the person's pod with their `twg` or `gh` sign-in;
 * `lookup-store.ts` records the question and waits for the answer. See "Atlassian lookups" in docs/agent-api.md.
 *
 * A GitHub repository is where an issue lives, and a GitHub Project is a board showing issues from any number of
 * repositories, so they are two kinds: a repository is searched for in the person's own account and organisations,
 * and a Project in the owner of the repository chosen.
 */

const LOOKUP_KINDS = ["jira_project", "confluence_page", "github_repo", "github_project"] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export const MAX_LOOKUP_QUERY = 100;
/** Fewer letters or digits than this is not yet a search: it would match half of Confluence. */
const MIN_LOOKUP_CHARS = 2;
export const MAX_LOOKUP_RESULTS = 10;
export const MAX_LOOKUP_ANCESTORS = 8;
const MAX_LOOKUP_DETAIL = 300;
/** How long the browser's request waits for the pod. A search that takes longer is not one anybody is still typing for. */
export const LOOKUP_WAIT_MS = 10_000;
/** How long a lookup's row is kept; long enough to be answered, and nothing reads it after. */
export const LOOKUP_RETENTION_MS = 10 * 60_000;
export const LOOKUP_RATE_WINDOW_MS = 60_000;
export const LOOKUP_RATE_LIMIT = 30;

const CONFLUENCE_SITE_URL = `${JIRA_SITE_URL}/wiki`;

export const JIRA_PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
/** A Confluence space key: letters, digits and `_-`, with `~` in front of a personal space's. */
export const SPACE_KEY_RE = /^~?[A-Za-z0-9_-]{1,100}$/;
export const NUMERIC_ID_RE = /^[0-9]{1,20}$/;

/** Whether a kind is searched in GitHub, with gh, rather than in Atlassian with twg. */
export function isGithubKind(kind: LookupKind): kind is "github_repo" | "github_project" {
  return kind === "github_repo" || kind === "github_project";
}

export function isLookupKind(value: unknown): value is LookupKind {
  return typeof value === "string" && (LOOKUP_KINDS as readonly string[]).includes(value);
}

/** The query as it is stored and sent: trimmed, its runs of spaces made one, and cut to the limit. */
export function lookupQuery(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, MAX_LOOKUP_QUERY);
}

/**
 * Whether a query is worth sending to the pod at all: at least `MIN_LOOKUP_CHARS` letters or digits, or for a GitHub
 * Project a number of any length, since `#7` names one board outright.
 */
export function searchable(query: string, kind?: LookupKind): boolean {
  if (kind === "github_project" && /^#?[1-9]\d{0,8}$/.test(query.trim())) {
    return true;
  }
  return (query.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_LOOKUP_CHARS;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** One Jira project, as the pod answers it. */
const jiraProjectAnswer = z.strictObject({ key: z.string().regex(JIRA_PROJECT_RE), name: text(200) });

/** One Confluence page, as the pod answers it: the ids an export needs and the titles that say where it is. */
const confluencePageAnswer = z.strictObject({
  id: z.string().regex(NUMERIC_ID_RE),
  title: text(255),
  space_id: z.string().regex(NUMERIC_ID_RE),
  space_key: z.string().regex(SPACE_KEY_RE),
  space_name: text(200),
  ancestors: boundedArray(text(255), MAX_LOOKUP_ANCESTORS)
});

/** One GitHub repository, as the pod answers it. */
const githubRepoAnswer = z.strictObject({ full_name: z.string().regex(GITHUB_REPO_RE), description: text(300).nullable() });

/** One GitHub Project, as the pod answers it: the owner and number an issue is added to it by, and its title. */
const githubProjectAnswer = z.strictObject({ owner: z.string().regex(GITHUB_OWNER_RE), number: z.number().int().min(1).max(999_999_999), title: text(200) });

export type JiraProjectAnswer = z.infer<typeof jiraProjectAnswer>;
export type ConfluencePageAnswer = z.infer<typeof confluencePageAnswer>;
export type GithubRepoAnswer = z.infer<typeof githubRepoAnswer>;
export type GithubProjectAnswer = z.infer<typeof githubProjectAnswer>;
type AnyAnswer = JiraProjectAnswer[] | ConfluencePageAnswer[] | GithubRepoAnswer[] | GithubProjectAnswer[];

const ANSWERS = {
  jira_project: jiraProjectAnswer,
  confluence_page: confluencePageAnswer,
  github_repo: githubRepoAnswer,
  github_project: githubProjectAnswer
} as const;

/** What a kind's results are called, for a refusal of the wrong ones and for the search's own words. */
export const LOOKUP_NOUNS: Record<LookupKind, { one: string; many: string; where: string }> = {
  jira_project: { one: "project", many: "projects", where: "Jira" },
  confluence_page: { one: "page", many: "pages", where: "Confluence" },
  github_repo: { one: "repository", many: "repositories", where: "GitHub" },
  github_project: { one: "Project", many: "Projects", where: "GitHub" }
};

/** The pod's answer to one lookup: what it found, or why it found nothing. */
export const lookupAnswerBody = z.union([
  z.strictObject({ results: boundedArray(z.unknown(), MAX_LOOKUP_RESULTS) }),
  z.strictObject({ error: z.enum(["signed_out", "failed", "superseded"]), detail: z.string().trim().max(MAX_LOOKUP_DETAIL).optional() })
]);

export type LookupAnswer = z.infer<typeof lookupAnswerBody>;

/**
 * The results checked against the lookup's own kind, which the body schema cannot know. All of them or none: a pod
 * answering a Confluence search with something else is broken, and half an answer would hide that.
 */
export function checkResults(kind: LookupKind, results: readonly unknown[]): AnyAnswer | undefined {
  const parsed = boundedArray(ANSWERS[kind] as z.ZodType, MAX_LOOKUP_RESULTS).safeParse(results);
  return parsed.success ? (parsed.data as AnyAnswer) : undefined;
}

export interface JiraProjectResult {
  key: string;
  name: string;
  url: string;
}

export interface ConfluencePageResult {
  id: string;
  title: string;
  space_id: string;
  space_key: string;
  space_name: string;
  ancestors: string[];
  url: string;
}

export interface GithubRepoResult {
  full_name: string;
  description: string | null;
  url: string;
}

/** No link: a Project's address depends on whether its owner is an organisation or a user, which the answer leaves out. */
export interface GithubProjectResult {
  owner: string;
  number: number;
  title: string;
}

export type LookupResult = JiraProjectResult | ConfluencePageResult | GithubRepoResult | GithubProjectResult;

function jiraProjectUrl(key: string): string {
  return `${JIRA_SITE_URL}/browse/${encodeURIComponent(key)}`;
}

export function confluencePageUrl(spaceKey: string, pageId: string): string {
  return `${CONFLUENCE_SITE_URL}/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}`;
}

/** What the browser is shown of stored results: the pod's own fields, and a link the hub builds from the ids. */
export function lookupResults(kind: LookupKind, stored: unknown): LookupResult[] {
  const results = Array.isArray(stored) ? checkResults(kind, stored) : undefined;
  if (results === undefined) {
    return [];
  }
  switch (kind) {
    case "jira_project":
      return (results as JiraProjectAnswer[]).map((project) => ({ ...project, url: jiraProjectUrl(project.key) }));
    case "confluence_page":
      return (results as ConfluencePageAnswer[]).map((page) => ({ ...page, url: confluencePageUrl(page.space_key, page.id) }));
    case "github_repo":
      return (results as GithubRepoAnswer[]).map((repo) => ({ ...repo, url: `${GITHUB_SITE_URL}/${repo.full_name}` }));
    case "github_project":
      return results as GithubProjectAnswer[];
  }
}

/** What the browser is answered: see "Atlassian lookups" in docs/agent-api.md. */
export type LookupResponse =
  | { status: "done"; results: LookupResult[] }
  | { status: "waking" }
  | { status: "unsupported" }
  | { status: "signed_out" }
  | { status: "signing_in" }
  | { status: "failed"; detail: string }
  | { status: "timeout" };

/** A stored lookup as the browser's request reads it back. */
export interface LookupRow {
  kind: string;
  status: string;
  results: unknown;
  error: string | null;
  detail: string | null;
}

/** The answer a stored lookup gives, or `undefined` while it is unanswered. */
export function lookupResponse(row: LookupRow): LookupResponse | undefined {
  if (row.status === "pending") {
    return undefined;
  }
  if (row.status === "done" && isLookupKind(row.kind)) {
    return { status: "done", results: lookupResults(row.kind, row.results) };
  }
  if (row.error === "signed_out") {
    return { status: "signed_out" };
  }
  if (row.error === "superseded") {
    // The person has typed on, and the newer search is the one they are waiting for.
    return { status: "done", results: [] };
  }
  return { status: "failed", detail: row.detail ?? "The search did not work. Try again." };
}

/** The breadcrumb a page is shown with: its space, the pages above it, and itself. */
export function breadcrumb(page: Pick<ConfluencePageResult, "space_name" | "ancestors" | "title">): string[] {
  // A space's top page is usually titled after the space, which would say the same thing twice.
  const above = page.ancestors[0] === page.space_name ? page.ancestors.slice(1) : page.ancestors;
  return [page.space_name, ...above, page.title];
}
