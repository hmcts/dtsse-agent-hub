import { describe, expect, it } from "vitest";
import { needsWake } from "./wake.ts";

describe("needsWake", () => {
  it.each(["busy", "idle"])("should not ask for a wake when the session is live and the agent is %s", (status) => {
    expect(needsWake(status, "live")).toBe(false);
  });

  it.each(["offline", undefined])("should ask for a wake when the session is live and the agent is %s", (status) => {
    expect(needsWake(status, "live")).toBe(true);
  });

  it.each([null, "starting", "queued"] as const)("should ask for a wake when the agent is idle and the session state is %s", (state) => {
    expect(needsWake("idle", state)).toBe(true);
    expect(needsWake("busy", state)).toBe(true);
  });
});
