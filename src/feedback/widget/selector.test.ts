/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cssEscape, looksGenerated, selectorFor } from "./selector.ts";

function page(html: string): void {
  document.body.innerHTML = html;
}

function only(selector: string): Element {
  const found = document.querySelectorAll(selector);
  expect(found).toHaveLength(1);
  return found[0] as Element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("looksGenerated", () => {
  it.each(["main-content", "start", "what-is-your-name"])("should take %s as written by a person", (id) => {
    expect(looksGenerated(id)).toBe(false);
  });

  it.each([":r1:", "ember123", "react-select-2-input", "a1b2c3d4e5f6", "field-1234", "9lives", "x".repeat(41), "radix-7"])(
    "should take %s as generated",
    (id) => {
      expect(looksGenerated(id)).toBe(true);
    }
  );
});

describe("cssEscape", () => {
  it("should escape what a selector would otherwise misread", () => {
    expect(cssEscape("a.b:c")).toBe("a\\.b\\:c");
    expect(cssEscape("1st")).toBe("\\31 st");
    expect(cssEscape("-1x")).toBe("-\\31 x");
    expect(cssEscape("-")).toBe("\\-");
    expect(cssEscape("a\u0000b")).toBe("a�b");
    expect(cssEscape("a\u0001")).toBe("a\\1 ");
    expect(cssEscape("naïve_ok-1")).toBe("naïve_ok-1");
  });
});

describe("selectorFor", () => {
  it("should use an id a person wrote", () => {
    page(`<main id="main-content"><p>Hello</p></main>`);
    expect(selectorFor(only("main"))).toBe("#main-content");
  });

  it("should pass over a generated id for a test id", () => {
    page(`<button id=":r3:" data-testid="continue">Continue</button>`);
    expect(selectorFor(only("button"))).toBe('button[data-testid="continue"]');
  });

  it("should use a name when there is no id", () => {
    page(`<form><input name="full-name"><input name="email"></form>`);
    expect(selectorFor(only("input[name=email]"))).toBe('input[name="email"]');
  });

  it("should pass over a hook that two elements share", () => {
    page(`<div><button aria-label="Change">Change</button></div><div><button aria-label="Change">Change</button></div>`);
    const second = document.querySelectorAll("button")[1] as Element;
    const selector = selectorFor(second);
    expect(selector).toBe("div:nth-of-type(2) > button");
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(second);
  });

  it("should chain from the nearest ancestor with a written id when no shorter chain is unique", () => {
    page(`<section id="answers"><ul><li>One</li><li>Two</li></ul></section><div><ul><li>One</li><li>Two</li></ul></div>`);
    const two = document.querySelectorAll("#answers li")[1] as Element;
    expect(selectorFor(two)).toBe("#answers > ul > li:nth-of-type(2)");
  });

  it("should not use an id two elements share", () => {
    page(`<p id="dup">A</p><p id="dup">B</p>`);
    const second = document.querySelectorAll("p")[1] as Element;
    expect(document.querySelector(selectorFor(second))).toBe(second);
  });

  it("should quote an attribute value with a quote in it", () => {
    page(`<a aria-label='Say "hi"' href="#">Hi</a>`);
    const selector = selectorFor(only("a"));
    expect(selector).toBe('a[aria-label="Say \\"hi\\""]');
    expect(document.querySelector(selector)).toBe(only("a"));
  });

  it("should find the element again for a page with no hooks at all", () => {
    page(`<div><div><span>a</span><span>b</span></div><div><span>c</span></div></div>`);
    for (const span of Array.from(document.querySelectorAll("span"))) {
      expect(document.querySelectorAll(selectorFor(span))).toHaveLength(1);
      expect(document.querySelector(selectorFor(span))).toBe(span);
    }
  });
});
