import { describe, expect, it, vi } from "vitest";
import type { LookupAnswer } from "../api.ts";
import {
  confluenceCql,
  createLookupRunner,
  type LookupFrame,
  lookupArgs,
  pageIdOf,
  parseConfluencePages,
  parseJiraProjects,
  parseLookupFrame,
  type Run,
  runLookup,
  searchWords,
  twgSignedOut
} from "./lookups.ts";

const LOOKUP = "5b0e7c1a-1111-4222-8333-444455556666";

// Cut down from what `twg api confluence:/wiki/rest/api/search … -o json --output-summary=none` (twg 1.3.3) prints.
function confluenceOutput(results: unknown[]): string {
  return JSON.stringify({ apiVersion: "v2", command: "api", data: { status: 200, statusText: "", headers: {}, body: { results, size: results.length } } });
}

const PAGE_RESULT = {
  content: {
    id: "280959611",
    type: "page",
    status: "current",
    title: "CP AI Assistant - Technical Specification",
    space: { id: 280952876, key: "PEG", name: "Platform Engineering", type: "global" },
    ancestors: [
      { id: "280952878", type: "page", title: "Platform Engineering" },
      { id: "352814743", type: "folder", title: "OLD PAGES PRE OCT 2026" }
    ],
    _links: { webui: "/spaces/PEG/pages/280959611/CP+AI+Assistant" }
  },
  title: "CP AI Assistant - Technical Specification",
  excerpt: "1. System Architecture"
};

const JIRA_OUTPUT = JSON.stringify({
  data: { status: 200, body: { total: 1, values: [{ id: "10120", key: "VIBE", name: "Vibe-Coding Enablement", projectTypeKey: "software" }] } }
});

const SIGNED_OUT = { code: 77, stdout: JSON.stringify({ ok: false, error: { code: "AUTH_REQUIRED", message: "authentication required." } }), stderr: "" };

function frame(overrides: Partial<LookupFrame> = {}): LookupFrame {
  return { lookup_id: LOOKUP, kind: "confluence_page", query: "case flags", space: null, sign_in: false, ...overrides };
}

describe("parseLookupFrame", () => {
  it("should keep a lookup when every value is one the hub would send", () => {
    // Act & Assert
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "confluence_page", query: "flags", space: "CCD", sign_in: false })).toEqual(
      frame({ query: "flags", space: "CCD" })
    );
    expect(parseLookupFrame({ lookup_id: LOOKUP, kind: "jira_project", query: "vibe", space: "CCD" })?.space).toBeNull();
  });

  it.each([
    [{ lookup_id: "not-an-id" }],
    [{ kind: "people" }],
    [{ query: 4 }],
    [{ query: "x".repeat(101) }],
    [{ space: 'CCD" OR space = "HR' }]
  ])("should drop the lookup when it has %j, since its values go into a search", (change) => {
    // Act & Assert
    expect(parseLookupFrame({ ...frame(), ...change })).toBeNull();
  });
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
      "api",
      "confluence:/wiki/rest/api/search",
      "-X",
      "GET",
      "-f",
      'cql=type = page AND space = "PEG" AND title ~ "case* flags*"',
      "-f",
      "limit=10",
      "-f",
      "expand=content.ancestors,content.space",
      "-o",
      "json",
      "--output-summary=none"
    ]);
    expect(jira).toEqual([
      "api",
      "jira:/rest/api/3/project/search",
      "-X",
      "GET",
      "-f",
      "query=vibe coding",
      "-f",
      "maxResults=10",
      "-o",
      "json",
      "--output-summary=none"
    ]);
  });
});

describe("parsing what twg found", () => {
  it("should keep only the fields the hub accepts when Confluence answers", () => {
    // Act
    const pages = parseConfluencePages(confluenceOutput([PAGE_RESULT, { content: { ...PAGE_RESULT.content, type: "blogpost" } }]));

    // Assert
    expect(pages).toEqual([
      {
        id: "280959611",
        title: "CP AI Assistant - Technical Specification",
        space_id: "280952876",
        space_key: "PEG",
        space_name: "Platform Engineering",
        ancestors: ["Platform Engineering", "OLD PAGES PRE OCT 2026"]
      }
    ]);
  });

  it("should keep the nearest ancestors when a page is deeper than the hub keeps", () => {
    // Arrange
    const ancestors = Array.from({ length: 12 }, (_, index) => ({ title: `Level ${index}` }));

    // Act
    const [page] = parseConfluencePages(confluenceOutput([{ content: { ...PAGE_RESULT.content, ancestors } }])) ?? [];

    // Assert
    expect(page?.ancestors).toEqual(["Level 4", "Level 5", "Level 6", "Level 7", "Level 8", "Level 9", "Level 10", "Level 11"]);
  });

  it("should keep a project's key and name when Jira answers", () => {
    // Act & Assert
    expect(parseJiraProjects(JIRA_OUTPUT)).toEqual([{ key: "VIBE", name: "Vibe-Coding Enablement" }]);
  });

  it("should give nothing for an answer that is not a successful search", () => {
    // Act & Assert
    expect(parseConfluencePages("not json")).toBeNull();
    expect(parseJiraProjects(JSON.stringify({ data: { status: 400, body: { message: "bad" } } }))).toBeNull();
  });

  it("should tell a missing sign-in from any other failure", () => {
    // Act & Assert
    expect(twgSignedOut(SIGNED_OUT)).toBe(true);
    expect(twgSignedOut({ code: 1, stdout: "{}", stderr: "boom" })).toBe(false);
  });
});

describe("runLookup", () => {
  function deps(results: Record<string, { code: number; stdout: string; stderr: string }>, login = vi.fn(async () => true)) {
    const run = vi.fn<Run>(async (_cmd, args) => results[args[0] as string] ?? { code: 0, stdout: "", stderr: "" });
    return { run, login, env: {} };
  }

  it("should answer what Confluence found when twg is signed in", async () => {
    // Arrange
    const d = deps({ api: { code: 0, stdout: confluenceOutput([PAGE_RESULT]), stderr: "" } });

    // Act
    const answer = await runLookup(d, frame());

    // Assert
    expect(answer).toMatchObject({ results: [{ id: "280959611", space_key: "PEG" }] });
    expect(d.run).toHaveBeenCalledWith("twg", expect.arrayContaining(["confluence:/wiki/rest/api/search"]), { env: {}, timeoutMs: expect.any(Number) });
    expect(d.login).not.toHaveBeenCalled();
  });

  it("should answer signed_out, without signing in, when twg has no sign-in and nobody asked for one", async () => {
    // Arrange
    const d = deps({ api: SIGNED_OUT });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "signed_out" });
    expect(d.login).not.toHaveBeenCalled();
  });

  it("should sign in first and then search when the person asked to sign in", async () => {
    // Arrange
    const d = deps({ whoami: SIGNED_OUT, api: { code: 0, stdout: JIRA_OUTPUT, stderr: "" } });

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
    const d = deps({ api: { code: 1, stdout: JSON.stringify({ data: { status: 400, body: { message: "Could not parse cql" } } }), stderr: "" } });

    // Act & Assert
    expect(await runLookup(d, frame())).toEqual({ error: "failed", detail: "Confluence could not search that: Could not parse cql" });
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
