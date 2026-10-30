import { describe, expect, it } from "vitest";
import {
  applyView,
  importView,
  infoView,
  messageOf,
  safeLink,
  scanView,
  searchView,
  storyCandidatesView,
  storyPreviewView,
  storyWriteView
} from "./welsh-views.ts";

describe("the Welsh page's views", () => {
  it("should read a service's set-up, and show nothing for fields it does not have", () => {
    expect(
      infoView({
        initialised: true,
        repos: [{ path: "apps/cath/cath-service", staffOnly: ["x/**"] }, { path: 3 }],
        catalogue: { approved: 1123, needsReview: 94 },
        shared: { approved: 2 }
      })
    ).toEqual({ initialised: true, repos: ["apps/cath/cath-service"], skipsStaffPages: true, approved: 1123, needsReview: 94, sharedApproved: 2 });
    expect(infoView({})).toEqual({ initialised: false, repos: [], skipsStaffPages: false, approved: 0, needsReview: 0, sharedApproved: 0 });
  });

  it("should read search hits with their Welsh exactly as the catalogue has it", () => {
    expect(
      searchView({
        total: 1,
        hits: [{ id: "a", english: "Back", welsh: "Yn ôl", context: "", status: "approved", source: "WLU:x", catalogue: "cath", score: 1 }]
      })
    ).toEqual({
      total: 1,
      hits: [{ id: "a", english: "Back", welsh: "Yn ôl", context: "", status: "approved", source: "WLU:x", catalogue: "cath" }]
    });
    expect(searchView({ hits: "nope" })).toEqual({ total: 0, hits: [] });
  });

  it("should read a scan's counts and its three groups", () => {
    const view = scanView({
      summary: { total: 354, unique: 231, fromCatalogue: 49, ambiguous: 2, toWlu: 180 },
      ambiguous: [{ ref: "CY-1", english: "Yes", where: "a.ts", options: [{ id: "r1", welsh: "Ydw", context: "", source: "legacy" }] }],
      toWlu: [{ ref: "CY-2", english: "Upload", where: "b.ts" }],
      fromCatalogue: [{ ref: "CY-3", english: "Back", welsh: "Yn ôl", where: "c.ts" }]
    });
    expect(view).toMatchObject({ places: 354, unique: 231, fromCatalogue: 49, ambiguousCount: 2, toWluCount: 180 });
    expect(view.ambiguous[0]?.options[0]?.welsh).toBe("Ydw");
    expect(view.toWlu).toHaveLength(1);
    expect(view.filled[0]?.welsh).toBe("Yn ôl");
  });

  it("should read an import, an apply and the story steps", () => {
    expect(
      importView({ added: 3, problems: [{ row: 2, ref: "CY-1", english: "x", problem: "blank" }], pr: "https://github.com/hmcts/cft-workspace/pull/1" })
    ).toMatchObject({
      added: 3,
      problems: [{ row: 2, problem: "blank" }],
      pr: "https://github.com/hmcts/cft-workspace/pull/1"
    });
    expect(importView({ pr: "" }).pr).toBeNull();
    const applied = applyView({
      applied: 2,
      files: ["a/cy.ts", 4],
      skipped: [{ where: "w", english: "e", reason: "r" }],
      verify: { ok: true },
      diff: "+x",
      changes: [
        { page: "summary of publications", english: "Back", now: "Shows the English", welsh: "Yn ôl", source: "catalogue:cath legacy:x" },
        { page: "summary of publications", english: "Back", now: "Shows the English", welsh: "Yn ôl", source: "catalogue:cath legacy:x" },
        { page: "home", english: "Upload", now: "Missing", welsh: "Llwytho", source: "WLU:return-1" },
        { page: "home", english: "Yes", now: "Missing", welsh: "Ydw", source: "legacy (BA choice, row r)" },
        { page: "home", english: "Close", now: "Blank", welsh: "Cau", source: "catalogue:shared WLU:2" }
      ]
    });
    expect(applied).toMatchObject({ applied: 2, files: ["a/cy.ts"], pr: null, branch: null, diff: "+x", verified: true });
    expect(applied.pages.map((p) => [p.page, p.changes.map((c) => c.from)])).toEqual([
      ["summary of publications", ["Catalogue"]],
      ["home", ["Welsh unit return", "Your choice", "Shared catalogue"]]
    ]);
    expect(applyView({ files: "x" }).files).toEqual([]);
    expect(
      storyCandidatesView({ summary: "Story", url: "u", candidates: [{ english: "Upload", origin: "quoted" }, { english: "" }], existing: [{ ref: "CY-1" }] })
    ).toEqual({
      title: "Story",
      url: "u",
      candidates: [{ english: "Upload", origin: "quoted" }],
      existing: [{ ref: "CY-1", english: "", welsh: "" }]
    });
    const preview = storyPreviewView({
      rows: [
        { ref: "CY-1", english: "Back", welsh: "Yn ôl", source: "catalogue", state: "filled" },
        { ref: "CY-2", english: "Odd", welsh: "x", state: "made-up" }
      ],
      verify: { ok: false, failures: [{ english: "Odd", reason: "no approved catalogue row" }] }
    });
    expect(preview.rows.map((r) => r.state)).toEqual(["filled", "required"]);
    expect(preview).toMatchObject({ verified: false, failures: ['"Odd": no approved catalogue row'] });
    expect(storyWriteView({ url: "u", counts: { required: 2 } })).toEqual({ url: "u", required: 2 });
    expect(messageOf({ message: "said" })).toBe("said");
  });

  it("should link only to GitHub and HMCTS Atlassian over https", () => {
    expect(safeLink("https://github.com/hmcts/x/pull/1")).toBe("https://github.com/hmcts/x/pull/1");
    expect(safeLink("https://hmcts.atlassian.net/browse/PUB-1")).toBe("https://hmcts.atlassian.net/browse/PUB-1");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://github.com.evil.example/x")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});
