import { describe, expect, it } from "vitest";
import { isJiraProject, JIRA_EXPORT_TIMEOUT_MS, type JiraExportRow, jiraExportView, jiraIssueUrl, pendingJiraExport } from "./jira.ts";

const NOW = new Date("2026-10-23T10:00:00.000Z");

function row(overrides: Partial<JiraExportRow> = {}): JiraExportRow {
  return { jiraExportId: null, jiraProject: null, jiraStatus: null, jiraKey: null, jiraError: null, jiraRequestedAt: null, ...overrides };
}

describe("jiraExportView", () => {
  it("should offer the export when the document has never been exported", () => {
    expect(jiraExportView(row(), NOW)).toEqual({ status: "none" });
  });

  it("should be pending when the pod has not reported within the timeout", () => {
    const requested = new Date(NOW.getTime() - JIRA_EXPORT_TIMEOUT_MS + 1000);

    expect(jiraExportView(row({ jiraStatus: "pending", jiraProject: "VIBE", jiraRequestedAt: requested }), NOW)).toEqual({
      status: "pending",
      project: "VIBE"
    });
  });

  it("should count as failed, so it can be tried again, when the pod has not reported past the timeout", () => {
    const requested = new Date(NOW.getTime() - JIRA_EXPORT_TIMEOUT_MS - 1000);

    expect(jiraExportView(row({ jiraStatus: "pending", jiraProject: "VIBE", jiraRequestedAt: requested }), NOW)).toEqual({
      status: "failed",
      project: "VIBE",
      error: "Jira did not answer in time. Try again."
    });
  });

  it("should show the ticket and its link when the pod reported a key", () => {
    expect(jiraExportView(row({ jiraStatus: "done", jiraProject: "VIBE", jiraKey: "VIBE-701" }), NOW)).toEqual({
      status: "done",
      project: "VIBE",
      key: "VIBE-701",
      url: "https://hmcts.atlassian.net/browse/VIBE-701"
    });
  });

  it("should show the pod's reason when the export failed", () => {
    expect(jiraExportView(row({ jiraStatus: "failed", jiraProject: "VIBE", jiraError: "Story is not an issue type of VIBE" }), NOW)).toEqual({
      status: "failed",
      project: "VIBE",
      error: "Story is not an issue type of VIBE"
    });
  });
});

describe("isJiraProject", () => {
  it.each([
    ["VIBE", true],
    ["vibe", false],
    ["CCD", false],
    [undefined, false]
  ])("should answer %j as %s when checking it against the boards on offer", (value, expected) => {
    expect(isJiraProject(value)).toBe(expected);
  });
});

describe("jiraIssueUrl", () => {
  it("should link to the issue on the HMCTS site when given its key", () => {
    expect(jiraIssueUrl("VIBE-1")).toBe("https://hmcts.atlassian.net/browse/VIBE-1");
  });
});

describe("pendingJiraExport", () => {
  const EXPORT = "33333333-3333-4333-8333-333333333333";
  const asked = row({ jiraExportId: EXPORT, jiraProject: "VIBE", jiraStatus: "pending", jiraRequestedAt: new Date(NOW.getTime() - 60_000) });

  it("should give the session what to create and the id to report it under when an export is pending", () => {
    expect(pendingJiraExport(asked, NOW)).toEqual({ export_id: EXPORT, project: "VIBE", issue_type: "Story", labels: ["hmcts-assistant"] });
  });

  it.each([
    ["reported", { jiraStatus: "done", jiraKey: "VIBE-1" }],
    ["failed", { jiraStatus: "failed" }],
    ["timed out", { jiraRequestedAt: new Date(NOW.getTime() - JIRA_EXPORT_TIMEOUT_MS - 1000) }]
  ])("should give nothing when the export has %s", (_, change) => {
    expect(pendingJiraExport({ ...asked, ...change }, NOW)).toBeUndefined();
  });
});
