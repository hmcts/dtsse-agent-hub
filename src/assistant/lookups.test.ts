import { describe, expect, it } from "vitest";
import { breadcrumb, checkResults, lookupAnswerBody, lookupQuery, lookupResponse, lookupResults, MAX_LOOKUP_RESULTS, searchable } from "./lookups.ts";

const PAGE = {
  id: "280959611",
  title: "Technical spec",
  space_id: "280952876",
  space_key: "PEG",
  space_name: "Platform Engineering",
  ancestors: ["Platform Engineering", "Products"]
};

describe("lookupQuery and searchable", () => {
  it("should trim, squash spaces and cut the query when it is stored", () => {
    expect(lookupQuery("  case   flags \n")).toBe("case flags");
    expect(lookupQuery("x".repeat(150))).toHaveLength(100);
    expect(lookupQuery(42)).toBe("");
  });

  it.each([
    ["a", false],
    ["--", false],
    ["ab", true],
    ["é1", true]
  ])("should answer %j as %s when deciding whether it is worth a search", (query, expected) => {
    expect(searchable(query)).toBe(expected);
  });
});

describe("lookupAnswerBody and checkResults", () => {
  it("should accept results or a known error when the pod answers", () => {
    expect(lookupAnswerBody.safeParse({ results: [PAGE] }).success).toBe(true);
    expect(lookupAnswerBody.safeParse({ error: "signed_out" }).success).toBe(true);
    expect(lookupAnswerBody.safeParse({ error: "failed", detail: "Confluence said no" }).success).toBe(true);
  });

  it.each([
    [{ results: Array.from({ length: MAX_LOOKUP_RESULTS + 1 }, () => PAGE) }],
    [{ error: "nope" }],
    [{ results: [], error: "failed" }],
    [{ error: "failed", detail: "x".repeat(301) }]
  ])("should refuse %j when it breaks the contract", (body) => {
    expect(lookupAnswerBody.safeParse(body).success).toBe(false);
  });

  it("should refuse results of the wrong kind, or with a field the contract does not name, when checked against the lookup", () => {
    expect(checkResults("confluence_page", [PAGE])).toEqual([PAGE]);
    expect(checkResults("jira_project", [PAGE])).toBeUndefined();
    expect(checkResults("confluence_page", [{ ...PAGE, url: "https://evil.example" }])).toBeUndefined();
    expect(checkResults("confluence_page", [{ ...PAGE, id: "12; DROP" }])).toBeUndefined();
    expect(checkResults("jira_project", [{ key: "VIBE", name: "Vibe-Coding Enablement" }])).toEqual([{ key: "VIBE", name: "Vibe-Coding Enablement" }]);
  });
});

describe("lookupResults", () => {
  it("should build each link from the ids on the HMCTS site when results are shown", () => {
    expect(lookupResults("confluence_page", [PAGE])).toEqual([{ ...PAGE, url: "https://hmcts.atlassian.net/wiki/spaces/PEG/pages/280959611" }]);
    expect(lookupResults("jira_project", [{ key: "VIBE", name: "Vibe" }])).toEqual([
      { key: "VIBE", name: "Vibe", url: "https://hmcts.atlassian.net/browse/VIBE" }
    ]);
  });

  it("should show nothing when what is stored is not what the kind answers", () => {
    expect(lookupResults("jira_project", [PAGE])).toEqual([]);
    expect(lookupResults("jira_project", null)).toEqual([]);
  });
});

describe("lookupResponse", () => {
  const row = { kind: "confluence_page", status: "pending", results: null, error: null, detail: null };

  it("should be nothing yet while the pod has not answered", () => {
    expect(lookupResponse(row)).toBeUndefined();
  });

  it.each([
    [
      { status: "done", results: [PAGE] },
      { status: "done", results: lookupResults("confluence_page", [PAGE]) }
    ],
    [{ status: "failed", error: "signed_out" }, { status: "signed_out" }],
    [
      { status: "failed", error: "superseded" },
      { status: "done", results: [] }
    ],
    [
      { status: "failed", error: "failed", detail: "Confluence is down" },
      { status: "failed", detail: "Confluence is down" }
    ],
    [
      { status: "failed", error: "failed" },
      { status: "failed", detail: "The search did not work. Try again." }
    ]
  ])("should answer %j as %j when the pod has answered", (change, expected) => {
    expect(lookupResponse({ ...row, ...change })).toEqual(expected);
  });
});

describe("breadcrumb", () => {
  it("should say the space once when its top page is named after it", () => {
    expect(breadcrumb({ ...PAGE, title: "Spec" })).toEqual(["Platform Engineering", "Products", "Spec"]);
    expect(breadcrumb({ space_name: "CCD", ancestors: ["Home", "Guides"], title: "Flags" })).toEqual(["CCD", "Home", "Guides", "Flags"]);
  });
});
