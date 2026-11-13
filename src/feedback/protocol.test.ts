import { describe, expect, it } from "vitest";
import { FEEDBACK_PROTOCOL, isAnchor, isRecordedEvents, isShellMessage, isWidgetMessage, shellMessage, widgetMessage } from "./protocol.ts";

const ANCHOR = { selector: "#start", text: "Start now", tag: "a", rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 800, height: 600 } };
const EVENTS = [
  { type: 4, timestamp: 1, data: { href: "x" } },
  { type: 2, timestamp: 2, data: {} }
];

describe("isWidgetMessage", () => {
  it.each([
    widgetMessage({ type: "hello", path: "/start", title: "Start", version: "1.0" }),
    widgetMessage({ type: "navigated", path: "/next?x=1" }),
    widgetMessage({ type: "pick-cancel" }),
    widgetMessage({ type: "picked", path: "/start", anchor: ANCHOR, snapshot: EVENTS }),
    widgetMessage({ type: "marker-clicked", id: "t1" }),
    widgetMessage({ type: "replay-events", path: "/start", events: EVENTS }),
    widgetMessage({ type: "detached", ids: ["t1", "t2"] })
  ])("should accept a well-formed $type", (message) => {
    expect(isWidgetMessage(message)).toBe(true);
  });

  it.each([
    ["no envelope", { type: "hello", path: "/", title: "", version: "" }],
    ["another protocol", { protocol: "other", v: 1, type: "pick-cancel" }],
    ["another version", { protocol: FEEDBACK_PROTOCOL, v: 2, type: "pick-cancel" }],
    ["an unknown type", { ...widgetMessage({ type: "pick-cancel" }), type: "explode" }],
    ["a protocol-relative path", widgetMessage({ type: "navigated", path: "//evil.example/" })],
    ["a picked with no anchor", { ...widgetMessage({ type: "picked", path: "/", anchor: ANCHOR, snapshot: [] }), anchor: null }],
    ["events without timestamps", widgetMessage({ type: "replay-events", path: "/", events: [{ type: 3 } as never] })],
    ["an empty id", widgetMessage({ type: "detached", ids: [""] })],
    ["a shell message", shellMessage({ type: "pick-start" })],
    ["null", null],
    ["an array", []]
  ])("should refuse %s", (_label, message) => {
    expect(isWidgetMessage(message)).toBe(false);
  });
});

describe("isShellMessage", () => {
  it.each([
    shellMessage({ type: "pick-start" }),
    shellMessage({ type: "pick-cancel" }),
    shellMessage({ type: "markers", threads: [{ id: "t1", number: 1, anchor: ANCHOR, status: "open" }] }),
    shellMessage({ type: "focus-thread", id: "t1" }),
    shellMessage({ type: "record-start", maskInputs: true }),
    shellMessage({ type: "record-stop" })
  ])("should accept a well-formed $type", (message) => {
    expect(isShellMessage(message)).toBe(true);
  });

  it.each([
    ["a marker with a bad status", shellMessage({ type: "markers", threads: [{ id: "t1", number: 1, anchor: ANCHOR, status: "gone" as never }] })],
    ["markers that are not a list", { ...shellMessage({ type: "markers", threads: [] }), threads: {} }],
    ["record-start without masking", { ...shellMessage({ type: "record-start", maskInputs: true }), maskInputs: "yes" }],
    ["a widget message", widgetMessage({ type: "marker-clicked", id: "t1" })],
    ["a string", "pick-start"]
  ])("should refuse %s", (_label, message) => {
    expect(isShellMessage(message)).toBe(false);
  });
});

describe("isAnchor", () => {
  it("should refuse an anchor with an empty selector", () => {
    expect(isAnchor({ ...ANCHOR, selector: "" })).toBe(false);
  });

  it("should refuse an anchor whose rect is not finite", () => {
    expect(isAnchor({ ...ANCHOR, rect: { ...ANCHOR.rect, x: Number.NaN } })).toBe(false);
  });

  it("should refuse an anchor with no viewport", () => {
    expect(isAnchor({ ...ANCHOR, viewport: undefined })).toBe(false);
  });
});

describe("isRecordedEvents", () => {
  it("should refuse something that is not a list", () => {
    expect(isRecordedEvents({ type: 2, timestamp: 1 })).toBe(false);
  });
});
