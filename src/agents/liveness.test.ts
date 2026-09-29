import { describe, expect, it } from "vitest";
import { lastHeard, OFFLINE_AFTER_SECONDS, onStatus } from "./liveness.ts";

const NOW = 1_000_000_000;
const WINDOW = OFFLINE_AFTER_SECONDS * 1000;

describe("lastHeard", () => {
  it("should keep the recorded time when the agent is offline", () => {
    expect(lastHeard({ status: "offline", at: NOW - 10 * WINDOW }, NOW)).toBe(NOW - 10 * WINDOW);
  });

  it("should keep the recorded time when a live agent was heard within the offline window", () => {
    expect(lastHeard({ status: "busy", at: NOW - 1_000 }, NOW)).toBe(NOW - 1_000);
  });

  it("should bound the age by the offline window when a live agent's recorded time is older", () => {
    expect(lastHeard({ status: "idle", at: NOW - 10 * WINDOW }, NOW)).toBe(NOW - WINDOW);
  });
});

describe("onStatus", () => {
  it("should record now when a live status arrives", () => {
    expect(onStatus({ status: "offline", at: 0 }, "busy", NOW)).toEqual({ status: "busy", at: NOW });
    expect(onStatus({ status: "busy", at: 0 }, "idle", NOW)).toEqual({ status: "idle", at: NOW });
  });

  it("should keep the last time the agent was known to be live when it goes offline", () => {
    expect(onStatus({ status: "busy", at: 0 }, "offline", NOW)).toEqual({ status: "offline", at: NOW - WINDOW });
    expect(onStatus({ status: "busy", at: NOW - 1_000 }, "offline", NOW)).toEqual({ status: "offline", at: NOW - 1_000 });
  });
});
