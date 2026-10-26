import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../../app/globals.css"), "utf8");

/**
 * `globals.css` is the whole app's stylesheet, and the document panel's print rules live in it. jsdom applies no CSS,
 * so what printing looks like is checked in a browser; these are the rules whose reach, if it grew back, would change
 * printing on every page of the app that has nothing to do with the Assistant's documents.
 */
describe("the print stylesheet", () => {
  it("should hide the app's own chrome only while a print sheet is mounted", () => {
    expect(CSS).toContain("body:has(.asst-print-sheet) > *:not(.asst-print-sheet)");
    expect(CSS).not.toMatch(/^\s*body > \*:not\(\.asst-print-sheet\)/m);
  });

  it("should undo the app's full-height layout only while a print sheet is mounted", () => {
    expect(CSS).toContain("html:has(.asst-print-sheet)");
    expect(CSS).not.toMatch(/^\s*:root,/m);
  });

  it("should leave the page margins to the person's print dialogue", () => {
    expect(CSS).not.toContain("@page");
  });
});
