import { describe, expect, it } from "vitest";
import { storedHistory, storedStops } from "./conversation-row.ts";

describe("storedHistory", () => {
  it("should keep every mark when the stored history is well formed", () => {
    const marks = [
      { product: "pcs", at: "2026-10-25T09:00:00.000Z" },
      { product: "civil", at: "2026-10-25T10:00:00.000Z" }
    ];

    expect(storedHistory(marks)).toEqual(marks);
  });

  it.each([
    ["null", null],
    ["an object", { product: "pcs", at: "2026-10-25T09:00:00.000Z" }],
    ["a string", "pcs"]
  ])("should give no marks when the stored history is %s", (_label, value) => {
    expect(storedHistory(value)).toEqual([]);
  });

  it("should leave out a mark when it has no product or no time", () => {
    const good = { product: "pcs", at: "2026-10-25T09:00:00.000Z" };

    expect(storedHistory([good, null, "pcs", { product: 7, at: good.at }, { product: "civil" }, { at: good.at }])).toEqual([good]);
  });
});

describe("storedStops", () => {
  it("should keep every mark when the stored history is well formed", () => {
    const marks = [{ at: "2026-10-25T09:00:00.000Z" }, { at: "2026-10-25T10:00:00.000Z" }];

    expect(storedStops(marks)).toEqual(marks);
  });

  it.each([
    ["null", null],
    ["an object", { at: "2026-10-25T09:00:00.000Z" }]
  ])("should give no marks when the stored history is %s", (_label, value) => {
    expect(storedStops(value)).toEqual([]);
  });

  it("should leave out a mark when it has no time", () => {
    const good = { at: "2026-10-25T09:00:00.000Z" };

    expect(storedStops([good, null, 3, { at: 12 }, {}])).toEqual([good]);
  });
});
