import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";
import { JIRA_SITE_URL } from "./jira.ts";

/**
 * Searching the person's own Jira or Confluence as them, for the document panel and the settings to pick where a
 * document goes: the kinds, the limits, what the pod may answer, and what the browser is shown. Pure. The hub holds no
 * Atlassian credentials, so the search runs in the person's pod with their `twg` sign-in; `lookup-store.ts` records
 * the question and waits for the answer. See "Atlassian lookups" in docs/agent-api.md.
 */

export const LOOKUP_KINDS = ["jira_project", "confluence_page"] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export const MAX_LOOKUP_QUERY = 100;
/** Fewer letters or digits than this is not yet a search: it would match half of Confluence. */
export const MIN_LOOKUP_CHARS = 2;
export const MAX_LOOKUP_RESULTS = 10;
export const MAX_LOOKUP_ANCESTORS = 8;
export const MAX_LOOKUP_DETAIL = 300;
/** How long the browser's request waits for the pod. A search that takes longer is not one anybody is still typing for. */
export const LOOKUP_WAIT_MS = 10_000;
/** How long a lookup's row is kept; long enough to be answered, and nothing reads it after. */
export const LOOKUP_RETENTION_MS = 10 * 60_000;
export const LOOKUP_RATE_WINDOW_MS = 60_000;
export const LOOKUP_RATE_LIMIT = 30;

export const CONFLUENCE_SITE_URL = `${JIRA_SITE_URL}/wiki`;

export const JIRA_PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
/** A Confluence space key: letters, digits and `_-`, with `~` in front of a personal space's. */
export const SPACE_KEY_RE = /^~?[A-Za-z0-9_-]{1,100}$/;
export const NUMERIC_ID_RE = /^[0-9]{1,20}$/;

export function isLookupKind(value: unknown): value is LookupKind {
  return typeof value === "string" && (LOOKUP_KINDS as readonly string[]).includes(value);
}

/** The query as it is stored and sent: trimmed, its runs of spaces made one, and cut to the limit. */
export function lookupQuery(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, MAX_LOOKUP_QUERY);
}

/** Whether a query is worth sending to the pod at all: at least `MIN_LOOKUP_CHARS` letters or digits. */
export function searchable(query: string): boolean {
  return (query.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_LOOKUP_CHARS;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** One Jira project, as the pod answers it. */
export const jiraProjectAnswer = z.strictObject({ key: z.string().regex(JIRA_PROJECT_RE), name: text(200) });

/** One Confluence page, as the pod answers it: the ids an export needs and the titles that say where it is. */
export const confluencePageAnswer = z.strictObject({
  id: z.string().regex(NUMERIC_ID_RE),
  title: text(255),
  space_id: z.string().regex(NUMERIC_ID_RE),
  space_key: z.string().regex(SPACE_KEY_RE),
  space_name: text(200),
  ancestors: boundedArray(text(255), MAX_LOOKUP_ANCESTORS)
});

export type JiraProjectAnswer = z.infer<typeof jiraProjectAnswer>;
export type ConfluencePageAnswer = z.infer<typeof confluencePageAnswer>;

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
export function checkResults(kind: LookupKind, results: readonly unknown[]): JiraProjectAnswer[] | ConfluencePageAnswer[] | undefined {
  const parsed = (
    kind === "jira_project" ? boundedArray(jiraProjectAnswer, MAX_LOOKUP_RESULTS) : boundedArray(confluencePageAnswer, MAX_LOOKUP_RESULTS)
  ).safeParse(results);
  return parsed.success ? (parsed.data as JiraProjectAnswer[] | ConfluencePageAnswer[]) : undefined;
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

export type LookupResult = JiraProjectResult | ConfluencePageResult;

export function jiraProjectUrl(key: string): string {
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
  return kind === "jira_project"
    ? (results as JiraProjectAnswer[]).map((project) => ({ ...project, url: jiraProjectUrl(project.key) }))
    : (results as ConfluencePageAnswer[]).map((page) => ({ ...page, url: confluencePageUrl(page.space_key, page.id) }));
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
