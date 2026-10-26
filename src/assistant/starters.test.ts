import { describe, expect, it } from "vitest";
import { fillWith, STARTERS, TEMPLATES } from "./starters.ts";

const STORY = "Help me.\n\nAs a: …\nI want to: …";

describe("fillWith", () => {
  it("should replace the box and select the first gap when the box is empty", () => {
    const filled = fillWith("", STORY, []);

    expect(filled.text).toBe(STORY);
    expect(filled.text.slice(...filled.select)).toBe("…");
    expect(filled.select[0]).toBe(STORY.indexOf("…"));
  });

  it("should replace the box when it holds only whitespace", () => {
    expect(fillWith("  \n", STORY, []).text).toBe(STORY);
  });

  it("should replace the box when it holds a template nobody has changed", () => {
    expect(fillWith("Other card: …", STORY, ["Other card: …"]).text).toBe(STORY);
  });

  it("should keep the person's words above the template when they have typed something", () => {
    const filled = fillWith("my own notes\n", STORY, ["Other card: …"]);

    expect(filled.text).toBe(`my own notes\n\n${STORY}`);
    expect(filled.select[0]).toBe(filled.text.indexOf("…"));
  });

  it("should select a square-bracket placeholder when that is the first gap", () => {
    const filled = fillWith("", "Bug: [title]\n\nExpected: …", []);

    expect(filled.text.slice(...filled.select)).toBe("[title]");
  });

  it("should put the caret at the end when the template has no gap", () => {
    expect(fillWith("", "/cft-explain what is CDAM?", []).select).toEqual([26, 26]);
  });
});

describe("STARTERS", () => {
  it("should be a few lines with a gap to fill when it is a card's template", () => {
    for (const card of STARTERS) {
      expect(card.text.split("\n").length).toBeLessThanOrEqual(8);
      expect(card.text).toContain("…");
    }
  });

  it("should differ from every other template when it is a card's, so each counts as untouched on its own", () => {
    const texts = [...STARTERS, ...TEMPLATES].map((entry) => entry.text);

    expect(new Set(texts).size).toBe(texts.length);
  });
});
