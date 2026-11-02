import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GithubExportDeps,
  type GithubExportRequest,
  ghFailure,
  githubTitle,
  MAX_GITHUB_ERROR,
  MAX_TITLE,
  parseCreatedNumber,
  runGithubExport
} from "./github-export.ts";
import type { RunResult } from "./virtual/process.ts";
import type { Artefact, GithubExportReport } from "./wire.ts";

const EXPORT = "5b0e7c1a-1111-4222-8333-444455556666";
const REQUEST: GithubExportRequest = { exportId: EXPORT, repo: "hmcts/cft-workspace" };
const CREATED: RunResult = { code: 0, stdout: "Creating issue in hmcts/cft-workspace\n\nhttps://github.com/hmcts/cft-workspace/issues/42\n", stderr: "" };

type Fake = {
  deps: GithubExportDeps;
  calls: string[][];
  bodies: string[];
  reports: GithubExportReport[];
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-export-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fake({
  doc = { title: "Fee stories", markdown: "# Stories\n\nAs a claimant…" },
  create = CREATED,
  failReports = 0
}: {
  doc?: Pick<Artefact, "title" | "markdown">;
  create?: RunResult;
  failReports?: number;
} = {}): Fake {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const reports: GithubExportReport[] = [];
  let reportFailures = failReports;
  const deps: GithubExportDeps = {
    api: {
      getArtefact: async () => ({ ...doc, version: 3, updated_by: "agent", updated_at: null }),
      putGithubExport: async (_agentId, body) => {
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
      const file = args.find((arg) => arg.startsWith("--body-file="))?.slice("--body-file=".length);
      if (file) {
        bodies.push(fs.readFileSync(file, "utf8"));
      }
      return create;
    },
    print: () => {},
    dir
  };
  return { deps, calls, bodies, reports };
}

describe("runGithubExport", () => {
  it("should create the issue with the title as an argument and the document as a file, and report its number", async () => {
    // Arrange
    const f = fake({ doc: { title: 'Fee "stories"; $(rm -rf ~)', markdown: "# Stories\n\n`whoami` and $HOME" } });

    // Act
    const outcome = await runGithubExport(f.deps, REQUEST);

    // Assert
    expect(outcome).toEqual({ number: 42, url: "https://github.com/hmcts/cft-workspace/issues/42", again: false });
    expect(f.calls).toEqual([
      ["gh", "issue", "create", "--repo=hmcts/cft-workspace", '--title=Fee "stories"; $(rm -rf ~)', `--body-file=${path.join(dir, `${EXPORT}.md`)}`]
    ]);
    expect(f.bodies).toEqual(["# Stories\n\n`whoami` and $HOME"]);
    expect(f.reports).toEqual([{ export_id: EXPORT, number: 42 }]);
  });

  it("should remove the body file when the issue is created", async () => {
    const f = fake();

    await runGithubExport(f.deps, REQUEST);

    expect(fs.existsSync(path.join(dir, `${EXPORT}.md`))).toBe(false);
  });

  it("should report the issue it already made and create no second one when run again for the export", async () => {
    // Arrange
    const f = fake();
    await runGithubExport(f.deps, REQUEST);

    // Act
    const again = await runGithubExport(f.deps, REQUEST);

    // Assert
    expect(again).toEqual({ number: 42, url: "https://github.com/hmcts/cft-workspace/issues/42", again: true });
    expect(f.calls).toHaveLength(1);
    expect(f.reports).toEqual([
      { export_id: EXPORT, number: 42 },
      { export_id: EXPORT, number: 42 }
    ]);
  });

  it("should report the issue on the next run, not make another, when the hub could not be told", async () => {
    // Arrange
    const f = fake({ failReports: 3 });

    // Act
    await expect(runGithubExport(f.deps, REQUEST)).rejects.toThrow("hub unreachable");
    const again = await runGithubExport(f.deps, REQUEST);

    // Assert
    expect(again).toMatchObject({ number: 42, again: true });
    expect(f.calls).toHaveLength(1);
  });

  it("should report why when the document is empty, without running gh", async () => {
    const f = fake({ doc: { title: "Empty", markdown: "  \n" } });

    const outcome = await runGithubExport(f.deps, REQUEST);

    expect(outcome).toEqual({ error: "The document is empty, so there was nothing to export." });
    expect(f.calls).toEqual([]);
    expect(f.reports).toEqual([{ export_id: EXPORT, error: "The document is empty, so there was nothing to export." }]);
  });

  it("should report gh's own words when it refuses the issue", async () => {
    const f = fake({ create: { code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a Repository with the name 'hmcts/nope'. (repository)\n" } });

    const outcome = await runGithubExport(f.deps, { ...REQUEST, repo: "hmcts/nope" });

    expect(outcome).toEqual({ error: "GitHub refused the issue: GraphQL: Could not resolve to a Repository with the name 'hmcts/nope'. (repository)" });
    expect(fs.existsSync(path.join(dir, `${EXPORT}.md`))).toBe(false);
  });

  it("should say the issue may exist when gh succeeds without printing its link", async () => {
    const f = fake({ create: { code: 0, stdout: "done\n", stderr: "" } });

    const outcome = await runGithubExport(f.deps, REQUEST);

    expect(outcome).toEqual({ error: expect.stringContaining("may or may not exist") });
  });

  it("should refuse to run when another command holds the export", async () => {
    const f = fake();
    fs.writeFileSync(path.join(dir, `${EXPORT}.lock`), "");

    await expect(runGithubExport(f.deps, REQUEST)).rejects.toThrow("already running");
    expect(f.calls).toEqual([]);
  });
});

describe("githubTitle", () => {
  it("should use the document's title when it has one", () => {
    expect(githubTitle({ title: "  Fee\n stories ", markdown: "# Other" })).toBe("Fee stories");
  });

  it("should use the first heading when there is no title", () => {
    expect(githubTitle({ title: null, markdown: "Intro\n\n## Fee stories\n" })).toBe("Fee stories");
  });

  it("should fall back to a plain title when there is neither", () => {
    expect(githubTitle({ title: null, markdown: "Just words" })).toBe("HMCTS Assistant document");
  });

  it("should shorten a title longer than GitHub allows", () => {
    const title = githubTitle({ title: "x".repeat(MAX_TITLE + 10), markdown: "" });

    expect(title).toHaveLength(MAX_TITLE);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("parseCreatedNumber", () => {
  it("should read the number from the issue link on gh's last line", () => {
    expect(parseCreatedNumber(CREATED.stdout, "hmcts/cft-workspace")).toBe(42);
  });

  it("should ignore a link to another repository's issue", () => {
    expect(parseCreatedNumber("https://github.com/hmcts/other/issues/7", "hmcts/cft-workspace")).toBeNull();
  });

  it("should not read a dot in the repository as any character", () => {
    expect(parseCreatedNumber("https://github.com/hmcts/aXb/issues/7", "hmcts/a.b")).toBeNull();
  });

  it("should give none when gh printed no link", () => {
    expect(parseCreatedNumber("", "hmcts/cft-workspace")).toBeNull();
  });
});

describe("ghFailure", () => {
  it("should say gh is missing when it is not installed", () => {
    expect(ghFailure({ code: 127, stdout: "", stderr: "" })).toBe("gh is not installed here, so the issue could not be created.");
  });

  it("should say only that GitHub refused when gh printed nothing", () => {
    expect(ghFailure({ code: 1, stdout: "", stderr: "" })).toBe("GitHub refused the issue");
  });

  it("should keep the reason within the hub's limit when gh says a lot", () => {
    expect(ghFailure({ code: 1, stdout: "", stderr: "x".repeat(1000) })).toHaveLength(MAX_GITHUB_ERROR);
  });
});
