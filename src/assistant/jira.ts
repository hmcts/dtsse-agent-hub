/**
 * Exporting a conversation's document to a Jira backlog, once: the boards on offer and what the panel shows. The
 * pod creates the issue with its owner's `twg` sign-in, so they are its reporter, and reports the key back; the hub
 * only records what was asked for and what came of it (`jira-store.ts`). See "Jira export" under Conversations in
 * docs/agent-api.md.
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

/** What the document panel shows of the conversation's export. */
export type JiraExportView =
  | { status: "none" }
  | { status: "pending"; project: string }
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
    return expired(row.jiraRequestedAt, now)
      ? { status: "failed", project: row.jiraProject, error: TIMED_OUT }
      : { status: "pending", project: row.jiraProject };
  }
  if (row.jiraStatus === "failed") {
    return { status: "failed", project: row.jiraProject, error: row.jiraError ?? "The ticket could not be created." };
  }
  return { status: "none" };
}
