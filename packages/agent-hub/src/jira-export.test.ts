import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artefact, JiraExportReport } from "./api.ts";
import {
  type JiraExportDeps,
  type JiraExportRequest,
  jiraSummary,
  MAX_JIRA_ERROR,
  MAX_SUMMARY,
  parseCreatedKey,
  runJiraExport,
  twgFailure
} from "./jira-export.ts";
import type { AtlassianLoginResult } from "./virtual/atlassian.ts";
import type { RunResult } from "./virtual/sign-in.ts";

const EXPORT = "5b0e7c1a-1111-4222-8333-444455556666";
const REQUEST: JiraExportRequest = { exportId: EXPORT, project: "VIBE", issueType: "Story", labels: ["hmcts-assistant"] };
const CREATED: RunResult = { code: 0, stdout: JSON.stringify({ data: { key: "VIBE-123", id: "10001", self: "https://…" } }), stderr: "" };
const OK: RunResult = { code: 0, stdout: "olive@hmcts.net", stderr: "" };

type Fake = {
  deps: JiraExportDeps;
  calls: string[][];
  reports: JiraExportReport[];
  printed: string[];
  login: ReturnType<typeof vi.fn<() => Promise<AtlassianLoginResult>>>;
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-export-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fake({
  doc = { title: "Fee stories", markdown: "# Stories\n\nAs a claimant…" },
  results = {},
  login = "signed-in",
  inPod = true,
  failReports = 0
}: {
  doc?: Pick<Artefact, "title" | "markdown">;
  results?: { whoami?: RunResult[]; create?: RunResult };
  login?: AtlassianLoginResult;
  inPod?: boolean;
  failReports?: number;
} = {}): Fake {
  const calls: string[][] = [];
  const reports: JiraExportReport[] = [];
  const printed: string[] = [];
  const whoami = [...(results.whoami ?? [OK])];
  let reportFailures = failReports;
  const loginFn = vi.fn(async (): Promise<AtlassianLoginResult> => login);
  const deps: JiraExportDeps = {
    api: {
      getArtefact: async () => ({ ...doc, version: 3, updated_by: "agent", updated_at: null }),
      putJiraExport: async (_agentId, body) => {
        if (reportFailures-- > 0) {
          throw new Error("hub unreachable");
        }
        reports.push(body);
        return null;
      }
    },
    agentId: "a-conversation",
    env: {},
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "whoami") {
        return whoami.shift() ?? OK;
      }
      return results.create ?? CREATED;
    },
    login: inPod ? loginFn : null,
    print: (message) => printed.push(message),
    dir
  };
  return { deps, calls, reports, printed, login: loginFn };
}

const creates = (calls: string[][]) => calls.filter((call) => call[1] === "jira");

describe("runJiraExport", () => {
  it("should create the ticket with the document as plain arguments and report its key when twg is signed in", async () => {
    // Arrange
    const f = fake({ doc: { title: 'Fee "stories"; $(rm -rf ~)', markdown: "# Stories\n\n`whoami` and $HOME" } });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ key: "VIBE-123", again: false });
    expect(f.calls).toEqual([
      ["twg", "whoami"],
      [
        "twg",
        "jira",
        "workitem",
        "create",
        "--space=VIBE",
        "--type=Story",
        '--summary=Fee "stories"; $(rm -rf ~)',
        "--description=# Stories\n\n`whoami` and $HOME",
        "--description-format=markdown",
        "--labels=hmcts-assistant",
        "--output=json",
        "--output-summary=none"
      ]
    ]);
    expect(f.reports).toEqual([{ export_id: EXPORT, key: "VIBE-123" }]);
    expect(f.login).not.toHaveBeenCalled();
  });

  it("should report the key it already made and run no twg when the same export runs again", async () => {
    // Arrange
    const first = fake();
    await runJiraExport(first.deps, REQUEST);
    const again = fake({ results: { create: { ...CREATED, stdout: JSON.stringify({ data: { key: "VIBE-124" } }) } } });

    // Act
    const outcome = await runJiraExport(again.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ key: "VIBE-123", again: true });
    expect(again.calls).toEqual([]);
    expect(again.reports).toEqual([{ export_id: EXPORT, key: "VIBE-123" }]);
  });

  it("should sign twg in first and then create the ticket when twg whoami fails in a pod", async () => {
    // Arrange
    const f = fake({ results: { whoami: [{ code: 1, stdout: "", stderr: "not logged in" }] } });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(f.login).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ key: "VIBE-123", again: false });
    expect(f.printed.join("\n")).toMatch(/asking the user to sign in to Atlassian/);
  });

  it("should report why and create nothing when the user does not complete the sign-in", async () => {
    // Arrange
    const f = fake({ results: { whoami: [{ code: 1, stdout: "", stderr: "" }] }, login: "not-signed-in" });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ error: "The Atlassian sign-in was not completed, so the ticket could not be created." });
    expect(creates(f.calls)).toEqual([]);
    expect(f.reports).toEqual([{ export_id: EXPORT, error: "The Atlassian sign-in was not completed, so the ticket could not be created." }]);
  });

  it("should report that twg is not signed in rather than try to sign in when it runs outside a pod", async () => {
    // Arrange
    const f = fake({ results: { whoami: [{ code: 1, stdout: "", stderr: "" }] }, inPod: false });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ error: "twg is not signed in to Atlassian, so the ticket could not be created." });
    expect(creates(f.calls)).toEqual([]);
  });

  it("should report twg's reason and remember nothing when the create fails", async () => {
    // Arrange
    const failed: RunResult = { code: 1, stdout: "", stderr: "\u001b[31mError:\u001b[0m Story is not an issue type of VIBE\nhelp: …" };
    const f = fake({ results: { create: failed } });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);
    const retried = fake();
    const second = await runJiraExport(retried.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ error: "Jira refused the ticket: Error: Story is not an issue type of VIBE" });
    expect(f.reports).toEqual([{ export_id: EXPORT, error: "Jira refused the ticket: Error: Story is not an issue type of VIBE" }]);
    expect(second).toEqual({ key: "VIBE-123", again: false });
  });

  it("should report an empty document and run no twg when there is nothing to export", async () => {
    // Arrange
    const f = fake({ doc: { title: null, markdown: "  \n" } });

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ error: "The document is empty, so there was nothing to export." });
    expect(f.calls).toEqual([]);
  });

  it("should keep the key and report it on the next run, not create another, when the hub cannot be told", async () => {
    // Arrange
    const f = fake({ failReports: 3 });

    // Act
    const failed = runJiraExport(f.deps, REQUEST);
    await expect(failed).rejects.toThrow("hub unreachable");
    const again = fake();
    const outcome = await runJiraExport(again.deps, REQUEST);

    // Assert
    expect(creates(f.calls)).toHaveLength(1);
    expect(again.calls).toEqual([]);
    expect(outcome).toEqual({ key: "VIBE-123", again: true });
  }, 20000);

  it("should refuse to run twg when another command is already exporting the same id", async () => {
    // Arrange
    fs.writeFileSync(path.join(dir, `${EXPORT}.lock`), "");
    const f = fake();

    // Act & Assert
    await expect(runJiraExport(f.deps, REQUEST)).rejects.toThrow(/already running in another command/);
    expect(f.calls).toEqual([]);
    expect(f.reports).toEqual([]);
  });

  it("should take over the lock when it is older than the hub's export timeout", async () => {
    // Arrange
    const lock = path.join(dir, `${EXPORT}.lock`);
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 16 * 60_000);
    fs.utimesSync(lock, old, old);
    const f = fake();

    // Act
    const outcome = await runJiraExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ key: "VIBE-123", again: false });
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("parseCreatedKey", () => {
  it("should find the key under data, preferring the project asked for, when the JSON also names another issue", () => {
    // Arrange
    const stdout = JSON.stringify({ data: { parent: { key: "EPIC-9" }, issue: { fields: {}, key: "VIBE-77" } } });

    // Act & Assert
    expect(parseCreatedKey(stdout, "VIBE")).toBe("VIBE-77");
  });

  it("should give null when the output is not JSON or holds no issue key", () => {
    // Act & Assert
    expect(parseCreatedKey("Created VIBE-1", "VIBE")).toBeNull();
    expect(parseCreatedKey(JSON.stringify({ data: { key: "not a key" } }), "VIBE")).toBeNull();
  });
});

describe("jiraSummary", () => {
  it("should use the title on one line, else the first heading, else a fallback, when each is missing in turn", () => {
    // Act & Assert
    expect(jiraSummary({ title: " Fee\nstories ", markdown: "# Other" })).toBe("Fee stories");
    expect(jiraSummary({ title: null, markdown: "Intro\n\n## Pay a fee\n" })).toBe("Pay a fee");
    expect(jiraSummary({ title: "", markdown: "no heading" })).toBe("CFT Workspace document");
  });

  it("should cut the summary to Jira's limit when the title is longer", () => {
    // Act
    const summary = jiraSummary({ title: "x".repeat(400), markdown: "y" });

    // Assert
    expect(summary).toHaveLength(MAX_SUMMARY);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("twgFailure", () => {
  it("should prefer twg's JSON error message, and keep within the hub's limit, when it gave one", () => {
    // Act & Assert
    expect(twgFailure({ code: 1, stdout: JSON.stringify({ error: { message: "Field 'summary' is required" } }), stderr: "x" })).toBe(
      "Jira refused the ticket: Field 'summary' is required"
    );
    expect(twgFailure({ code: 1, stdout: "", stderr: "e".repeat(1000) })).toHaveLength(MAX_JIRA_ERROR);
  });

  it("should say twg gave no reason when it printed nothing", () => {
    // Act & Assert
    expect(twgFailure({ code: 3, stdout: "", stderr: "" })).toBe("twg exited 3 without saying why.");
  });
});
