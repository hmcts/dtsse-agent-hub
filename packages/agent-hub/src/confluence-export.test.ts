import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artefact, ConfluenceExportReport } from "./api.ts";
import {
  type ConfluenceExportDeps,
  confluenceFailure,
  datedTitle,
  pageBody,
  pageTitle,
  parseCreatedPageId,
  type RunResult,
  runConfluenceExport
} from "./confluence-export.ts";

const EXPORT = "5b0e7c1a-1111-4222-8333-444455556666";
const REQUEST = { exportId: EXPORT, spaceId: "280952876", parentId: "280959611" };
const DOC: Artefact = { title: "Case flags guide", markdown: "# Case flags guide\n\nHow flags work.", version: 3, updated_by: "agent", updated_at: null };
const CREATED: RunResult = {
  code: 0,
  stdout: JSON.stringify({ data: { id: "300000001", spaceId: "280952876", parentId: "280959611", snapshotToken: "x" } }),
  stderr: ""
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "confluence-export-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deps(create: RunResult[] = [CREATED], overrides: Partial<ConfluenceExportDeps> = {}) {
  const reports: ConfluenceExportReport[] = [];
  const bodies: string[] = [];
  const queue = [...create];
  const run = vi.fn(async (_cmd: string, args: string[]): Promise<RunResult> => {
    if (args[0] === "whoami") {
      return { code: 0, stdout: "{}", stderr: "" };
    }
    const file = args.find((arg) => arg.startsWith("--body-file="))?.slice("--body-file=".length);
    bodies.push(file ? fs.readFileSync(file, "utf8") : "");
    return queue.shift() ?? CREATED;
  });
  const d: ConfluenceExportDeps = {
    api: {
      getArtefact: async () => DOC,
      putConfluenceExport: async (_agent, body) => {
        reports.push(body);
        return null;
      }
    },
    agentId: "a1",
    env: {},
    run,
    login: null,
    print: () => {},
    dir,
    today: () => new Date("2026-10-26T12:00:00Z"),
    ...overrides
  };
  return { d, run, reports, bodies };
}

describe("pageTitle, pageBody and datedTitle", () => {
  it("should title the page after the document and leave its repeated heading out of the body", () => {
    // Act & Assert
    expect(pageTitle(DOC)).toBe("Case flags guide");
    expect(pageTitle({ title: null, markdown: "Intro\n\n## Flags for caseworkers\n" })).toBe("Flags for caseworkers");
    expect(pageTitle({ title: "  ", markdown: "" })).toBe("CFT Workspace document");
    expect(pageBody(DOC.markdown, "Case flags guide")).toBe("How flags work.");
    expect(pageBody("# Something else\n\nBody", "Case flags guide")).toBe("# Something else\n\nBody");
  });

  it("should put the date after a title Confluence already has, within its length limit", () => {
    // Act & Assert
    expect(datedTitle("Case flags guide", new Date("2026-10-26T12:00:00Z"))).toBe("Case flags guide (26 Oct 2026)");
    expect(datedTitle("x".repeat(300), new Date("2026-10-26T12:00:00Z"))).toHaveLength(255);
  });
});

describe("parseCreatedPageId and confluenceFailure", () => {
  it("should find the new page's id, not its space's or parent's, when twg answers", () => {
    // Act & Assert
    expect(parseCreatedPageId(CREATED.stdout, ["280952876", "280959611"])).toBe("300000001");
    expect(parseCreatedPageId(JSON.stringify({ data: { content: { id: 300000002 } } }))).toBe("300000002");
    expect(parseCreatedPageId(JSON.stringify({ data: { parentId: "280959611" } }), ["280959611"])).toBeNull();
    expect(parseCreatedPageId("not json")).toBeNull();
  });

  it("should say why in one line when twg refused", () => {
    // Act & Assert
    expect(confluenceFailure({ code: 1, stdout: JSON.stringify({ error: { message: "No permission to create in this space" } }), stderr: "" })).toBe(
      "Confluence refused the page: No permission to create in this space"
    );
    expect(confluenceFailure({ code: 2, stdout: "", stderr: "" })).toBe("twg exited 2 without saying why.");
  });
});

describe("runConfluenceExport", () => {
  it("should create the page under the parent with the body in a file, report it, and remove the file", async () => {
    // Arrange
    const { d, run, reports, bodies } = deps();

    // Act
    const outcome = await runConfluenceExport(d, REQUEST);

    // Assert
    expect(outcome).toEqual({ pageId: "300000001", title: "Case flags guide", again: false });
    const args = run.mock.calls.find(([, a]) => a[0] === "confluence")?.[1] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--space-id=280952876",
        "--parent-id=280959611",
        "--content-type=page",
        "--title=Case flags guide",
        "--format=md",
        "--ack-body-formats",
        "-y"
      ])
    );
    expect(bodies).toEqual(["How flags work."]);
    expect(reports).toEqual([{ export_id: EXPORT, page_id: "300000001", title: "Case flags guide" }]);
    expect(fs.readdirSync(dir)).toEqual([`${EXPORT}.json`]);
  });

  it("should report the page it already made, without making another, when run again for the same export", async () => {
    // Arrange
    const first = deps();
    await runConfluenceExport(first.d, REQUEST);
    const again = deps();

    // Act
    const outcome = await runConfluenceExport(again.d, REQUEST);

    // Assert
    expect(outcome).toEqual({ pageId: "300000001", title: "Case flags guide", again: true });
    expect(again.run).not.toHaveBeenCalled();
    expect(again.reports).toEqual([{ export_id: EXPORT, page_id: "300000001", title: "Case flags guide" }]);
  });

  it("should try once more with the date when Confluence already has a page of that title", async () => {
    // Arrange
    const taken = { code: 1, stdout: JSON.stringify({ error: { message: "A page with this title already exists in this space" } }), stderr: "" };
    const { d, reports } = deps([taken, CREATED]);

    // Act
    const outcome = await runConfluenceExport(d, REQUEST);

    // Assert
    expect(outcome).toMatchObject({ title: "Case flags guide (26 Oct 2026)" });
    expect(reports[0]).toMatchObject({ page_id: "300000001", title: "Case flags guide (26 Oct 2026)" });
  });

  it("should report why when twg refuses, and remember nothing", async () => {
    // Arrange
    const { d, reports } = deps([{ code: 1, stdout: JSON.stringify({ error: { message: "No permission" } }), stderr: "" }]);

    // Act
    const outcome = await runConfluenceExport(d, REQUEST);

    // Assert
    expect(outcome).toEqual({ error: "Confluence refused the page: No permission" });
    expect(reports).toEqual([{ export_id: EXPORT, error: "Confluence refused the page: No permission" }]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("should sign in first when twg is not signed in, and give up when the person did not finish", async () => {
    // Arrange
    const login = vi.fn(async () => "not-signed-in" as const);
    const { d, run, reports } = deps([], { login });
    run.mockImplementationOnce(async () => ({ code: 77, stdout: "", stderr: "" }));

    // Act
    const outcome = await runConfluenceExport(d, REQUEST);

    // Assert
    expect(login).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ error: "The Atlassian sign-in was not completed, so the page could not be created." });
    expect(reports).toHaveLength(1);
  });

  it("should refuse to publish an empty document without asking anybody to sign in", async () => {
    // Arrange
    const { d, run } = deps([], { api: { getArtefact: async () => ({ ...DOC, markdown: "  " }), putConfluenceExport: async () => null } });

    // Act & Assert
    expect(await runConfluenceExport(d, REQUEST)).toEqual({ error: "The document is empty, so there was nothing to publish." });
    expect(run).not.toHaveBeenCalled();
  });
});
