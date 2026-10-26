/**
 * Exporting a conversation's document to a Jira backlog, once: the boards on offer, what the panel shows, and what
 * the conversation's session is told while an export is pending. The session creates the issue with `twg` and its
 * owner's sign-in, so they are its reporter, and reports the key back; the hub only records what was asked for and
 * what came of it (`jira-store.ts`). See "Jira export" under Conversations in docs/agent-api.md.
 */
export const JIRA_SITE_URL = "https://hmcts.atlassian.net";

export interface JiraBoard {
  project: string;
  board: number;
  label: string;
}

/** The backlogs a document can go to. A project has one backlog, whichever of its boards shows it. */
export const JIRA_BOARDS: readonly JiraBoard[] = [{ project: "VIBE", board: 720, label: "VIBE · Team board" }];

export const DEFAULT_JIRA_PROJECT = "VIBE";
export const JIRA_ISSUE_TYPE = "Story";
export const JIRA_LABELS: readonly string[] = ["hmcts-assistant"];

/** Long enough for a stopped assistant to start and its owner to sign in to Atlassian on the way. */
export const JIRA_EXPORT_TIMEOUT_MS = 15 * 60_000;

export function isJiraProject(value: unknown): value is string {
  return typeof value === "string" && JIRA_BOARDS.some((board) => board.project === value);
}

export function jiraIssueUrl(key: string): string {
  return `${JIRA_SITE_URL}/browse/${encodeURIComponent(key)}`;
}

export interface JiraExportRow {
  jiraExportId: string | null;
  jiraProject: string | null;
  jiraStatus: string | null;
  jiraKey: string | null;
  jiraError: string | null;
  jiraRequestedAt: Date | null;
}

export const JIRA_SELECT = {
  jiraExportId: true,
  jiraProject: true,
  jiraStatus: true,
  jiraKey: true,
  jiraError: true,
  jiraRequestedAt: true
} as const;

/**
 * What the document panel shows of the conversation's export. A pending one carries when it was asked for, so the
 * panel can tell a sign-in this export is waiting on from one an earlier export already gave up on.
 */
export type JiraExportView =
  | { status: "none" }
  | { status: "pending"; project: string; requestedAt: string }
  | { status: "done"; project: string; key: string; url: string }
  | { status: "failed"; project: string | null; error: string };

const TIMED_OUT = "Jira did not answer in time. Try again.";

function expired(requestedAt: Date | null, now: Date): boolean {
  return requestedAt === null || now.getTime() - requestedAt.getTime() > JIRA_EXPORT_TIMEOUT_MS;
}

export function jiraExportView(row: JiraExportRow, now: Date = new Date()): JiraExportView {
  if (row.jiraKey !== null) {
    const project = row.jiraProject ?? row.jiraKey.slice(0, row.jiraKey.indexOf("-"));
    return { status: "done", project, key: row.jiraKey, url: jiraIssueUrl(row.jiraKey) };
  }
  if (row.jiraStatus === "pending" && row.jiraProject !== null) {
    // `expired` covers a null `jiraRequestedAt`, so a pending export always has one to report.
    return expired(row.jiraRequestedAt, now)
      ? { status: "failed", project: row.jiraProject, error: TIMED_OUT }
      : { status: "pending", project: row.jiraProject, requestedAt: (row.jiraRequestedAt as Date).toISOString() };
  }
  if (row.jiraStatus === "failed") {
    return { status: "failed", project: row.jiraProject, error: row.jiraError ?? "The ticket could not be created." };
  }
  return { status: "none" };
}
/** What a direct frame to the conversation's session carries while an export is pending: what to create, and the id to report it under. */
export interface JiraExportFrame {
  export_id: string;
  project: string;
  issue_type: string;
  labels: string[];
}

/** The conversation's pending export, for its session's next message; none once reported or timed out. */
export function pendingJiraExport(
  row: { jiraExportId: string | null; jiraProject: string | null; jiraStatus: string | null; jiraKey: string | null; jiraRequestedAt: Date | null },
  now: Date = new Date()
): JiraExportFrame | undefined {
  const requestedAt = row.jiraRequestedAt?.getTime();
  if (
    row.jiraStatus !== "pending" ||
    row.jiraKey !== null ||
    row.jiraExportId === null ||
    row.jiraProject === null ||
    requestedAt === undefined ||
    now.getTime() - requestedAt > JIRA_EXPORT_TIMEOUT_MS
  ) {
    return undefined;
  }
  return { export_id: row.jiraExportId, project: row.jiraProject, issue_type: JIRA_ISSUE_TYPE, labels: [...JIRA_LABELS] };
}
