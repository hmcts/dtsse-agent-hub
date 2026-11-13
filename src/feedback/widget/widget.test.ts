/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ShellMessageBody, shellMessage, type WidgetMessage } from "../protocol.ts";
import type { RecordFunction, RecordOptions } from "./recorder.ts";
import { configFrom, type RunningWidget, startWidget, type WidgetConfig } from "./widget.ts";

const HUB = "https://agent-hub.example";
const CONFIG: WidgetConfig = { hubOrigin: HUB, prefix: "/f/tok", upstreamOrigin: "https://proto.example", maskInputs: true, version: "1.0" };

let posted: { message: WidgetMessage; target: string }[];
let parent: { postMessage: (message: WidgetMessage, target: string) => void };
let running: RunningWidget | undefined;
let recordCalls: RecordOptions[];

/** The window as the widget sees it inside a frame: the same page, with a parent of its own. */
function framedView(): Window {
  return new Proxy(window, {
    get: (target, key) => {
      if (key === "parent") {
        return parent;
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" && key !== "MutationObserver" ? value.bind(target) : value;
    }
  });
}

const record = ((options: RecordOptions) => {
  recordCalls.push(options);
  options.emit({ type: 4, timestamp: 1, data: {} });
  options.emit({ type: 2, timestamp: 1, data: {} });
  return () => undefined;
}) as RecordFunction;
record.takeFullSnapshot = () => undefined;

function send(body: ShellMessageBody, init: { origin?: string; source?: unknown } = {}): void {
  window.dispatchEvent(new MessageEvent("message", { data: shellMessage(body), origin: init.origin ?? HUB, source: (init.source ?? parent) as Window }));
}

function types(): string[] {
  return posted.map(({ message }) => message.type);
}

beforeEach(() => {
  posted = [];
  recordCalls = [];
  parent = { postMessage: (message, target) => posted.push({ message, target }) };
  window.history.replaceState(null, "", "/f/tok/start?step=1");
  document.title = "Start";
});

afterEach(() => {
  running?.stop();
  running = undefined;
  document.body.innerHTML = "";
});

describe("configFrom", () => {
  function script(attributes: Record<string, string>): HTMLScriptElement {
    const element = document.createElement("script");
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    return element;
  }

  it("should read the proxy's attributes", () => {
    expect(
      configFrom(
        script({
          "data-hub-origin": `${HUB}/`,
          "data-prefix": "/f/tok",
          "data-upstream-origin": "https://proto.example/start",
          "data-mask-inputs": "true",
          "data-version": "1.0"
        })
      )
    ).toEqual(CONFIG);
  });

  it("should refuse a script that is not the proxy's", () => {
    expect(configFrom(null)).toBeUndefined();
    expect(configFrom(script({ "data-hub-origin": "not a url", "data-prefix": "/f/tok", "data-upstream-origin": "https://proto.example" }))).toBeUndefined();
  });

  it("should default masking off and the version empty", () => {
    expect(configFrom(script({ "data-hub-origin": HUB, "data-prefix": "/f/tok", "data-upstream-origin": "https://proto.example" }))).toMatchObject({
      maskInputs: false,
      version: ""
    });
  });
});

describe("startWidget", () => {
  it("should do nothing outside a frame", () => {
    expect(startWidget(window, CONFIG, record)).toBeUndefined();
  });

  it("should say hello to the hub's origin with the page under the prefix", () => {
    running = startWidget(framedView(), CONFIG, record);
    expect(posted[0]).toEqual({
      message: expect.objectContaining({ type: "hello", path: "/start?step=1", title: "Start", version: "1.0" }),
      target: HUB
    });
  });

  it("should report a single-page app's navigation once", () => {
    running = startWidget(framedView(), CONFIG, record);
    window.history.pushState(null, "", "/f/tok/next");
    window.history.replaceState(null, "", "/f/tok/next");
    expect(posted.slice(1).map(({ message }) => message)).toEqual([expect.objectContaining({ type: "navigated", path: "/next" })]);
  });

  it("should ignore a message from another origin or another window", () => {
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "record-start", maskInputs: false }, { origin: "https://proto.example" });
    send({ type: "record-start", maskInputs: false }, { source: window });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "record-start" }, origin: HUB, source: parent as unknown as Window }));
    expect(recordCalls).toHaveLength(0);
  });

  it("should record while the shell says so and post the events", () => {
    vi.useFakeTimers();
    try {
      running = startWidget(framedView(), CONFIG, record);
      send({ type: "record-start", maskInputs: false });
      expect(recordCalls[0]?.maskAllInputs).toBe(false);
      send({ type: "record-stop" });
      expect(posted.at(-1)?.message).toMatchObject({ type: "replay-events", path: "/start?step=1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("should post what it has recorded as the page goes", () => {
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "record-start", maskInputs: false });
    window.dispatchEvent(new Event("pagehide"));
    expect(types().at(-1)).toBe("replay-events");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("should post what it has recorded when navigation starts, while the frame still holds this document", () => {
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "record-start", maskInputs: false });
    const before = posted.length;
    window.dispatchEvent(new Event("beforeunload"));
    expect(posted.length).toBe(before + 1);
    expect(types().at(-1)).toBe("replay-events");
  });

  it("should post the picked element's anchor and snapshot", () => {
    document.body.innerHTML = `<button id="go">Continue</button>`;
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "pick-start" });
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const picked = posted.at(-1)?.message;
    expect(picked).toMatchObject({ type: "picked", path: "/start?step=1", anchor: { selector: "#go", text: "Continue", tag: "button" } });
    expect(picked?.type === "picked" ? picked.snapshot.map((event) => event.type) : []).toEqual([4, 2]);
    expect(recordCalls[0]?.maskAllInputs).toBe(true);
  });

  it("should tell the shell when picking is cancelled from the frame", () => {
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "pick-start" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(types().at(-1)).toBe("pick-cancel");
  });

  it("should stop picking when the shell cancels", () => {
    document.body.innerHTML = `<button id="go">Continue</button>`;
    running = startWidget(framedView(), CONFIG, record);
    send({ type: "pick-start" });
    send({ type: "pick-cancel" });
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(types()).not.toContain("picked");
  });

  it("should draw markers and focus a thread when told to", () => {
    document.body.innerHTML = `<button id="go">Continue</button>`;
    const started = startWidget(framedView(), CONFIG, record) as RunningWidget;
    running = started;
    const set = vi.spyOn(started.markers, "set");
    const focus = vi.spyOn(started.markers, "focus");
    const anchor = { selector: "#go", text: "Continue", tag: "button", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } };
    send({ type: "markers", threads: [{ id: "t1", number: 1, anchor, status: "open" }] });
    send({ type: "focus-thread", id: "t1" });
    expect(set).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith("t1");
  });

  it("should put history back as it was when stopped", () => {
    const push = window.history.pushState;
    running = startWidget(framedView(), CONFIG, record);
    expect(window.history.pushState).not.toBe(push);
    running?.stop();
    running = undefined;
    expect(window.history.pushState).toBe(push);
  });
});
