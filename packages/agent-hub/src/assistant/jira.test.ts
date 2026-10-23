import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import type { JiraExportReport } from "../api.ts";
import { hubHome } from "../session.ts";
import type { AtlassianLoginResult } from "../virtual/atlassian.ts";
import type { RunResult } from "../virtual/sign-in.ts";
import { createJiraExporter, issueKey, type JiraExport, MAX_DESCRIPTION, parseJiraExport, twgCreateArgs, twgError } from "./jira.ts";

const VID = "va-assist";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const EXPORT = "22222222-2222-4222-8222-222222222222";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, home.env);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

beforeEach(() => {
  fs.rmSync(path.join(hubHome(), "virtual"), { recursive: true, force: true });
});

function request(overrides: Partial<JiraExport> = {}): JiraExport {
  return {
    conversation_id: CONVERSATION,
    export_id: EXPORT,
    project: "VIBE",
    issue_type: "Story",
    labels: ["hmcts-assistant"],
    summary: "Let caseworkers see flags",
    description: "# Problem\n\nFlags are hidden.",
    ...overrides
  };
}

const CREATED = JSON.stringify({
  apiVersion: "v2",
  command: "jira.workitem.create",
  data: [{ id: "944800", key: "VIBE-701", self: "https://example/944800" }]
});

function exporter({
  exec = vi.fn(async (): Promise<RunResult> => ({ code: 0, stdout: CREATED, stderr: "" })),
  signedIn = () => true,
  login = vi.fn(async (): Promise<AtlassianLoginResult> => "signed-in")
}: {
  exec?: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>;
  signedIn?: () => boolean;
  login?: () => Promise<AtlassianLoginResult>;
} = {}) {
  const reports: JiraExportReport[] = [];
  const api = {
    putJiraExport: vi.fn(async (_id: string, _conversation: string, body: JiraExportReport) => {
      reports.push(body);
      return null;
    }),
    virtualStatus: vi.fn(async () => null)
  };
  return { api, reports, exec, login, jira: createJiraExporter({ api, id: VID, exec, signedIn, login }) };
}

describe("parseJiraExport", () => {
  it("should accept an export when it is as the hub sends it", () => {
    expect(parseJiraExport(request())).toEqual(request());
  });

  it.each([
    [{ export_id: "e1" }],
    [{ conversation_id: "c1" }],
    [{ project: "vibe" }],
    [{ issue_type: " " }],
    [{ labels: ["has space"] }],
    [{ summary: 7 }]
  ])("should refuse an export when it has %j", (change) => {
    expect(parseJiraExport({ ...request(), ...change })).toBeNull();
  });
});

describe("twgCreateArgs", () => {
  it("should join every value to its flag when building the twg command", () => {
    expect(twgCreateArgs(request())).toEqual([
      "jira",
      "workitem",
      "create",
      "--space=VIBE",
      "--type=Story",
      "--summary=Let caseworkers see flags",
      "--description=# Problem\n\nFlags are hidden.",
      "--description-format=markdown",
      "--labels=hmcts-assistant",
      "--output=json",
      "--output-summary=none"
    ]);
  });

  it("should leave the description out when the document is blank, and keep a summary that starts with a dash a value", () => {
    const args = twgCreateArgs(request({ summary: "--yes  please\n", description: "  " }));

    expect(args).toContain("--summary=--yes please");
    expect(args.some((arg) => arg.startsWith("--description"))).toBe(false);
  });
});

describe("issueKey", () => {
  it("should find the created key in the project when twg prints its JSON", () => {
    expect(issueKey(CREATED, "VIBE")).toBe("VIBE-701");
  });

  it.each([
    ["not json"],
    [JSON.stringify({ data: [{ key: "CCD-1" }] })],
    [JSON.stringify({ data: [] })]
  ])("should find no key when the output is %s", (stdout) => {
    expect(issueKey(stdout, "VIBE")).toBeNull();
  });
});

describe("twgError", () => {
  it("should give Jira's message when twg prints a JSON error", () => {
    const stdout = JSON.stringify({ error: { message: "Story is not a valid issue type" } });

    expect(twgError({ code: 1, stdout, stderr: "" })).toBe("Jira refused the ticket: Story is not a valid issue type");
  });

  it("should give the first line of stderr, at most 300 characters, when twg prints no JSON", () => {
    const error = twgError({ code: 1, stdout: "", stderr: `\n\u001b[31m${"x".repeat(400)}\u001b[0m\nsecond line` });

    expect(error.startsWith("Jira refused the ticket: xxx")).toBe(true);
    expect(error.length).toBe(300);
  });
});

describe("createJiraExporter", () => {
  it("should create the issue with twg and report its key when the pod is signed in", async () => {
    // Arrange
    const { jira, exec, reports, login } = exporter();

    // Act
    await jira.export(request());

    // Assert
    expect(exec).toHaveBeenCalledWith("twg", twgCreateArgs(request()), { timeoutMs: 90000 });
    expect(reports).toEqual([{ export_id: EXPORT, key: "VIBE-701" }]);
    expect(login).not.toHaveBeenCalled();
  });

  it("should report the issue it already created, and not make another, when the same export comes again", async () => {
    // Arrange
    const first = exporter();
    await first.jira.export(request());
    const again = exporter();

    // Act
    await again.jira.export(request());

    // Assert
    expect(again.exec).not.toHaveBeenCalled();
    expect(again.reports).toEqual([{ export_id: EXPORT, key: "VIBE-701" }]);
  });

  it("should ask the owner to sign in to Atlassian first, and report the agent running again, when twg has no sign-in", async () => {
    // Arrange
    const { jira, api, reports, login } = exporter({ signedIn: () => false });

    // Act
    await jira.export(request());

    // Assert
    expect(login).toHaveBeenCalledOnce();
    expect(api.virtualStatus).toHaveBeenCalledWith(VID, "running");
    expect(reports).toEqual([{ export_id: EXPORT, key: "VIBE-701" }]);
  });

  it("should report that no ticket was made when the owner does not finish signing in", async () => {
    // Arrange
    const { jira, exec, reports } = exporter({ signedIn: () => false, login: async () => "not-signed-in" });

    // Act
    await jira.export(request());

    // Assert
    expect(exec).not.toHaveBeenCalled();
    expect(reports).toEqual([{ export_id: EXPORT, error: "The Atlassian sign-in was not finished, so no ticket was created. Try again." }]);
  });

  it("should report twg's reason when it fails", async () => {
    // Arrange
    const { jira, reports } = exporter({ exec: async () => ({ code: 1, stdout: "", stderr: "Error: field 'summary' is required\n" }) });

    // Act
    await jira.export(request());

    // Assert
    expect(reports).toEqual([{ export_id: EXPORT, error: "Jira refused the ticket: Error: field 'summary' is required" }]);
  });

  it("should not run twg, and say why, when the document is longer than Jira takes", async () => {
    // Arrange
    const { jira, exec, reports } = exporter();

    // Act
    await jira.export(request({ description: "x".repeat(MAX_DESCRIPTION + 1) }));

    // Assert
    expect(exec).not.toHaveBeenCalled();
    expect(reports[0]).toEqual({ export_id: EXPORT, error: expect.stringContaining("at most 32,767 characters") });
  });

  it("should ignore an export the hub would not send", async () => {
    // Arrange
    const { jira, exec, reports } = exporter();

    // Act
    await jira.export({ conversation_id: "nope" });

    // Assert
    expect(exec).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("should create one export at a time when two arrive together", async () => {
    // Arrange
    let running = 0;
    let most = 0;
    const exec = vi.fn(async (): Promise<RunResult> => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { code: 0, stdout: CREATED, stderr: "" };
    });
    const { jira } = exporter({ exec });

    // Act
    await Promise.all([jira.export(request()), jira.export(request({ export_id: "33333333-3333-4333-8333-333333333333" }))]);

    // Assert
    expect(exec).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });
});
