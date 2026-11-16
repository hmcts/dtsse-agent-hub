/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FrameContext, formRewrite, installLinkCapture, linkAction, pagePathOf, rewriteToFrame } from "./links.ts";

const CONTEXT: FrameContext = { prefix: "/f/tok", upstreamOrigin: "https://proto.example", frameOrigin: "http://localhost:3000" };
const BASE = "http://localhost:3000/f/tok/start";

describe("pagePathOf", () => {
  it.each([
    [{ pathname: "/f/tok/start", search: "?a=1" }, "/start?a=1"],
    [{ pathname: "/f/tok", search: "" }, "/"],
    [{ pathname: "/f/tok/", search: "" }, "/"],
    [{ pathname: "/elsewhere", search: "" }, "/elsewhere"]
  ])("should read %o as %s", (location, path) => {
    expect(pagePathOf(location, "/f/tok")).toBe(path);
  });
});

describe("rewriteToFrame", () => {
  it("should move an absolute link to the prototype under the prefix", () => {
    expect(rewriteToFrame("https://proto.example/next?x=1#top", BASE, CONTEXT)).toBe("http://localhost:3000/f/tok/next?x=1#top");
  });

  it.each([
    ["a relative link", "next"],
    ["another site", "https://www.gov.uk/"],
    ["a mailto link", "mailto:a@b.example"],
    ["something that is not a URL", "http://"]
  ])("should leave %s alone", (_label, href) => {
    expect(rewriteToFrame(href, BASE, CONTEXT)).toBeUndefined();
  });
});

describe("linkAction", () => {
  it("should follow a prototype link in the frame", () => {
    expect(linkAction("https://proto.example/a", "", BASE, CONTEXT, false)).toEqual({ kind: "assign", url: "http://localhost:3000/f/tok/a" });
  });

  it("should leave a link that already keeps to the frame to the browser", () => {
    expect(linkAction("/f/tok/a", "", BASE, CONTEXT, false)).toEqual({ kind: "none" });
  });

  it("should keep a _top link to the prototype in the frame", () => {
    expect(linkAction("https://proto.example/a", "_top", BASE, CONTEXT, false)).toEqual({ kind: "assign", url: "http://localhost:3000/f/tok/a" });
  });

  it("should keep a _parent link on the frame's own origin in the frame", () => {
    expect(linkAction("next", "_PARENT", BASE, CONTEXT, false)).toEqual({ kind: "assign", url: "http://localhost:3000/f/tok/next" });
  });

  it("should open a _top link to another site in a new tab rather than replace the review", () => {
    expect(linkAction("https://www.gov.uk/", "_top", BASE, CONTEXT, false)).toEqual({ kind: "open", url: "https://www.gov.uk/" });
  });

  it("should ignore a _top link that is not a URL", () => {
    expect(linkAction("http://", "_top", BASE, CONTEXT, false)).toEqual({ kind: "none" });
  });

  it("should open a _blank link to the prototype under the prefix", () => {
    expect(linkAction("https://proto.example/help", "_blank", BASE, CONTEXT, false)).toEqual({ kind: "open", url: "http://localhost:3000/f/tok/help" });
  });

  it("should leave a new-tab click to another site to the browser", () => {
    expect(linkAction("https://www.gov.uk/", "", BASE, CONTEXT, true)).toEqual({ kind: "none" });
  });
});

describe("formRewrite", () => {
  it("should move a prototype action under the prefix", () => {
    expect(formRewrite("https://proto.example/submit", "", BASE, CONTEXT)).toEqual({ action: "http://localhost:3000/f/tok/submit" });
  });

  it("should keep a _top form in the frame", () => {
    expect(formRewrite("/f/tok/submit", "_top", BASE, CONTEXT)).toEqual({ target: "_self" });
  });

  it("should change nothing for a form that keeps to the frame", () => {
    expect(formRewrite("/f/tok/submit", "", BASE, CONTEXT)).toBeUndefined();
  });
});

describe("installLinkCapture", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function capture(context: FrameContext = { ...CONTEXT, frameOrigin: window.location.origin }) {
    const assign = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const view = new Proxy(window, {
      get: (target, key) => (key === "location" ? { assign } : key === "open" ? open : Reflect.get(target, key))
    });
    stop = installLinkCapture(view, context);
    return { assign, open };
  }

  it("should follow a click on a prototype link in the frame once the click has been dispatched", () => {
    vi.useFakeTimers();
    const { assign } = capture();
    document.body.innerHTML = `<a href="https://proto.example/next"><span>Next</span></a>`;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    document.querySelector("span")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(assign).not.toHaveBeenCalled();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/f/tok/next`);
  });

  it("should open a _blank prototype link under the prefix", () => {
    const { open } = capture();
    document.body.innerHTML = `<a href="https://proto.example/help" target="_blank">Help</a>`;
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith(`${window.location.origin}/f/tok/help`, "_blank", "noopener");
  });

  it("should honour a base target", () => {
    vi.useFakeTimers();
    const { assign } = capture();
    document.head.innerHTML = `<base target="_top">`;
    document.body.innerHTML = `<a href="https://proto.example/x">X</a>`;
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    vi.runAllTimers();
    vi.useRealTimers();
    expect(assign).toHaveBeenCalledWith(`${window.location.origin}/f/tok/x`);
    document.head.innerHTML = "";
  });

  it.each([
    ["a right click", { button: 2 }, `<a href="https://proto.example/x">X</a>`],
    ["a download", {}, `<a download href="https://proto.example/x">X</a>`],
    ["a link with no href", {}, `<a>X</a>`],
    ["a link elsewhere", {}, `<a href="https://www.gov.uk/">X</a>`]
  ])("should leave %s to the browser", (_label, init, html) => {
    const { assign, open } = capture();
    document.body.innerHTML = html;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    document.querySelector("a")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("should leave a click the prototype already handled", () => {
    const { assign } = capture();
    document.body.innerHTML = `<a href="https://proto.example/x">X</a>`;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    click.preventDefault();
    document.querySelector("a")?.dispatchEvent(click);
    expect(assign).not.toHaveBeenCalled();
  });

  function submit(form: HTMLFormElement, submitter: HTMLElement | null = null): void {
    const event = new Event("submit", { bubbles: true, cancelable: true }) as SubmitEvent;
    Object.defineProperty(event, "submitter", { value: submitter });
    form.dispatchEvent(event);
  }

  it("should move a form's action and target before it is submitted", () => {
    capture();
    document.body.innerHTML = `<form action="https://proto.example/save" target="_top"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    submit(form);
    expect(form.getAttribute("action")).toBe(`${window.location.origin}/f/tok/save`);
    expect(form.getAttribute("target")).toBe("_self");
  });

  it("should move a submitter's formaction rather than the form's action", () => {
    capture();
    document.body.innerHTML = `<form action="/f/tok/save"><button formaction="https://proto.example/other">Go</button></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const button = document.querySelector("button") as HTMLButtonElement;
    submit(form, button);
    expect(button.getAttribute("formaction")).toBe(`${window.location.origin}/f/tok/other`);
    expect(form.getAttribute("action")).toBe("/f/tok/save");
  });

  it("should leave a form that keeps to the frame as it is", () => {
    capture();
    document.body.innerHTML = `<form action="/f/tok/save"></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    submit(form);
    expect(form.getAttribute("action")).toBe("/f/tok/save");
    expect(form.hasAttribute("target")).toBe(false);
  });

  it("should stop catching once stopped", () => {
    const { assign } = capture();
    stop?.();
    stop = undefined;
    document.body.innerHTML = `<a href="https://proto.example/x">X</a>`;
    document.querySelector("a")?.addEventListener("click", (event) => event.preventDefault());
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(assign).not.toHaveBeenCalled();
  });
});
