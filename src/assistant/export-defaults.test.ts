import { describe, expect, it } from "vitest";
import {
  checkConfluenceDefault,
  checkGithubDefault,
  checkJiraDefault,
  checkTicketTool,
  type ExportDefaultRow,
  exportDefaultsOf,
  NO_DEFAULTS
} from "./export-defaults.ts";
import { MAX_LOOKUP_ANCESTORS } from "./lookups.ts";

const PAGE = {
  id: "286130747",
  title: "AI Resources",
  space_id: "286130187",
  space_key: "CATHAI",
  space_name: "CaTH AI Project",
  ancestors: ["CaTH AI Project Home"]
};

const ROW: ExportDefaultRow = {
  jiraProject: "HDPI",
  jiraProjectName: "Housing Disputes",
  confluenceParentId: PAGE.id,
  confluenceParentTitle: PAGE.title,
  confluenceSpaceId: PAGE.space_id,
  confluenceSpaceKey: PAGE.space_key,
  confluenceSpaceName: PAGE.space_name,
  confluenceAncestors: PAGE.ancestors
};

describe("checkJiraDefault", () => {
  it("should give no default when the browser sent null", () => {
    expect(checkJiraDefault(null)).toBeNull();
  });

  it("should keep the key and tidy the name when the project is well formed", () => {
    expect(checkJiraDefault({ key: "HDPI", name: "  Housing \n Disputes " })).toEqual({ key: "HDPI", name: "Housing Disputes" });
  });

  it.each([
    ["the value is not an object", "HDPI"],
    ["the key is missing", { name: "Housing Disputes" }],
    ["the key is not a Jira project key", { key: "hdpi", name: "Housing Disputes" }],
    ["the name is missing", { key: "HDPI" }],
    ["the name is only spaces", { key: "HDPI", name: "   " }],
    ["the name is too long", { key: "HDPI", name: "x".repeat(201) }]
  ])("should refuse the project when %s", (_label, value) => {
    expect(checkJiraDefault(value)).toBeUndefined();
  });

  it("should accept a name when it is exactly the longest allowed", () => {
    expect(checkJiraDefault({ key: "HDPI", name: "x".repeat(200) })).toEqual({ key: "HDPI", name: "x".repeat(200) });
  });
});

describe("checkConfluenceDefault", () => {
  it("should give no default when the browser sent null", () => {
    expect(checkConfluenceDefault(null)).toBeNull();
  });

  it("should keep the page and trim the titles above it when the page is well formed", () => {
    expect(checkConfluenceDefault({ ...PAGE, ancestors: [" Home ", "Team"] })).toEqual({ ...PAGE, ancestors: ["Home", "Team"] });
  });

  it("should give the page no titles above it when none were sent", () => {
    const { ancestors: _ancestors, ...withoutAncestors } = PAGE;

    expect(checkConfluenceDefault(withoutAncestors)).toEqual({ ...PAGE, ancestors: [] });
  });

  it.each([
    ["the page is not one checkParent accepts", { ...PAGE, id: "not-a-number" }],
    ["the titles above it are not a list", { ...PAGE, ancestors: "Home" }],
    ["there are more titles above it than a lookup reads", { ...PAGE, ancestors: Array.from({ length: MAX_LOOKUP_ANCESTORS + 1 }, (_, i) => `Page ${i}`) }],
    ["a title above it is not text", { ...PAGE, ancestors: [7] }],
    ["a title above it is blank", { ...PAGE, ancestors: ["  "] }],
    ["a title above it is too long", { ...PAGE, ancestors: ["x".repeat(256)] }]
  ])("should refuse the page when %s", (_label, value) => {
    expect(checkConfluenceDefault(value)).toBeUndefined();
  });

  it("should accept the titles above it when there are as many as a lookup reads", () => {
    const ancestors = Array.from({ length: MAX_LOOKUP_ANCESTORS }, (_, i) => `Page ${i}`);

    expect(checkConfluenceDefault({ ...PAGE, ancestors })?.ancestors).toEqual(ancestors);
  });
});

describe("exportDefaultsOf", () => {
  it("should give no defaults when the person has no row", () => {
    expect(exportDefaultsOf(null)).toBe(NO_DEFAULTS);
  });

  it("should give both defaults when the row holds both whole", () => {
    expect(exportDefaultsOf(ROW)).toEqual({ ticketTool: "jira", jira: { key: "HDPI", name: "Housing Disputes" }, github: null, confluence: PAGE });
  });

  it("should give neither default when the row holds neither", () => {
    expect(exportDefaultsOf({ ...ROW, jiraProject: null, jiraProjectName: null, confluenceParentId: null, confluenceParentTitle: null })).toEqual(NO_DEFAULTS);
  });

  it("should name the project by its key when the row has no name for it", () => {
    expect(exportDefaultsOf({ ...ROW, jiraProjectName: null }).jira).toEqual({ key: "HDPI", name: "HDPI" });
  });

  it("should name the space by its key when the row has no name for it", () => {
    expect(exportDefaultsOf({ ...ROW, confluenceSpaceName: null }).confluence).toEqual({ ...PAGE, space_name: "CATHAI" });
  });

  it("should drop the Confluence half and keep the Jira half when the page is not whole", () => {
    expect(exportDefaultsOf({ ...ROW, confluenceParentTitle: null })).toEqual({
      ticketTool: "jira",
      jira: { key: "HDPI", name: "Housing Disputes" },
      github: null,
      confluence: null
    });
  });

  it("should drop the Confluence half when the stored titles above it are not a list", () => {
    expect(exportDefaultsOf({ ...ROW, confluenceAncestors: { not: "a list" } }).confluence).toBeNull();
  });
});

describe("the ticket tool and GitHub repository defaults", () => {
  it("should read GitHub and its repository when the row has them", () => {
    expect(exportDefaultsOf({ ...ROW, ticketTool: "github", githubRepo: "hmcts/cft-workspace" })).toMatchObject({
      ticketTool: "github",
      github: "hmcts/cft-workspace"
    });
  });

  it("should fall back to Jira and no repository when the row's values are not ones the hub writes", () => {
    expect(exportDefaultsOf({ ...ROW, ticketTool: "trello", githubRepo: "not a repo" })).toMatchObject({ ticketTool: "jira", github: null });
  });

  it("should accept only jira and github from the browser", () => {
    expect(checkTicketTool("github")).toBe("github");
    expect(checkTicketTool("trello")).toBeUndefined();
  });

  it.each([
    [null, null],
    ["  ", null],
    ["https://github.com/hmcts/cft-workspace", "hmcts/cft-workspace"],
    ["cft-workspace", undefined]
  ])("should read the repository %j as %j", (value, expected) => {
    expect(checkGithubDefault(value)).toBe(expected);
  });
});
