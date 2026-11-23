import { describe, expect, it } from "vitest";
import { ECHO_MS, noteOwnSave, takeOwnEcho } from "./ownSave.ts";

describe("takeOwnEcho", () => {
  it("should be false when this tab has saved nothing", () => {
    expect(takeOwnEcho(10_000)).toBe(false);
  });

  it("should take the first announcement as the echo and the next as another tab's when the save was just made", () => {
    noteOwnSave(10_000);

    expect(takeOwnEcho(10_000 + 50)).toBe(true);
    expect(takeOwnEcho(10_000 + 60)).toBe(false);
  });

  it("should not take an announcement as the echo when it arrives after the window", () => {
    noteOwnSave(10_000);

    expect(takeOwnEcho(10_000 + ECHO_MS + 1)).toBe(false);
  });
});
