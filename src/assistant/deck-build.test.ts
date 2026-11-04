import { describe, expect, it } from "vitest";
import {
  buildStatus,
  DECK_BUILD_KEEP_MS,
  DECK_BUILD_TIMEOUT_MS,
  deckBuildErrorBody,
  heldBuildSince,
  MAX_DECK_BUILD_ERROR,
  versionParam
} from "./deck-build.ts";

describe("buildStatus", () => {
  const asked = new Date("2026-11-03T09:00:00.000Z");
  const later = (ms: number) => new Date(asked.getTime() + ms);

  it("should read a build pending until its time is up, and timed out from then on", () => {
    expect(buildStatus({ status: "pending", createdAt: asked }, later(DECK_BUILD_TIMEOUT_MS - 1))).toBe("pending");
    expect(buildStatus({ status: "pending", createdAt: asked }, later(DECK_BUILD_TIMEOUT_MS))).toBe("timeout");
  });

  it("should read a finished build as it finished, whenever it is read", () => {
    expect(buildStatus({ status: "done", createdAt: asked }, later(DECK_BUILD_TIMEOUT_MS * 10))).toBe("done");
    expect(buildStatus({ status: "failed", createdAt: asked }, later(0))).toBe("failed");
    expect(buildStatus({ status: "timeout", createdAt: asked }, later(0))).toBe("timeout");
  });
});

describe("heldBuildSince", () => {
  it("should hold a build for a day from when it was asked for", () => {
    const now = new Date("2026-11-04T09:00:00.000Z");
    expect(heldBuildSince(now).getTime()).toBe(now.getTime() - DECK_BUILD_KEEP_MS);
    expect(heldBuildSince(now).toISOString()).toBe("2026-11-03T09:00:00.000Z");
  });
});

describe("versionParam", () => {
  it("should take a whole number from 1", () => {
    expect(versionParam("1")).toBe(1);
    expect(versionParam("123456789")).toBe(123456789);
  });

  it.each(["0", "01", "-1", "1.5", "one", "", "1234567890"])("should refuse %j", (raw) => {
    expect(versionParam(raw)).toBeUndefined();
  });

  it("should refuse nothing at all", () => {
    expect(versionParam(null)).toBeUndefined();
    expect(versionParam(undefined)).toBeUndefined();
  });
});

describe("deckBuildErrorBody", () => {
  it("should take an error of 1 to 2000 characters, trimmed, and nothing else", () => {
    expect(deckBuildErrorBody.parse({ error: " no " })).toEqual({ error: "no" });
    expect(deckBuildErrorBody.safeParse({ error: " " }).success).toBe(false);
    expect(deckBuildErrorBody.safeParse({ error: "x".repeat(MAX_DECK_BUILD_ERROR + 1) }).success).toBe(false);
    expect(deckBuildErrorBody.safeParse({ error: "no", detail: "x" }).success).toBe(false);
  });
});
