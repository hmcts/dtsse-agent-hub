import { describe, expect, it, vi } from "vitest";
import {
  ghLookupFailure,
  githubOwners,
  githubWords,
  parseProjects,
  parseRepos,
  projectSearchArgs,
  type Run,
  type RunResult,
  repoQuery,
  repoSearchArgs,
  runGithubLookup
} from "./github-lookups.ts";

const OK = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const REPOS = JSON.stringify([
  { fullName: "hmcts/ccd-data-store-api", description: "  Store/search\n cases ", hasIssues: true },
  { fullName: "hmcts/no-issues", description: "", hasIssues: false },
  { fullName: "not a repo", description: null, hasIssues: true }
]);
const PROJECTS = JSON.stringify({
  data: {
    repositoryOwner: {
      projectsV2: {
        nodes: [
          { number: 12, title: "CFT Workspace roadmap", closed: false },
          { number: 3, title: "Old board", closed: true },
          { number: 0, title: "Broken", closed: false },
          { number: 7, title: "  ", closed: false }
        ]
      }
    }
  }
});

function runner(answers: Record<string, RunResult>): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = Object.keys(answers).find((prefix) => args.join(" ").startsWith(prefix));
    return key === undefined ? { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` } : (answers[key] as RunResult);
  };
  return { run, calls };
}

describe("repoQuery", () => {
  it.each([
    ["ccd data", { owner: null, words: ["ccd", "data"] }],
    ["hmcts/ccd-data", { owner: "hmcts", words: ["ccd", "data"] }],
    ["https://github.com/hmcts/cft-workspace", { owner: "hmcts", words: ["cft", "workspace"] }],
    ["--owner=evil/x", { owner: null, words: ["owner", "evil", "x"] }],
    ['"; rm -rf ~', { owner: null, words: ["rm", "rf"] }]
  ])("should read %j as an owner and the words of a name", (query, expected) => {
    expect(repoQuery(query)).toEqual(expected);
  });

  it("should keep at most six words of forty letters each", () => {
    expect(githubWords(`${"a".repeat(50)} b c d e f g h`)).toEqual(["a".repeat(40), "b", "c", "d", "e", "f"]);
  });
});

describe("repoSearchArgs and projectSearchArgs", () => {
  it("should search names in each owner, leaving archived repositories out", () => {
    expect(repoSearchArgs(["ccd", "data"], ["SarahL", "hmcts"])).toEqual([
      "search",
      "repos",
      "ccd",
      "data",
      "--owner=SarahL",
      "--owner=hmcts",
      "--match=name",
      "--archived=false",
      "--limit=20",
      "--json=fullName,description,hasIssues"
    ]);
  });

  it("should pass the owner and the words as GraphQL variables, never in the query", () => {
    const args = projectSearchArgs("hmcts", ["cft", "roadmap"]);

    expect(args.slice(0, 3)).toEqual(["api", "graphql", "-f"]);
    expect(args.slice(4)).toEqual(["-F", "owner=hmcts", "-f", "q=cft roadmap"]);
    expect(args[3]).not.toMatch(/hmcts|roadmap/);
  });
});

describe("parseRepos", () => {
  it("should keep repositories with issues, tidying their descriptions", () => {
    expect(parseRepos(REPOS)).toEqual([{ full_name: "hmcts/ccd-data-store-api", description: "Store/search cases" }]);
  });

  it("should give none when the output is not gh's list", () => {
    expect(parseRepos("not json")).toBeNull();
    expect(parseRepos("{}")).toBeNull();
  });
});

describe("parseProjects", () => {
  it("should keep the owner's open Projects with a number and a title", () => {
    expect(parseProjects(PROJECTS, "hmcts")).toEqual([{ owner: "hmcts", number: 12, title: "CFT Workspace roadmap" }]);
  });

  it("should give an empty list for an owner GitHub does not know", () => {
    expect(parseProjects(JSON.stringify({ data: { repositoryOwner: null } }), "nobody")).toEqual([]);
  });

  it("should give none when the output carries no data", () => {
    expect(parseProjects(JSON.stringify({ errors: [{ type: "INSUFFICIENT_SCOPES" }] }), "hmcts")).toBeNull();
    expect(parseProjects("not json", "hmcts")).toBeNull();
  });
});

describe("ghLookupFailure", () => {
  it("should say to reconnect GitHub when the token has no project scope", () => {
    const result = {
      code: 1,
      stdout: JSON.stringify({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:project" }] }),
      stderr: "gh: needs scopes"
    };

    expect(ghLookupFailure(result, "Projects")).toMatch(/needs the project scope\. Reconnect GitHub in Connections/);
  });

  it("should say when gh is missing or signed out", () => {
    expect(ghLookupFailure({ code: 127, stdout: "", stderr: "" }, "repositories")).toMatch(/gh is not installed/);
    expect(ghLookupFailure({ code: 4, stdout: "", stderr: "" }, "repositories")).toMatch(/not signed in to GitHub/);
  });

  it("should give gh's own words, kept short, for any other failure", () => {
    expect(ghLookupFailure({ code: 1, stdout: "", stderr: "HTTP 503: Service Unavailable\n" }, "repositories")).toBe(
      "GitHub could not search repositories: HTTP 503: Service Unavailable"
    );
    expect(ghLookupFailure({ code: 1, stdout: "", stderr: "x".repeat(500) }, "repositories")).toHaveLength(300);
    expect(ghLookupFailure({ code: 1, stdout: "", stderr: "" }, "repositories")).toBe("GitHub repositories could not be searched just now.");
  });
});

describe("githubOwners", () => {
  it("should ask once for the person and their organisations, and keep the answer", async () => {
    // Arrange
    const { run, calls } = runner({ "api user/orgs": OK("hmcts\nbad login!\n"), "api user ": OK("SarahL\n") });
    const owners = githubOwners(run, {});

    // Act
    const first = await owners();
    const second = await owners();

    // Assert
    expect(first).toEqual(["SarahL", "hmcts"]);
    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("should keep nothing, and ask again next time, when gh is not signed in", async () => {
    const { run, calls } = runner({ "api user/orgs": { code: 4, stdout: "", stderr: "" }, "api user ": { code: 4, stdout: "", stderr: "" } });
    const owners = githubOwners(run, {});

    expect(await owners()).toBeNull();
    await owners();
    expect(calls).toHaveLength(4);
  });
});

describe("runGithubLookup", () => {
  it("should search the person's own accounts when no owner is typed", async () => {
    const { run, calls } = runner({ "search repos": OK(REPOS) });
    const owners = vi.fn(async () => ["SarahL", "hmcts"]);

    const answer = await runGithubLookup({ run, env: {}, owners }, { kind: "github_repo", query: "ccd data", owner: null });

    expect(answer).toEqual({ results: [{ full_name: "hmcts/ccd-data-store-api", description: "Store/search cases" }] });
    expect(calls[0]).toContain("--owner=SarahL");
  });

  it("should search only the owner typed before a slash, without asking for the person's accounts", async () => {
    const { run, calls } = runner({ "search repos": OK("[]") });
    const owners = vi.fn(async () => ["SarahL"]);

    await runGithubLookup({ run, env: {}, owners }, { kind: "github_repo", query: "hmcts/ccd", owner: null });

    expect(owners).not.toHaveBeenCalled();
    expect(calls[0]?.filter((arg) => arg.startsWith("--owner="))).toEqual(["--owner=hmcts"]);
  });

  it("should answer nothing, running nothing, when there are no words to search for", async () => {
    const { run, calls } = runner({});

    expect(await runGithubLookup({ run, env: {}, owners: async () => [] }, { kind: "github_repo", query: "hmcts/", owner: null })).toEqual({
      results: []
    });
    expect(calls).toEqual([]);
  });

  it("should say why when the person's accounts cannot be read", async () => {
    const answer = await runGithubLookup({ run: runner({}).run, env: {}, owners: async () => null }, { kind: "github_repo", query: "ccd", owner: null });

    expect(answer).toMatchObject({ error: "failed", detail: expect.stringContaining("not signed in to GitHub") });
  });

  it("should say why when the repository search fails", async () => {
    const { run } = runner({ "search repos": { code: 1, stdout: "", stderr: "HTTP 403: rate limited" } });

    const answer = await runGithubLookup({ run, env: {}, owners: async () => ["hmcts"] }, { kind: "github_repo", query: "ccd", owner: null });

    expect(answer).toEqual({ error: "failed", detail: "GitHub could not search repositories: HTTP 403: rate limited" });
  });

  it("should search the repository owner's Projects", async () => {
    const { run, calls } = runner({ "api graphql": OK(PROJECTS) });

    const answer = await runGithubLookup({ run, env: {}, owners: async () => [] }, { kind: "github_project", query: "roadmap", owner: "hmcts" });

    expect(answer).toEqual({ results: [{ owner: "hmcts", number: 12, title: "CFT Workspace roadmap" }] });
    expect(calls[0]).toContain("owner=hmcts");
  });

  it("should say to reconnect GitHub when the Project search is refused for want of a scope", async () => {
    const { run } = runner({ "api graphql": { code: 1, stdout: JSON.stringify({ errors: [{ type: "INSUFFICIENT_SCOPES" }] }), stderr: "" } });

    const answer = await runGithubLookup({ run, env: {}, owners: async () => [] }, { kind: "github_project", query: "roadmap", owner: "hmcts" });

    expect(answer).toMatchObject({ error: "failed", detail: expect.stringContaining("project scope") });
  });

  it("should ask for the repository first when a Project search has no owner", async () => {
    const answer = await runGithubLookup({ run: runner({}).run, env: {}, owners: async () => [] }, { kind: "github_project", query: "x", owner: null });

    expect(answer).toMatchObject({ error: "failed", detail: expect.stringContaining("Choose the repository first") });
  });
});
