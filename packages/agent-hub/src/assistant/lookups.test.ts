import { afterEach, describe, expect, it, vi } from "vitest";
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
  type SpaceCache,
  searchWords,
  spaceArgs,
  spaceKeyOf,
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

// Cut down from what `twg confluence space list --keys=~saz.ali` (twg 1.3.9) prints for a personal space.
const PERSONAL_SPACES_OUTPUT = JSON.stringify({
  apiVersion: "v2",
  command: "confluence.space.list",
  data: [{ id: "275349639", spaceId: "275349639", name: "Saz Ali", key: "~saz.ali", type: "personal", status: "current" }]
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

// What twg 1.3.9 prints when Atlassian answers 401 to a sign-in twg still holds, cut down.
const REJECTED_SIGN_IN = {
  code: 1,
  stdout: JSON.stringify({
    ok: false,
    error: { code: "TWG_TOOL_EXECUTION_FAILED", kind: "twg_tool_execution_failed", message: "Unauthorized", statusCode: 401 }
  }),
  stderr: ""
};

const SIGNED_OUT = { code: 77, stdout: JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "authentication required." } }), stderr: "" };

function frame(overrides: Partial<LookupFrame> = {}): LookupFrame {
  return { lookup_id: LOOKUP, kind: "confluence_page", query: "case flags", space: null, owner: null, sign_in: false, ...overrides };
}

/** The answers one runner gives to two lookups of `kind`, the second sent once the first is answered. */
async function answersToTwoLookups(run: Run, kind: LookupFrame["kind"], queries: [string, string]): Promise<LookupAnswer[]> {
  const answers: LookupAnswer[] = [];
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
  for (const [n, query] of queries.entries()) {
    runner.lookup({ lookup_id: `5b0e7c1a-1111-4222-8333-44445555666${n + 1}`, kind, query });
    await runner.idle();
  }
  return answers;
}

describe("parseLookupFrame", () => {
  it("should keep a lookup when every value is one the hub would send", () => {
    // Act & Assert
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "confluence_page", query: "flags", space: "CCD", sign_in: false })).toEqual(
      frame({ query: "flags", space: "CCD" })
    );
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "jira_project", query: "vibe", space: "CCD" })?.space).toBeNull();
  });

  it("should keep a Confluence lookup narrowed to a personal space when the key is its owner's email address", () => {
    // Act & Assert
    expect(parseLookupFrame({ ...frame(), space: "~Martin.Fox1@justice.gov.uk" })?.space).toBe("~Martin.Fox1@justice.gov.uk");
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

describe("spaceKeyOf", () => {
  it("should take the key from the page's own space link when it has one", () => {
    // Act & Assert
    expect(spaceKeyOf({ ...PAGE_RESULT, resultGlobalContainer: { displayUrl: "/spaces/OTHER" } })).toBe("PEG");
  });

  it("should take the key from the result's container when the page does not name its space", () => {
    // Act & Assert
    expect(spaceKeyOf({ content: { _expandable: {} }, resultGlobalContainer: { displayUrl: "/spaces/PEG" } })).toBe("PEG");
  });

  it("should take a personal space's key when its owner's username is an email address", () => {
    // Act & Assert
    expect(spaceKeyOf({ content: { _expandable: { space: "/rest/api/space/~Martin.Fox1@justice.gov.uk" } } })).toBe("~Martin.Fox1@justice.gov.uk");
  });

  it.each([
    [{}],
    [{ content: { _expandable: { space: "/rest/api/space/" } } }],
    [{ resultGlobalContainer: { displayUrl: '/spaces/A" OR space = "B' } }],
    [null]
  ])("should give null when the result is %j", (result) => {
    // Act & Assert
    expect(spaceKeyOf(result)).toBeNull();
  });
});

describe("parsing what twg found", () => {
  it("should keep only pages, with their space's key, when Confluence answers a search", () => {
    // Act
    const hits = parseConfluenceHits(confluenceOutput([PAGE_RESULT, { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, type: "blogpost" } }]));

    // Assert
    expect(hits).toEqual([{ id: "280959611", title: "CP AI Assistant - Technical Specification", space_key: "PEG", excerpt: "1. System Architecture" }]);
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
      content: { ...PAGE_RESULT.content, _expandable: { space: "/rest/api/space/~patrick.o'sullivan" } },
      resultGlobalContainer: { title: "Patrick", displayUrl: "/spaces/~patrick.o'sullivan" }
    };

    // Act & Assert
    expect(parseConfluenceHits(confluenceOutput([result]))).toEqual([]);
  });

  it("should give every page the space it was narrowed to when the search was narrowed", () => {
    // Arrange
    const result = { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, _expandable: {} }, resultGlobalContainer: {} };

    // Act & Assert
    expect(parseConfluenceHits(confluenceOutput([result]), "CCD")?.[0]?.space_key).toBe("CCD");
  });

  it("should keep a page's opening words as plain text, cut short, when the search gives an excerpt", () => {
    // Arrange
    const result = { ...PAGE_RESULT, excerpt: `Overview &amp; \n  &quot;scope&quot; &#39;now&#39;  ${"x".repeat(300)}` };

    // Act
    const [hit] = parseConfluenceHits(confluenceOutput([result])) ?? [];

    // Assert
    expect(hit?.excerpt?.startsWith(`Overview & "scope" 'now' xxx`)).toBe(true);
    expect(hit?.excerpt).toHaveLength(160);
    expect(hit?.excerpt?.endsWith("…")).toBe(true);
    expect(parseConfluenceHits(confluenceOutput([{ ...PAGE_RESULT, excerpt: "  " }]))?.[0]?.excerpt).toBeNull();
  });

  it("should give each page its space's id and name, and its opening words, when its space was read", () => {
    // Arrange
    const hits = parseConfluenceHits(confluenceOutput([PAGE_RESULT])) ?? [];
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
        ancestors: [],
        excerpt: "1. System Architecture"
      }
    ]);
  });

  it("should leave a page out when its space was not read", () => {
    // Arrange
    const hits =
      parseConfluenceHits(confluenceOutput([{ ...PAGE_RESULT, content: { ...PAGE_RESULT.content, _expandable: { space: "/rest/api/space/HR" } } }])) ?? [];

    // Act & Assert
    expect(confluencePages(hits, parseConfluenceSpaces(SPACES_OUTPUT) ?? new Map())).toEqual([]);
  });

  it("should find a page's space whatever the case of its key, and answer the key as Confluence spells it", () => {
    // Arrange
    const hits = [{ id: "280959611", title: "Specification", space_key: "peg", excerpt: null }];

    // Act
    const [page] = confluencePages(hits, parseConfluenceSpaces(SPACES_OUTPUT) ?? new Map());

    // Assert
    expect(page).toMatchObject({ space_id: "280952876", space_key: "PEG" });
    expect(page).not.toHaveProperty("excerpt");
  });

  it("should read a personal space's key, id and name when its owner's username has dots", () => {
    // Act & Assert
    expect(parseConfluenceSpaces(PERSONAL_SPACES_OUTPUT)?.get("~saz.ali")).toEqual({ key: "~saz.ali", id: "275349639", name: "Saz Ali" });
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
    expect(twgSignedOut({ code: 1, stdout: twgError("Bad request"), stderr: "" })).toBe(false);
  });

  it("should count a sign-in as missing when Atlassian answers 401 to the one twg holds", () => {
    // Act & Assert
    expect(twgSignedOut(REJECTED_SIGN_IN)).toBe(true);
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

  it("should read only the spaces it does not already know, and remember the ones it read", async () => {
    // Arrange
    const d = deps({
      "confluence search query": {
        code: 0,
        stdout: confluenceOutput([
          PAGE_RESULT,
          { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, id: "1234567", _expandable: { space: "/rest/api/space/~saz.ali" } } }
        ]),
        stderr: ""
      },
      "confluence space list": { code: 0, stdout: PERSONAL_SPACES_OUTPUT, stderr: "" }
    });
    const spaces: SpaceCache = new Map([["peg", { key: "PEG", id: "280952876", name: "Platform Engineering" }]]);

    // Act
    const answer = await runLookup({ ...d, spaces }, frame());

    // Assert
    expect(answer).toMatchObject({ results: [{ space_key: "PEG" }, { id: "1234567", space_id: "275349639", space_key: "~saz.ali", space_name: "Saz Ali" }] });
    expect(d.run.mock.calls[1]?.[1]).toContain("--keys=~saz.ali");
    expect(spaces.has("~saz.ali")).toBe(true);
  });

  it("should answer the pages whose spaces it knows, and leave out the rest, when only some spaces could be read", async () => {
    // Arrange
    const d = deps({
      "confluence search query": {
        code: 0,
        stdout: confluenceOutput([
          PAGE_RESULT,
          { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, id: "1234567", _expandable: { space: "/rest/api/space/HR" } } }
        ]),
        stderr: ""
      },
      "confluence space list": { code: 0, stdout: SPACES_OUTPUT, stderr: "" }
    });

    // Act & Assert
    expect(await runLookup(d, frame())).toMatchObject({ results: [{ id: "280959611" }] });
  });

  it("should say so rather than answer nothing when Confluence lists none of the spaces the pages are in", async () => {
    // Arrange
    const d = deps({
      "confluence search query": { code: 0, stdout: confluenceOutput([PAGE_RESULT]), stderr: "" },
      "confluence space list": { code: 0, stdout: JSON.stringify({ data: [] }), stderr: "" }
    });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "failed", detail: expect.stringMatching(/did not say which spaces/) });
  });

  it("should take each page's space from the frame when the search was narrowed to it", async () => {
    // Arrange
    const d = deps({
      "confluence search query": {
        code: 0,
        stdout: confluenceOutput([{ ...PAGE_RESULT, content: { ...PAGE_RESULT.content, _expandable: {} }, resultGlobalContainer: {} }]),
        stderr: ""
      },
      "confluence space list": { code: 0, stdout: SPACES_OUTPUT, stderr: "" }
    });

    // Act & Assert
    expect(await runLookup(d, frame({ space: "PEG" }))).toMatchObject({ results: [{ id: "280959611", space_key: "PEG" }] });
  });

  it("should take the page's space from the search when a page id is looked up in a narrowed panel", async () => {
    // Arrange
    const d = deps({
      "confluence search query": { code: 0, stdout: confluenceOutput([PAGE_RESULT]), stderr: "" },
      "confluence space list": { code: 0, stdout: SPACES_OUTPUT, stderr: "" }
    });

    // Act
    await runLookup(d, frame({ query: "280959611", space: "CCD" }));

    // Assert
    expect(d.run.mock.calls[1]?.[1]).toContain("--keys=PEG");
  });

  it("should answer signed_out when Atlassian refuses twg's sign-in with a 401", async () => {
    // Arrange
    const d = deps({ confluence: REJECTED_SIGN_IN });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "signed_out" });
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

describe("runLookup's time limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A search that takes `ms` of the clock, answering `stdout`; every other twg call answers the spaces.
  function slowSearch(ms: number, stdout: string) {
    return vi.fn<Run>(async (_cmd, args) => {
      if (args[1] === "search") {
        vi.setSystemTime(Date.now() + ms);
        return { code: 0, stdout, stderr: "" };
      }
      return { code: 0, stdout: SPACES_OUTPUT, stderr: "" };
    });
  }

  it("should give the space list only what is left of the search's 8 seconds when the search was slow", async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ["Date"] });
    const run = slowSearch(5000, confluenceOutput([PAGE_RESULT]));

    // Act
    const answer = await runLookup({ run, env: {}, login: async () => true }, frame());

    // Assert
    expect(answer).toMatchObject({ results: [{ id: "280959611" }] });
    expect(run.mock.calls[0]?.[2].timeoutMs).toBe(8000);
    expect(run.mock.calls[1]?.[2].timeoutMs).toBe(3000);
  });

  it("should not start the space list, and say the search ran out of time, when under a second is left", async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ["Date"] });
    const run = slowSearch(7500, confluenceOutput([PAGE_RESULT]));

    // Act
    const answer = await runLookup({ run, env: {}, login: async () => true }, frame());

    // Assert
    expect(answer).toEqual({ error: "failed", detail: "Confluence did not answer in time. Try again in a moment." });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("should answer the pages in spaces it already knows when there is no time left to read the others", async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ["Date"] });
    const other = { ...PAGE_RESULT, content: { ...PAGE_RESULT.content, id: "1234567", _expandable: { space: "/rest/api/space/HR" } } };
    const run = slowSearch(7500, confluenceOutput([PAGE_RESULT, other]));
    const spaces: SpaceCache = new Map([["peg", { key: "PEG", id: "280952876", name: "Platform Engineering" }]]);

    // Act
    const answer = await runLookup({ run, env: {}, login: async () => true, spaces }, frame());

    // Assert
    expect(answer).toMatchObject({ results: [{ id: "280959611", space_id: "280952876" }] });
    expect(run).toHaveBeenCalledTimes(1);
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
    const run = vi.fn<Run>(async (_cmd, args) => (args[0] === "api" ? { code: 0, stdout: "hmcts\n", stderr: "" } : { code: 0, stdout: REPOS, stderr: "" }));

    // Act
    const answers = await answersToTwoLookups(run, "github_repo", ["cft", "ccd"]);

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

  it("should read each Confluence space once for every search a runner makes", async () => {
    // Arrange
    const run = vi.fn<Run>(async (_cmd, args) => ({ code: 0, stdout: args[1] === "search" ? confluenceOutput([PAGE_RESULT]) : SPACES_OUTPUT, stderr: "" }));

    // Act
    const answers = await answersToTwoLookups(run, "confluence_page", ["spec", "assistant"]);

    // Assert
    expect(answers).toEqual([
      { results: [expect.objectContaining({ space_id: "280952876" })] },
      { results: [expect.objectContaining({ space_id: "280952876" })] }
    ]);
    expect(run.mock.calls.filter((call) => call[1][1] === "space")).toHaveLength(1);
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
