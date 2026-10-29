import { describe, expect, it } from "vitest";
import {
  CONFLUENCE_EXPORT_TIMEOUT_MS,
  type ConfluenceExportRow,
  checkParent,
  confluenceExportRequest,
  confluenceExportView,
  DEFAULT_CONFLUENCE_PARENT,
  pendingConfluenceExport
} from "./confluence.ts";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const EXPORT = "33333333-3333-4333-8333-333333333333";
const PARENT = { id: "280959611", title: "Guides", space_id: "280952876", space_key: "CCD", space_name: "Core Case Data" };

function row(overrides: Partial<ConfluenceExportRow> = {}): ConfluenceExportRow {
  return {
    confluenceExportId: null,
    confluenceSpaceId: null,
    confluenceSpaceKey: null,
    confluenceSpaceName: null,
    confluenceParentId: null,
    confluenceParentTitle: null,
    confluenceStatus: null,
    confluencePageId: null,
    confluencePageTitle: null,
    confluenceError: null,
    confluenceRequestedAt: null,
    ...overrides
  };
}

const asked = row({
  confluenceExportId: EXPORT,
  confluenceSpaceId: PARENT.space_id,
  confluenceSpaceKey: PARENT.space_key,
  confluenceSpaceName: PARENT.space_name,
  confluenceParentId: PARENT.id,
  confluenceParentTitle: PARENT.title,
  confluenceStatus: "pending",
  confluenceRequestedAt: new Date(NOW.getTime() - 60_000)
});

describe("checkParent", () => {
  it("should keep a parent page, its spaces squashed, when every field is one", () => {
    expect(checkParent({ ...PARENT, title: "  Guides  for   all " })).toEqual({ ...PARENT, title: "Guides for all" });
    const { ancestors: _, ...builtIn } = DEFAULT_CONFLUENCE_PARENT;
    expect(checkParent(DEFAULT_CONFLUENCE_PARENT)).toEqual(builtIn);
  });

  it.each([[{ id: "../1" }], [{ space_id: "CCD" }], [{ space_key: 'CCD" OR 1=1' }], [{ title: " " }], [{ title: "x".repeat(256) }], [{ space_name: 3 }]])(
    "should refuse a parent with %j when it is not one the search could have found",
    (change) => {
      expect(checkParent({ ...PARENT, ...change })).toBeUndefined();
    }
  );

  it("should refuse something that is not an object", () => {
    expect(checkParent(null)).toBeUndefined();
    expect(checkParent("280959611")).toBeUndefined();
  });
});

describe("confluenceExportView", () => {
  it("should offer the export when the document has never been exported", () => {
    expect(confluenceExportView(row(), NOW)).toEqual({ status: "none" });
  });

  it("should be pending, with when it was asked, until the timeout", () => {
    expect(confluenceExportView(asked, NOW)).toEqual({
      status: "pending",
      parentTitle: "Guides",
      spaceName: "Core Case Data",
      requestedAt: asked.confluenceRequestedAt?.toISOString()
    });
  });

  it("should count as failed, so it can be tried again, past the timeout", () => {
    const late = { ...asked, confluenceRequestedAt: new Date(NOW.getTime() - CONFLUENCE_EXPORT_TIMEOUT_MS - 1000) };

    expect(confluenceExportView(late, NOW)).toEqual({
      status: "failed",
      place: { parentTitle: "Guides", spaceName: "Core Case Data" },
      error: "Confluence did not answer in time. Try again."
    });
  });

  it("should show the page and the link the hub builds when the pod reported its id", () => {
    expect(confluenceExportView({ ...asked, confluenceStatus: "done", confluencePageId: "300000001", confluencePageTitle: "Guide" }, NOW)).toEqual({
      status: "done",
      pageId: "300000001",
      pageTitle: "Guide",
      url: "https://hmcts.atlassian.net/wiki/spaces/CCD/pages/300000001",
      parentTitle: "Guides",
      spaceName: "Core Case Data"
    });
  });

  it("should name the space by its key when a done export has no place recorded", () => {
    expect(confluenceExportView(row({ confluencePageId: "1", confluenceSpaceKey: "CCD" }), NOW)).toMatchObject({ parentTitle: "", spaceName: "CCD" });
  });

  it("should show the pod's reason, or a plain one, when the export failed", () => {
    expect(confluenceExportView({ ...asked, confluenceStatus: "failed", confluenceError: "No permission" }, NOW)).toMatchObject({
      status: "failed",
      error: "No permission"
    });
    expect(confluenceExportView(row({ confluenceStatus: "failed" }), NOW)).toEqual({ status: "failed", place: null, error: "The page could not be created." });
  });
});

describe("pendingConfluenceExport", () => {
  it("should give the session where to create the page and the id to report it under when an export is pending", () => {
    expect(pendingConfluenceExport(asked, NOW)).toEqual({ export_id: EXPORT, space_id: PARENT.space_id, parent_id: PARENT.id });
  });

  it.each([
    ["reported", { confluenceStatus: "done", confluencePageId: "1" }],
    ["failed", { confluenceStatus: "failed" }],
    ["missing its parent", { confluenceParentId: null }],
    ["timed out", { confluenceRequestedAt: new Date(NOW.getTime() - CONFLUENCE_EXPORT_TIMEOUT_MS - 1000) }]
  ])("should give nothing when the export has %s", (_, change) => {
    expect(pendingConfluenceExport({ ...asked, ...change }, NOW)).toBeUndefined();
  });
});

describe("confluenceExportRequest", () => {
  it("should ask in the person's words for the page under the parent they picked", () => {
    expect(confluenceExportRequest(PARENT)).toBe('Please publish this document to Confluence, under "Guides" in Core Case Data.');
  });
});
