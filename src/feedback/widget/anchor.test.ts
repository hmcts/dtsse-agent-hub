/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetAnchor } from "../protocol.ts";
import { anchorFor, anchorTarget, findAnchored, MAX_ANCHOR_TEXT, textSnippet } from "./anchor.ts";

function at(element: Element, left: number, top: number, width = 100, height = 20): void {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("textSnippet", () => {
  it("should collapse whitespace and cut the text short", () => {
    document.body.innerHTML = `<p>  Hello \n\t world  </p><div>${"x".repeat(200)}</div>`;
    expect(textSnippet(document.querySelector("p") as Element)).toBe("Hello world");
    expect(textSnippet(document.querySelector("div") as Element)).toHaveLength(MAX_ANCHOR_TEXT);
  });
});

describe("anchorTarget", () => {
  it("should climb out of an element whose tag the anchor cannot hold", () => {
    document.body.innerHTML = `<div id="wrap"><svg><foreignObject><span>x</span></foreignObject></svg></div>`;
    expect(anchorTarget(document.querySelector("foreignObject") as Element).localName).toBe("svg");
  });
});

describe("anchorFor", () => {
  it("should describe the element in page coordinates", () => {
    document.body.innerHTML = `<main id="main-content"><button data-testid="go"> Continue </button></main>`;
    const button = document.querySelector("button") as Element;
    at(button, 10, 20, 120, 40);
    window.scrollTo = () => undefined;
    Object.defineProperty(window, "scrollY", { value: 300, configurable: true });
    expect(anchorFor(button, window)).toEqual({
      selector: 'button[data-testid="go"]',
      text: "Continue",
      tag: "button",
      rect: { x: 10, y: 320, width: 120, height: 40 },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
});

function anchor(overrides: Partial<WidgetAnchor> = {}): WidgetAnchor {
  return { selector: "#go", text: "Continue", tag: "button", rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 800, height: 600 }, ...overrides };
}

describe("findAnchored", () => {
  it("should find the element by its selector while its text agrees", () => {
    document.body.innerHTML = `<button id="go">Continue</button>`;
    expect(findAnchored(document, anchor())).toBe(document.querySelector("#go"));
  });

  it("should find it by tag and text when the selector no longer matches", () => {
    document.body.innerHTML = `<div><button>Back</button><button>Continue</button></div>`;
    expect(findAnchored(document, anchor())?.textContent).toBe("Continue");
  });

  it("should fall back to tag and text when the selector finds an element saying something else", () => {
    document.body.innerHTML = `<button id="go">Save</button><button>Continue</button>`;
    expect(findAnchored(document, anchor())).toBe(document.querySelectorAll("button")[1]);
  });

  it("should take the candidate nearest to where the element was", () => {
    document.body.innerHTML = `<button>Continue</button><button>Continue</button>`;
    const [first, second] = Array.from(document.querySelectorAll("button"));
    at(first as Element, 0, 0);
    at(second as Element, 500, 400);
    expect(findAnchored(document, anchor({ selector: "#gone", rect: { x: 480, y: 410, width: 10, height: 10 } }))).toBe(second);
  });

  it("should report nothing when neither way finds it", () => {
    document.body.innerHTML = `<button>Back</button>`;
    expect(findAnchored(document, anchor())).toBeUndefined();
  });

  it("should report nothing for an element with no text once its selector stops matching", () => {
    document.body.innerHTML = `<input name="other">`;
    expect(findAnchored(document, anchor({ selector: 'input[name="email"]', text: "", tag: "input" }))).toBeUndefined();
  });

  it("should survive a selector the page cannot parse", () => {
    document.body.innerHTML = `<button>Continue</button>`;
    expect(findAnchored(document, anchor({ selector: "!!" }))?.textContent).toBe("Continue");
  });

  it("should refuse to search by a tag that is not one", () => {
    document.body.innerHTML = `<button>Continue</button>`;
    expect(findAnchored(document, anchor({ selector: "#gone", tag: "*" }))).toBeUndefined();
  });
});
