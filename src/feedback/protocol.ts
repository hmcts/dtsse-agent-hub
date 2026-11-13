/**
 * The messages the review shell and the widget in its frame exchange by `postMessage`. Pure, and imported by both,
 * so a message one side sends is a message the other's validator accepts. Every message carries `protocol` and its
 * version, `v`; a page with some other script posting to the shell, or an older widget still cached, is ignored
 * rather than misread.
 *
 * Neither side trusts a message for its shape alone: the shell takes only those whose `origin` is the viewer's and
 * whose `source` is its own frame's window, the widget only those from the hub's origin and its parent.
 */

export const FEEDBACK_PROTOCOL = "agent-hub-feedback";
export const FEEDBACK_PROTOCOL_VERSION = 1;

/**
 * One rrweb `eventWithTime`, as far as the shell and the protocol need to know it: rrweb's own types stay inside the
 * widget, and the player reads the full shape back with `@rrweb/replay`. `timestamp` is wall-clock milliseconds.
 */
export interface RecordedEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

/** rrweb's `EventType` values the shell and the snapshot rely on. */
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;

/** Where an element was when it was picked, in page coordinates, and the size of the viewport it was picked in. */
export interface WidgetAnchor {
  selector: string;
  text: string;
  tag: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

/** A thread as the widget is told of it, to put a numbered marker beside its element. */
export interface MarkerThread {
  id: string;
  number: number;
  anchor: WidgetAnchor;
  status: "open" | "resolved" | "detached";
}

type Envelope<T> = T & { protocol: typeof FEEDBACK_PROTOCOL; v: typeof FEEDBACK_PROTOCOL_VERSION };

/** From the widget to the shell. `path` is always the page's path and query under the link's prefix, from `/`. */
export type WidgetMessage = Envelope<
  | { type: "hello"; path: string; title: string; version: string }
  /** The answer to the shell's `ping`: this page's widget is running, whether or not the shell heard its `hello`. */
  | { type: "present"; path: string }
  | { type: "navigated"; path: string }
  | { type: "pick-cancel" }
  | { type: "picked"; path: string; anchor: WidgetAnchor; snapshot: RecordedEvent[] }
  | { type: "marker-clicked"; id: string }
  | { type: "replay-events"; path: string; events: RecordedEvent[] }
  | { type: "detached"; ids: string[] }
>;

/** From the shell to the widget. */
export type ShellMessage = Envelope<
  /**
   * Sent each time the frame fires `load`, which is after a page's deferred widget has already said `hello`, so the
   * shell cannot tell a page without a widget from one whose `hello` came first except by asking.
   */
  | { type: "ping" }
  | { type: "pick-start" }
  | { type: "pick-cancel" }
  | { type: "markers"; threads: MarkerThread[] }
  | { type: "focus-thread"; id: string }
  | { type: "record-start"; maskInputs: boolean }
  | { type: "record-stop" }
>;

type Body<M> = M extends unknown ? Omit<M, "protocol" | "v"> : never;

export type WidgetMessageBody = Body<WidgetMessage>;
export type ShellMessageBody = Body<ShellMessage>;

export function widgetMessage(body: WidgetMessageBody): WidgetMessage {
  return { ...body, protocol: FEEDBACK_PROTOCOL, v: FEEDBACK_PROTOCOL_VERSION } as WidgetMessage;
}

export function shellMessage(body: ShellMessageBody): ShellMessage {
  return { ...body, protocol: FEEDBACK_PROTOCOL, v: FEEDBACK_PROTOCOL_VERSION } as ShellMessage;
}

/** Most ids and threads one message carries, far above a page's comments, so a hostile frame cannot post a flood. */
const MAX_ITEMS = 1000;
const MAX_STRING = 4096;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_STRING): value is string {
  return typeof value === "string" && value.length <= max;
}

function isPath(value: unknown): value is string {
  return isText(value) && value.startsWith("/") && !value.startsWith("//");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((id) => isText(id, 64) && id !== "");
}

export function isAnchor(value: unknown): value is WidgetAnchor {
  if (!isObject(value) || !isText(value.selector) || value.selector === "" || !isText(value.text) || !isText(value.tag, 64)) {
    return false;
  }
  const { rect, viewport } = value;
  return (
    isObject(rect) &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    isObject(viewport) &&
    isFiniteNumber(viewport.width) &&
    isFiniteNumber(viewport.height)
  );
}

export function isRecordedEvents(value: unknown): value is RecordedEvent[] {
  return Array.isArray(value) && value.every((event) => isObject(event) && isFiniteNumber(event.type) && isFiniteNumber(event.timestamp));
}

function isMarkerThread(value: unknown): value is MarkerThread {
  return (
    isObject(value) &&
    isText(value.id, 64) &&
    isFiniteNumber(value.number) &&
    isAnchor(value.anchor) &&
    (value.status === "open" || value.status === "resolved" || value.status === "detached")
  );
}

function enveloped(value: unknown): value is Fields & { type: unknown } {
  return isObject(value) && value.protocol === FEEDBACK_PROTOCOL && value.v === FEEDBACK_PROTOCOL_VERSION;
}

export function isWidgetMessage(value: unknown): value is WidgetMessage {
  if (!enveloped(value)) {
    return false;
  }
  switch (value.type) {
    case "hello":
      return isPath(value.path) && isText(value.title) && isText(value.version);
    case "navigated":
    case "present":
      return isPath(value.path);
    case "pick-cancel":
      return true;
    case "picked":
      return isPath(value.path) && isAnchor(value.anchor) && isRecordedEvents(value.snapshot);
    case "marker-clicked":
      return isText(value.id, 64);
    case "replay-events":
      return isPath(value.path) && isRecordedEvents(value.events);
    case "detached":
      return isIdList(value.ids);
    default:
      return false;
  }
}

export function isShellMessage(value: unknown): value is ShellMessage {
  if (!enveloped(value)) {
    return false;
  }
  switch (value.type) {
    case "ping":
    case "pick-start":
    case "pick-cancel":
    case "record-stop":
      return true;
    case "markers":
      return Array.isArray(value.threads) && value.threads.length <= MAX_ITEMS && value.threads.every(isMarkerThread);
    case "focus-thread":
      return isText(value.id, 64);
    case "record-start":
      return typeof value.maskInputs === "boolean";
    default:
      return false;
  }
}
