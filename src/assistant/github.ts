import { TICKET_LABELS } from "./jira.ts";

/**
 * Exporting a conversation's document to a GitHub repository as an issue, once, for a person whose ticket tool is
 * GitHub: what the panel shows, and what the conversation's session is told while an export is pending. It mirrors
 * the Jira export (`jira.ts`): the session creates the issue with `gh` and its owner's own GitHub token, so they are
 * its author, and reports the number back; the hub only records what was asked for and what came of it
 * (`github-store.ts`). See "GitHub export" under Conversations in docs/agent-api.md.
 *
 * An issue lives in a repository. A GitHub Project is a board that shows issues from any number of repositories, so
 * it is a second, optional choice: when the person picks one, the session adds the issue to it once it exists.
 */
export const GITHUB_SITE_URL = "https://github.com";

/**
 * A repository as `owner/name`. GitHub's own rules, near enough: an owner of 1–39 letters, digits and hyphens that
 * does not start with a hyphen, and a name of letters, digits, `.`, `_` and `-` that does not start with a dot, so
 * neither `.` nor `..` can be a name. The migration checks the same.
 */
export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Where a person's tickets go: their own Jira, or a GitHub repository's issues. */
export const TICKET_TOOLS = ["jira", "github"] as const;

export type TicketTool = (typeof TICKET_TOOLS)[number];

export const DEFAULT_TICKET_TOOL: TicketTool = "jira";

export function isTicketTool(value: unknown): value is TicketTool {
  return typeof value === "string" && (TICKET_TOOLS as readonly string[]).includes(value);
}

/** The same 15 minutes as Jira's: long enough for a stopped assistant to start. */
export const GITHUB_EXPORT_TIMEOUT_MS = 15 * 60_000;

/** A GitHub user or organisation login: the owner of a repository or of a Project. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** A Project as the person picked it: the owner and number gh names it by, and the title they found it by. */
export interface GithubProjectChoice {
  owner: string;
  number: number;
  title: string;
}

const MAX_PROJECT_TITLE = 200;

/** A Project as the browser sent it, or `undefined` when it is not one; `null` is none. */
export function readGithubProject(value: unknown): GithubProjectChoice | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = typeof value === "object" ? (value as Record<string, unknown>) : {};
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  if (
    typeof raw.owner !== "string" ||
    !GITHUB_OWNER_RE.test(raw.owner) ||
    !Number.isInteger(raw.number) ||
    (raw.number as number) < 1 ||
    (raw.number as number) > 999_999_999 ||
    title === "" ||
    title.length > MAX_PROJECT_TITLE
  ) {
    return undefined;
  }
  return { owner: raw.owner, number: raw.number as number, title };
}

/** The owner half of `owner/name`, whose Projects are the ones offered for an issue in that repository. */
export function repoOwner(repo: string): string {
  return repo.slice(0, repo.indexOf("/"));
}

export function isGithubRepo(value: unknown): value is string {
  return typeof value === "string" && GITHUB_REPO_RE.test(value);
}

/**
 * A repository as the person typed it, or `undefined` when it is not one: surrounding space dropped, and a pasted
 * `https://github.com/owner/name` link, with or without `.git` or a trailing slash, read as `owner/name`.
 */
export function readGithubRepo(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return isGithubRepo(trimmed) ? trimmed : undefined;
}

export function githubIssueUrl(repo: string, number: number): string {
  // `GITHUB_REPO_RE` lets through nothing a URL path would read differently, so the repository goes in as it stands.
  return `${GITHUB_SITE_URL}/${repo}/issues/${number}`;
}

export interface GithubExportRow {
  githubExportId: string | null;
  githubRepo: string | null;
  githubStatus: string | null;
  githubNumber: number | null;
  githubError: string | null;
  githubRequestedAt: Date | null;
  /** Absent from a row read before Projects could be chosen, which has none. */
  githubProjectOwner?: string | null;
  githubProjectNumber?: number | null;
  githubProjectTitle?: string | null;
  githubProjectError?: string | null;
}

export const GITHUB_SELECT = {
  githubExportId: true,
  githubRepo: true,
  githubStatus: true,
  githubNumber: true,
  githubError: true,
  githubRequestedAt: true,
  githubProjectOwner: true,
  githubProjectNumber: true,
  githubProjectTitle: true,
  githubProjectError: true
} as const;

function projectOf(row: GithubExportRow): GithubProjectChoice | null {
  return row.githubProjectOwner && row.githubProjectNumber && row.githubProjectTitle
    ? { owner: row.githubProjectOwner, number: row.githubProjectNumber, title: row.githubProjectTitle }
    : null;
}

/**
 * What the document panel shows of the conversation's GitHub export. A done export says when the issue could not be
 * added to the Project asked for: the issue stands, and the person can add it to the board themselves.
 */
export type GithubExportView =
  | { status: "none" }
  | { status: "pending"; repo: string; project: GithubProjectChoice | null; requestedAt: string }
  | { status: "done"; repo: string; number: number; url: string; project: GithubProjectChoice | null; projectError: string | null }
  | { status: "failed"; repo: string | null; project: GithubProjectChoice | null; error: string };

const TIMED_OUT = "GitHub did not answer in time. Try again.";

function expired(requestedAt: Date | null, now: Date): boolean {
  return requestedAt === null || now.getTime() - requestedAt.getTime() > GITHUB_EXPORT_TIMEOUT_MS;
}

export function githubExportView(row: GithubExportRow, now: Date = new Date()): GithubExportView {
  const project = projectOf(row);
  if (row.githubNumber !== null && row.githubRepo !== null) {
    return {
      status: "done",
      repo: row.githubRepo,
      number: row.githubNumber,
      url: githubIssueUrl(row.githubRepo, row.githubNumber),
      project,
      projectError: project === null ? null : (row.githubProjectError ?? null)
    };
  }
  if (row.githubStatus === "pending" && row.githubRepo !== null) {
    // `expired` covers a null `githubRequestedAt`, so a pending export always has one to report.
    return expired(row.githubRequestedAt, now)
      ? { status: "failed", repo: row.githubRepo, project, error: TIMED_OUT }
      : { status: "pending", repo: row.githubRepo, project, requestedAt: (row.githubRequestedAt as Date).toISOString() };
  }
  if (row.githubStatus === "failed") {
    return { status: "failed", repo: row.githubRepo, project, error: row.githubError ?? "The issue could not be created." };
  }
  return { status: "none" };
}

/** What a direct frame to the conversation's session carries while an export is pending. */
export interface GithubExportFrame {
  export_id: string;
  repo: string;
  /** What the issue is labelled, as the Jira ticket is; the session creates a label the repository does not have. */
  labels: string[];
  /** The Project to add the issue to once it exists; left out when the person chose none. */
  project?: { owner: string; number: number };
}

/** The conversation's pending export, for its session's next message; none once reported or timed out. */
export function pendingGithubExport(row: GithubExportRow, now: Date = new Date()): GithubExportFrame | undefined {
  const requestedAt = row.githubRequestedAt?.getTime();
  if (
    row.githubStatus !== "pending" ||
    row.githubNumber !== null ||
    row.githubExportId === null ||
    row.githubRepo === null ||
    requestedAt === undefined ||
    now.getTime() - requestedAt > GITHUB_EXPORT_TIMEOUT_MS
  ) {
    return undefined;
  }
  const project = projectOf(row);
  const frame = { export_id: row.githubExportId, repo: row.githubRepo, labels: [...TICKET_LABELS] };
  return project === null ? frame : { ...frame, project: { owner: project.owner, number: project.number } };
}
