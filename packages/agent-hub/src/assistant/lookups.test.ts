import { describe, expect, it, vi } from "vitest";
import type { LookupAnswer } from "../wire.ts";
import {
  confluenceCql,
  confluencePages,
  createLookupRunner,
  type LookupFrame,
  lookupArgs,
  pageIdOf,
  parseConfluenceHits,
  parseConfluenceSpaces,
  parseJiraProjects,
  parseLookupFrame,
  type Run,
  runLookup,
  searchWords,
  spaceArgs,
  twgSignedOut
} from "./lookups.ts";

const LOOKUP = "5b0e7c1a-1111-4222-8333-444455556666";

// Cut down from what `twg confluence search query --cql=… -o json --output-summary=none` (twg 1.3.9) prints.
function confluenceOutput(results: unknown[]): string {
  return JSON.stringify({
    apiVersion: "v2",
    command: "confluence.search.query",
    request: { site: "hmcts.atlassian.net", cql: "type = page", limit: 10, excerpt: false, cursor: null },
    data: { results, start: 0, limit: 10, size: results.length, totalSize: results.length, nextCursor: null },
    meta: { resourceClass: "entity", sourceMode: "native", resourceType: "confluence.search" }
  });
}

const PAGE_RESULT = {
  content: {
    id: "280959611",
    type: "page",
    status: "current",
    title: "CP AI Assistant - Technical Specification",
    _expandable: { ancestors: "", history: "/rest/api/content/280959611/history", space: "/rest/api/space/PEG" },
    _links: { webui: "/spaces/PEG/pages/280959611/CP+AI+Assistant", self: "https://hmcts.atlassian.net/wiki/rest/api/content/280959611" }
  },
  title: "CP AI Assistant - Technical Specification",
  excerpt: "1. System Architecture",
  url: "/spaces/PEG/pages/280959611/CP+AI+Assistant",
  resultGlobalContainer: { title: "Platform Engineering", displayUrl: "/spaces/PEG" },
  breadcrumbs: [],
  entityType: "content"
};

// Cut down from what `twg confluence space list --keys=… -o json --output-summary=none` (twg 1.3.9) prints.
const SPACES_OUTPUT = JSON.stringify({
  apiVersion: "v2",
  command: "confluence.space.list",
  request: { site: "hmcts.atlassian.net", keys: ["PEG"], limit: 10 },
  data: [{ id: "280952876", spaceId: "280952876", name: "Platform Engineering", key: "PEG", type: "global", status: "current", homepageId: "280952878" }],
  meta: { resourceClass: "entity", sourceMode: "native", resourceType: "confluence.space" }
});

// Cut down from what `twg jira space query --query=… -o json --output-summary=none` (twg 1.3.9) prints.
const JIRA_OUTPUT = JSON.stringify({
  apiVersion: "v2",
  command: "jira.space.query",
  request: { site: "hmcts.atlassian.net", maxResults: 10, orderBy: "key", query: "vibe" },
  data: {
    projects: [{ id: "10120", key: "VIBE", name: "Vibe-Coding Enablement", projectTypeKey: "software", simplified: false, style: "classic", isPrivate: false }],
    total: 1,
    startAt: 0,
    maxResults: 10,
    isLast: true
  },
  meta: { resourceClass: "entity", sourceMode: "native", resourceType: "jira.space" }
});

// What twg 1.3.9 prints for a search Atlassian refused, cut down.
function twgError(message: string): string {
  return JSON.stringify({ ok: false, error: { code: "TWG_TOOL_EXECUTION_FAILED", kind: "twg_tool_execution_failed", message, statusCode: 400 } });
}

const SIGNED_OUT = { code: 77, stdout: JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "authentication required." } }), stderr: "" };

function frame(overrides: Partial<LookupFrame> = {}): LookupFrame {
  return { lookup_id: LOOKUP, kind: "confluence_page", query: "case flags", space: null, owner: null, sign_in: false, ...overrides };
}

describe("parseLookupFrame", () => {
  it("should keep a lookup when every value is one the hub would send", () => {
    // Act & Assert
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "confluence_page", query: "flags", space: "CCD", sign_in: false })).toEqual(
      frame({ query: "flags", space: "CCD" })
    );
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "jira_project", query: "vibe", space: "CCD" })?.space).toBeNull();
  });

  it("should keep a GitHub lookup, with the owner only for a Project, and never ask it to sign in", () => {
    // Act & Assert
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "github_repo", query: "ccd data", space: "CCD", owner: "hmcts", sign_in: true })).toEqual(
      frame({ kind: "github_repo", query: "ccd data" })
    );
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "github_project", query: "cft", owner: "hmcts" })).toEqual(
      frame({ kind: "github_project", query: "cft", owner: "hmcts" })
    );
  });

  it.each([[{ owner: undefined }], [{ owner: "-hmcts" }], [{ owner: "hmcts --jq ." }]])(
    "should drop a Project lookup when it has %j, since the owner goes into the search",
    (change) => {
      expect(parseLookupFrame({ ...frame({ kind: "github_project", owner: "hmcts" }), ...change })).toBeNull();
    }
  );

  it.each([[{ lookup_id: "not-an-id" }], [{ kind: "people" }], [{ query: 4 }], [{ query: "x".repeat(101) }], [{ space: 'CCD" OR space = "HR' }]])(
    "should drop the lookup when it has %j, since its values go into a search",
    (change) => {
      // Act & Assert
      expect(parseLookupFrame({ ...frame(), ...change })).toBeNull();
    }
  );
});

describe("the search a lookup runs", () => {
  it("should reduce a query to its words, so nothing typed can change the CQL", () => {
    // Act & Assert
    expect(searchWords(`case "flags" OR (title ~ x)`)).toEqual(["case", "flags", "OR", "title", "x"]);
    expect(confluenceCql(`flags" OR space = "HR`, "CCD")).toBe('type = page AND space = "CCD" AND title ~ "flags* OR* space* HR*"');
    expect(confluenceCql("--", null)).toBeNull();
  });

  it("should look up a page by its id when its link or id is pasted", () => {
    // Act & Assert
    expect(pageIdOf("https://hmcts.atlassian.net/wiki/spaces/PEG/pages/280959611/CP+AI")).toBe("280959611");
    expect(pageIdOf("https://hmcts.atlassian.net/wiki/pages/viewpage.action?pageId=280959611")).toBe("280959611");
    expect(pageIdOf("280959611")).toBe("280959611");
    expect(pageIdOf("2026")).toBeNull();
    expect(confluenceCql("https://hmcts.atlassian.net/wiki/spaces/PEG/pages/280959611", "CCD")).toBe("type = page AND id = 280959611");
  });

  it("should pass every value to twg as its own argument when the lookup is a search", () => {
    // Act
    const confluence = lookupArgs(frame({ space: "PEG" }));
    const jira = lookupArgs(frame({ kind: "jira_project", query: "vibe coding" }));

    // Assert
    expect(confluence).toEqual([
      "confluence",
      "search",
      "query",
      '--cql=type = page AND space = "PEG" AND title ~ "case* flags*"',
      "--limit=10",
      "-o",
      "json",
      "--output-summary=none"
    ]);
    expect(jira).toEqual(["jira", "space", "query", "--query=vibe coding", "--limit=10", "-o", "json", "--output-summary=none"]);
    expect(spaceArgs(["PEG", "CCD"])).toEqual(["confluence", "space", "list", "--keys=PEG,CCD", "--limit=10", "-o", "json", "--output-summary=none"]);
  });
});

describe("parsing what twg found", () => {
  it("should keep only pages, with their space's key, when Confluence answers a search", () => {
    // Act
    const hits = parseConfluenceHits(confluenceOutput([PAGE_RESULT, { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, type: "blogpost" } }]));

    // Assert
    expect(hits).toEqual([{ id: "280959611", title: "CP AI Assistant - Technical Specification", space_key: "PEG" }]);
  });

  it("should take the space's key from the result's container when the page does not name its space", () => {
    // Arrange
    const result = { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, _expandable: {} } };

    // Act & Assert
    expect(parseConfluenceHits(confluenceOutput([result]))?.[0]?.space_key).toBe("PEG");
  });

  it("should leave a page out when its space key is not one a lookup could narrow to", () => {
    // Arrange
    const result = {
      ...PAGE_RESULT,
      content: { ...PAGE_RESULT.content, _expandable: { space: "/rest/api/space/~someone@example.com" } },
      resultGlobalContainer: { title: "Someone", displayUrl: "/spaces/~someone@example.com" }
    };

    // Act & Assert
    expect(parseConfluenceHits(confluenceOutput([result]))).toEqual([]);
  });

  it("should give each page its space's id and name, and leave out a page whose space was not read", () => {
    // Arrange
    const hits =
      parseConfluenceHits(
        confluenceOutput([PAGE_RESULT, { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, id: "1234567", _expandable: { space: "/rest/api/space/HR" } } }])
      ) ?? [];
    const spaces = parseConfluenceSpaces(SPACES_OUTPUT);

    // Act
    const pages = confluencePages(hits, spaces ?? new Map());

    // Assert
    expect(pages).toEqual([
      {
        id: "280959611",
        title: "CP AI Assistant - Technical Specification",
        space_id: "280952876",
        space_key: "PEG",
        space_name: "Platform Engineering",
        ancestors: []
      }
    ]);
  });

  it("should keep a project's key and name when Jira answers", () => {
    // Act & Assert
    expect(parseJiraProjects(JIRA_OUTPUT)).toEqual([{ key: "VIBE", name: "Vibe-Coding Enablement" }]);
  });

  it("should give nothing for an answer that is not a successful search", () => {
    // Act & Assert
    expect(parseConfluenceHits("not json")).toBeNull();
    expect(parseConfluenceSpaces(twgError("Space not found"))).toBeNull();
    expect(parseJiraProjects(twgError("Bad request"))).toBeNull();
  });

  it("should tell a missing sign-in from any other failure", () => {
    // Act & Assert
    expect(twgSignedOut(SIGNED_OUT)).toBe(true);
    expect(twgSignedOut({ code: 1, stdout: "{}", stderr: "boom" })).toBe(false);
  });
});

describe("runLookup", () => {
  function deps(results: Record<string, { code: number; stdout: string; stderr: string }>, login = vi.fn(async () => true)) {
    const run = vi.fn<Run>(async (_cmd, args) => results[args.slice(0, 3).join(" ")] ?? results[args[0] as string] ?? { code: 0, stdout: "", stderr: "" });
    return { run, login, env: {} };
  }

  it("should answer what Confluence found, with each page's space read once, when twg is signed in", async () => {
    // Arrange
    const d = deps({
      "confluence search query": {
        code: 0,
        stdout: confluenceOutput([PAGE_RESULT, { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, id: "280959612" } }]),
        stderr: ""
      },
      "confluence space list": { code: 0, stdout: SPACES_OUTPUT, stderr: "" }
    });

    // Act
    const answer = await runLookup(d, frame());

    // Assert
    expect(answer).toMatchObject({ results: [{ id: "280959611", space_id: "280952876", space_key: "PEG" }, { id: "280959612" }] });
    expect(d.run).toHaveBeenCalledWith("twg", expect.arrayContaining(["confluence", "search", "query"]), { env: {}, timeoutMs: expect.any(Number) });
    expect(d.run).toHaveBeenCalledWith("twg", expect.arrayContaining(["--keys=PEG"]), { env: {}, timeoutMs: expect.any(Number) });
    expect(d.login).not.toHaveBeenCalled();
  });

  it("should answer no results without reading any space when Confluence found no pages", async () => {
    // Arrange
    const d = deps({ "confluence search query": { code: 0, stdout: confluenceOutput([]), stderr: "" } });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ results: [] });
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it("should say why in a sentence when the spaces of the pages found could not be read", async () => {
    // Arrange
    const d = deps({
      "confluence search query": { code: 0, stdout: confluenceOutput([PAGE_RESULT]), stderr: "" },
      "confluence space list": { code: 1, stdout: twgError("Space lookup failed"), stderr: "" }
    });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "failed", detail: "Confluence could not search that: Space lookup failed" });
  });

  it("should answer signed_out, without signing in, when twg has no sign-in and nobody asked for one", async () => {
    // Arrange
    const d = deps({ confluence: SIGNED_OUT });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "signed_out" });
    expect(d.login).not.toHaveBeenCalled();
  });

  it("should sign in first and then search when the person asked to sign in", async () => {
    // Arrange
    const d = deps({ whoami: SIGNED_OUT, jira: { code: 0, stdout: JIRA_OUTPUT, stderr: "" } });

    // Act
    const answer = await runLookup(d, frame({ kind: "jira_project", query: "vibe", sign_in: true }));

    // Assert
    expect(d.login).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ results: [{ key: "VIBE", name: "Vibe-Coding Enablement" }] });
  });

  it("should answer signed_out when the person did not finish signing in", async () => {
    // Arrange
    const d = deps(
      { whoami: SIGNED_OUT },
      vi.fn(async () => false)
    );

    // Act & Assert
    expect(await runLookup(d, frame({ sign_in: true }))).toEqual({ error: "signed_out" });
  });

  it("should say why in a sentence when the search failed for another reason", async () => {
    // Arrange
    const d = deps({ confluence: { code: 1, stdout: twgError("Could not parse cql"), stderr: "" } });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "failed", detail: "Confluence could not search that: Could not parse cql" });
  });
});

describe("runLookup for GitHub", () => {
  const REPOS = JSON.stringify([{ fullName: "hmcts/cft-workspace", description: null, hasIssues: true }]);

  it("should search the person's repositories with gh, never twg, and never sign in", async () => {
    // Arrange
    const run = vi.fn<Run>(async () => ({ code: 0, stdout: REPOS, stderr: "" }));
    const login = vi.fn(async () => true);

    // Act
    const answer = await runLookup(
      { run, env: {}, login, githubOwners: async () => ["hmcts"] },
      frame({ kind: "github_repo", query: "cft workspace", sign_in: true })
    );

    // Assert
    expect(answer).toEqual({ results: [{ full_name: "hmcts/cft-workspace", description: null }] });
    expect(run.mock.calls.map((call) => call[0])).toEqual(["gh"]);
    expect(login).not.toHaveBeenCalled();
  });

  it("should ask gh for the person's accounts itself when it is given none to search", async () => {
    // Arrange
    const run = vi.fn<Run>(async (_cmd, args) =>
      args[0] === "api" && args[1] === "user"
        ? { code: 0, stdout: "SarahL\n", stderr: "" }
        : args[0] === "api"
          ? { code: 0, stdout: "hmcts\n", stderr: "" }
          : { code: 0, stdout: REPOS, stderr: "" }
    );

    // Act
    await runLookup({ run, env: {}, login: async () => true }, frame({ kind: "github_repo", query: "cft" }));

    // Assert
    expect(run.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["--owner=SarahL", "--owner=hmcts"]));
  });

  it("should ask for the person's accounts once for every search a runner makes", async () => {
    // Arrange
    const answers: LookupAnswer[] = [];
    const run = vi.fn<Run>(async (_cmd, args) => (args[0] === "api" ? { code: 0, stdout: "hmcts\n", stderr: "" } : { code: 0, stdout: REPOS, stderr: "" }));
    const runner = createLookupRunner({
      api: {
        putLookup: async (_va, _id, body) => {
          answers.push(body);
          return null;
        }
      },
      id: "va-1",
      env: {},
      run,
      login: async () => true
    });

    // Act
    runner.lookup({ lookup_id: "5b0e7c1a-1111-4222-8333-444455556661", kind: "github_repo", query: "cft" });
    await runner.idle();
    runner.lookup({ lookup_id: "5b0e7c1a-1111-4222-8333-444455556662", kind: "github_repo", query: "ccd" });
    await runner.idle();

    // Assert
    expect(answers).toHaveLength(2);
    expect(run.mock.calls.filter((call) => call[1][0] === "api")).toHaveLength(2);
  });
});

describe("createLookupRunner", () => {
  it("should answer a waiting lookup superseded when a newer one of its kind arrives, and run at most two at once", async () => {
    // Arrange
    const answers: { id: string; body: LookupAnswer }[] = [];
    const releases: (() => void)[] = [];
    const run = vi.fn<Run>(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ code: 0, stdout: JIRA_OUTPUT, stderr: "" }));
        })
    );
    const runner = createLookupRunner({
      api: {
        putLookup: async (_va, id, body) => {
          answers.push({ id, body });
          return null;
        }
      },
      id: "va-1",
      env: {},
      run,
      login: async () => true
    });
    const id = (n: number) => `5b0e7c1a-1111-4222-8333-44445555666${n}`;

    // Act
    for (const n of [1, 2, 3, 4]) {
      runner.lookup({ lookup_id: id(n), kind: "jira_project", query: `vibe ${n}`, space: null });
    }
    await Promise.resolve();
    const runningAtOnce = run.mock.calls.length;
    for (const release of releases.splice(0)) {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases.splice(0)) {
      release();
    }
    await runner.idle();

    // Assert
    expect(runningAtOnce).toBe(2);
    expect(answers.find((a) => a.id === id(3))?.body).toEqual({ error: "superseded" });
    expect(answers.filter((a) => "results" in a.body).map((a) => a.id)).toEqual([id(1), id(2), id(4)]);
  });

  it("should ignore a frame that is not a lookup", () => {
    // Arrange
    const say = vi.fn();
    const run = vi.fn<Run>();
    const runner = createLookupRunner({ api: { putLookup: async () => null }, id: "va-1", env: {}, run, login: async () => true, say });

    // Act
    runner.lookup({ lookup_id: "x", kind: "jira_project", query: "vibe" });

    // Assert
    expect(run).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/ignoring a lookup/));
  });
});
