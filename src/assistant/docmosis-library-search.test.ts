import { describe, expect, it } from "vitest";
import type { IndexEntry } from "./docmosis-library.ts";
import { folders, prepare, searchTemplates } from "./docmosis-library-search.ts";

const BLOB = "b".repeat(40);
const entry = (path: string, size = 1): IndexEntry => [path, BLOB, size];

const INDEX = prepare([
  entry("Templates/Base/Claim form.docx"),
  entry("Templates/Base/Defence to claim.docx"),
  entry("Templates/Base/Counterclaim.docx"),
  entry("Templates/AAT/Notice of claim.docx"),
  entry("Templates/Claims/Order.docx"),
  entry("Templates/Top.docx", 7)
]);

const paths = (found: { results: { path: string }[] }) => found.results.map((template) => template.path);

describe("prepare", () => {
  it("should split each entry into its name and the folder under the library's own", () => {
    const [claim, , , , , top] = INDEX;

    expect(claim).toMatchObject({
      path: "Templates/Base/Claim form.docx",
      name: "Claim form.docx",
      folder: "Base",
      stem: "claim form",
      words: ["claim", "form"]
    });
    expect(top).toMatchObject({ name: "Top.docx", folder: "", size: 7, blobSha: BLOB });
  });
});

describe("searchTemplates", () => {
  it("should rank a name that starts with the word, then a word that does, then one containing it, then the folder", () => {
    expect(paths(searchTemplates(INDEX, "claim"))).toEqual([
      "Templates/Base/Claim form.docx",
      "Templates/AAT/Notice of claim.docx",
      "Templates/Base/Defence to claim.docx",
      "Templates/Base/Counterclaim.docx",
      "Templates/Claims/Order.docx"
    ]);
  });

  it("should need every word to match the name or the folder", () => {
    expect(paths(searchTemplates(INDEX, "claim base"))).toEqual([
      "Templates/Base/Claim form.docx",
      "Templates/Base/Counterclaim.docx",
      "Templates/Base/Defence to claim.docx"
    ]);
    expect(searchTemplates(INDEX, "claim nowhere")).toEqual({ results: [], total: 0 });
  });

  it("should ignore case and extra spaces", () => {
    expect(paths(searchTemplates(INDEX, "  NOTICE   Claim "))).toEqual(["Templates/AAT/Notice of claim.docx"]);
  });

  it("should break a tie by the shorter path, then code-point order", () => {
    const tied = prepare([entry("Templates/B/ab.docx"), entry("Templates/A/ab.docx"), entry("Templates/AA/ab.docx")]);

    expect(paths(searchTemplates(tied, "ab"))).toEqual(["Templates/A/ab.docx", "Templates/B/ab.docx", "Templates/AA/ab.docx"]);
  });

  it("should keep to one folder when asked", () => {
    expect(paths(searchTemplates(INDEX, "claim", { folder: "AAT" }))).toEqual(["Templates/AAT/Notice of claim.docx"]);
  });

  it("should list everything for an empty query, within the limit", () => {
    expect(searchTemplates(INDEX, "").results).toHaveLength(6);
    expect(paths(searchTemplates(INDEX, "", { limit: 2 }))).toEqual(["Templates/Top.docx", "Templates/Claims/Order.docx"]);
    expect(searchTemplates(INDEX, "", { limit: -1 })).toEqual({ results: [], total: 6 });
  });

  it("should stop at 50 by default and count every match", () => {
    const many = prepare(Array.from({ length: 60 }, (_, i) => entry(`Templates/Base/form ${i}.docx`)));

    const found = searchTemplates(many, "form");

    expect(found.results).toHaveLength(50);
    expect(found.total).toBe(60);
  });

  it("should return the same first page a full ranking gives when more templates match than the limit", () => {
    const order = [7, 12, 2, 9, 0, 5, 11, 3, 8, 1, 10, 4, 6];
    const many = prepare([
      entry("Templates/Base/reform.docx"),
      ...order.map((i) => entry(`Templates/${i % 2 === 0 ? "Base" : "Prod"}/form ${i}.docx`)),
      entry("Templates/Base/the form.docx"),
      entry("Templates/Form/Order.docx")
    ]);
    const everything = paths(searchTemplates(many, "form", { limit: 100 }));

    const page = searchTemplates(many, "form", { limit: 5 });

    expect(page.total).toBe(16);
    expect(paths(page)).toEqual(everything.slice(0, 5));
    expect(everything.slice(-3)).toEqual(["Templates/Base/the form.docx", "Templates/Base/reform.docx", "Templates/Form/Order.docx"]);
  });
});

describe("folders", () => {
  it("should count the templates in each folder, in code-point order, leaving out the top", () => {
    expect(folders(INDEX)).toEqual([
      { folder: "AAT", count: 1 },
      { folder: "Base", count: 3 },
      { folder: "Claims", count: 1 }
    ]);
  });
});
