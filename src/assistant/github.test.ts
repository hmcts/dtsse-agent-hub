import { describe, expect, it } from "vitest";
import {
  GITHUB_EXPORT_TIMEOUT_MS,
  type GithubExportRow,
  githubExportView,
  githubIssueUrl,
  isGithubRepo,
  isTicketTool,
  pendingGithubExport,
  readGithubProject,
  readGithubRepo,
  repoOwner,
  sameOwner
} from "./github.ts";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const EXPORT = "5b0e7c1a-1111-4222-8333-444455556666";

function row(overrides: Partial<GithubExportRow> = {}): GithubExportRow {
  return { githubExportId: null, githubRepo: null, githubStatus: null, githubNumber: null, githubError: null, githubRequestedAt: null, ...overrides };
}

describe("githubExportView", () => {
  it("should offer the export when the document has never been exported", () => {
    expect(githubExportView(row(), NOW)).toEqual({ status: "none" });
  });

  it("should be pending when the pod has not reported within the timeout", () => {
    const requested = new Date(NOW.getTime() - GITHUB_EXPORT_TIMEOUT_MS + 1000);

    expect(githubExportView(row({ githubStatus: "pending", githubRepo: "hmcts/cft-workspace", githubRequestedAt: requested }), NOW)).toEqual({
      status: "pending",
      repo: "hmcts/cft-workspace",
      project: null,
      requestedAt: requested.toISOString()
    });
  });

  it("should count as failed, so it can be tried again, when the pod has not reported past the timeout", () => {
    const requested = new Date(NOW.getTime() - GITHUB_EXPORT_TIMEOUT_MS - 1000);

    expect(githubExportView(row({ githubStatus: "pending", githubRepo: "hmcts/cft-workspace", githubRequestedAt: requested }), NOW)).toEqual({
      status: "failed",
      repo: "hmcts/cft-workspace",
      project: null,
      error: "GitHub did not answer in time. Try again."
    });
  });

  it("should show the issue and its link when the pod reported a number", () => {
    expect(githubExportView(row({ githubStatus: "done", githubRepo: "hmcts/cft-workspace", githubNumber: 42 }), NOW)).toEqual({
      status: "done",
      repo: "hmcts/cft-workspace",
      number: 42,
      url: "https://github.com/hmcts/cft-workspace/issues/42",
      project: null,
      projectError: null
    });
  });

  it("should carry the Project, and why the issue is not on it, when the pod reported that", () => {
    const project = { githubProjectOwner: "hmcts", githubProjectNumber: 12, githubProjectTitle: "CFT roadmap" };

    expect(
      githubExportView(row({ githubStatus: "done", githubRepo: "hmcts/x", githubNumber: 1, githubProjectError: "needs the project scope", ...project }), NOW)
    ).toMatchObject({ project: { owner: "hmcts", number: 12, title: "CFT roadmap" }, projectError: "needs the project scope" });
    expect(githubExportView(row({ githubStatus: "done", githubRepo: "hmcts/x", githubNumber: 1, githubProjectError: "stray" }), NOW)).toMatchObject({
      project: null,
      projectError: null
    });
  });

  it("should show the pod's reason when the export failed", () => {
    expect(githubExportView(row({ githubStatus: "failed", githubRepo: "hmcts/nope", githubError: "Could not resolve to a Repository" }), NOW)).toEqual({
      status: "failed",
      repo: "hmcts/nope",
      project: null,
      error: "Could not resolve to a Repository"
    });
  });

  it("should give a plain reason when a failed export carries none", () => {
    expect(githubExportView(row({ githubStatus: "failed", githubRepo: "hmcts/nope" }), NOW)).toEqual({
      status: "failed",
      repo: "hmcts/nope",
      project: null,
      error: "The issue could not be created."
    });
  });
});

describe("pendingGithubExport", () => {
  const pending = row({ githubExportId: EXPORT, githubRepo: "hmcts/cft-workspace", githubStatus: "pending", githubRequestedAt: NOW });

  it("should carry the export id and repository while an export is pending", () => {
    expect(pendingGithubExport(pending, NOW)).toEqual({ export_id: EXPORT, repo: "hmcts/cft-workspace", labels: ["cft-workspace"] });
  });

  it("should carry the Project's owner and number, not its title, when the person chose one", () => {
    const onBoard = { ...pending, githubProjectOwner: "hmcts", githubProjectNumber: 12, githubProjectTitle: "CFT roadmap" };

    expect(pendingGithubExport(onBoard, NOW)).toEqual({
      export_id: EXPORT,
      repo: "hmcts/cft-workspace",
      labels: ["cft-workspace"],
      project: { owner: "hmcts", number: 12 }
    });
  });

  it.each([
    ["it has an issue", { githubNumber: 42 }],
    ["it is not pending", { githubStatus: "failed" }],
    ["it has no export id", { githubExportId: null }],
    ["it has no request time", { githubRequestedAt: null }],
    ["it has timed out", { githubRequestedAt: new Date(NOW.getTime() - GITHUB_EXPORT_TIMEOUT_MS - 1) }]
  ])("should carry nothing when %s", (_label, change) => {
    expect(pendingGithubExport({ ...pending, ...change }, NOW)).toBeUndefined();
  });
});

describe("readGithubRepo", () => {
  it.each([
    ["hmcts/cft-workspace", "hmcts/cft-workspace"],
    ["  hmcts/cft-workspace \n", "hmcts/cft-workspace"],
    ["https://github.com/hmcts/cft-workspace", "hmcts/cft-workspace"],
    ["https://www.github.com/hmcts/cft-workspace/", "hmcts/cft-workspace"],
    ["https://github.com/hmcts/cft-workspace.git", "hmcts/cft-workspace"],
    ["hmcts/dtsse.agent_hub-2", "hmcts/dtsse.agent_hub-2"],
    ["hmcts/.github", "hmcts/.github"],
    ["https://github.com/hmcts/.github", "hmcts/.github"]
  ])("should read %j as %s", (typed, repo) => {
    expect(readGithubRepo(typed)).toBe(repo);
  });

  it.each([["cft-workspace"], ["hmcts/"], ["-hmcts/x"], ["hmcts/.."], ["hmcts/."], ["hmcts/x/y"], ["hmcts/x; rm -rf /"], [""], [42], [null]])(
    "should refuse %j",
    (typed) => {
      expect(readGithubRepo(typed)).toBeUndefined();
    }
  );
});

describe("isGithubRepo and isTicketTool", () => {
  it("should accept only an owner/name repository as it would be stored", () => {
    expect(isGithubRepo("hmcts/cft-workspace")).toBe(true);
    expect(isGithubRepo(" hmcts/cft-workspace")).toBe(false);
  });

  it("should accept only jira and github as ticket tools", () => {
    expect(isTicketTool("jira")).toBe(true);
    expect(isTicketTool("github")).toBe(true);
    expect(isTicketTool("GitHub")).toBe(false);
    expect(isTicketTool(undefined)).toBe(false);
  });
});

describe("readGithubProject and repoOwner", () => {
  it("should read a Project the browser sent, tidying its title, and refuse one that is not whole", () => {
    expect(readGithubProject(undefined)).toBeNull();
    expect(readGithubProject({ owner: "hmcts", number: 12, title: " CFT  roadmap " })).toEqual({ owner: "hmcts", number: 12, title: "CFT roadmap" });
    expect(readGithubProject({ owner: "hmcts", number: 1.5, title: "x" })).toBeUndefined();
    expect(readGithubProject({ owner: "hmcts", number: 12, title: "x".repeat(201) })).toBeUndefined();
    expect(readGithubProject("hmcts/12")).toBeUndefined();
  });

  it("should give the owner half of a repository", () => {
    expect(repoOwner("hmcts/cft-workspace")).toBe("hmcts");
  });
});

describe("sameOwner", () => {
  it("should read logins without regard to case, as GitHub does", () => {
    expect(sameOwner("HMCTS", "hmcts")).toBe(true);
    expect(sameOwner("hmcts", "hmcts-reform")).toBe(false);
  });
});

describe("githubIssueUrl", () => {
  it("should link to the issue in its repository", () => {
    expect(githubIssueUrl("hmcts/cft-workspace", 7)).toBe("https://github.com/hmcts/cft-workspace/issues/7");
  });
});
