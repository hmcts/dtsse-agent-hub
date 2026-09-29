import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubEvent } from "./events.ts";
import { createEventHub } from "./hub.ts";

const POST: HubEvent = { type: "post", message_id: "1" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEventHub", () => {
  it("should deliver each event to every subscriber", () => {
    const hub = createEventHub();
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe(first);
    hub.subscribe(second);

    hub.publish(POST);

    expect(first).toHaveBeenCalledWith(POST);
    expect(second).toHaveBeenCalledWith(POST);
  });

  it("should stop delivering once a subscriber unsubscribes", () => {
    const hub = createEventHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(listener);

    unsubscribe();
    hub.publish(POST);

    expect(listener).not.toHaveBeenCalled();
    expect(hub.size()).toBe(0);
  });

  it("should keep delivering to the others when one subscriber throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = createEventHub();
    const after = vi.fn();
    hub.subscribe(() => {
      throw new Error("a broken stream");
    });
    hub.subscribe(after);

    hub.publish(POST);

    expect(after).toHaveBeenCalledWith(POST);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a broken stream"));
  });

  it("should report a thrown non-error from a subscriber", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hub = createEventHub();
    hub.subscribe(() => {
      throw "a string";
    });

    hub.publish(POST);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("a string"));
  });

  it("should let a subscriber unsubscribe itself while an event is being delivered", () => {
    const hub = createEventHub();
    const later = vi.fn();
    const unsubscribe = hub.subscribe(() => unsubscribe());
    hub.subscribe(later);

    hub.publish(POST);

    expect(later).toHaveBeenCalledOnce();
    expect(hub.size()).toBe(1);
  });
});
