import { describe, expect, it } from "vitest";
import { describeElement, elementNoun, MAX_QUOTED, quoted } from "./anchor-words.ts";

describe("elementNoun", () => {
  it("should name controls, headings and structure by what they are", () => {
    expect(elementNoun("a")).toBe("link");
    expect(elementNoun("BUTTON")).toBe("button");
    expect(elementNoun("input")).toBe("field");
    expect(elementNoun("h2")).toBe("heading");
    expect(elementNoun("summary")).toBe("expandable section");
  });

  it("should call any other element the page's text", () => {
    expect(elementNoun("p")).toBe("text");
    expect(elementNoun("div")).toBe("text");
    expect(elementNoun("custom-thing")).toBe("text");
  });
});

describe("quoted", () => {
  it("should run whitespace together and keep short text whole", () => {
    expect(quoted("  It takes\n around   20 minutes. ")).toBe("It takes around 20 minutes.");
  });

  it("should cut long text and mark the cut", () => {
    const cut = quoted(`${"word ".repeat(30)}end`);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(MAX_QUOTED + 1);
  });
});

describe("describeElement", () => {
  it("should quote a control's text before its noun", () => {
    expect(describeElement({ tag: "a", text: "Start now" })).toBe("the “Start now” link");
    expect(describeElement({ tag: "label", text: "Postcode" })).toBe("the “Postcode” label");
  });

  it("should call plain text the text, quoted", () => {
    expect(describeElement({ tag: "p", text: "It takes around 20 minutes." })).toBe("the text “It takes around 20 minutes.”");
  });

  it("should fall back to the kind of element when it has no text", () => {
    expect(describeElement({ tag: "img", text: "" })).toBe("an image");
    expect(describeElement({ tag: "input", text: " " })).toBe("a field");
    expect(describeElement({ tag: "div", text: "" })).toBe("part of the page");
  });
});
