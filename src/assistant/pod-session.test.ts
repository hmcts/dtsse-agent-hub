import { describe, expect, it } from "vitest";
import { podSessionOf } from "./views.ts";

describe("podSessionOf", () => {
  it.each([
    ["busy", "live", "working"],
    ["busy", null, "working"],
    ["idle", "live", "ready"],
    ["idle", null, "ready"],
    ["offline", "starting", "starting"],
    ["offline", "queued", "starting"],
    ["offline", "live", "disconnected"],
    ["offline", null, "disconnected"]
  ] as const)("should map a %s agent whose pod reports %s to %s", (status, state, expected) => {
    expect(podSessionOf(status, state)).toBe(expected);
  });

  // A session that is connected is connected whatever a report yet to land says.
  it("should read a connected agent as connected even when the pod still reports it starting", () => {
    expect(podSessionOf("idle", "starting")).toBe("ready");
  });
});
