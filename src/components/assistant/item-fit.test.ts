import { describe, expect, it } from "vitest";
import { fitItems } from "@/components/assistant/item-fit";

const base = { overflowWidth: 50, gap: 10, current: -1 };

describe("fitItems", () => {
  it("should show every item and hide none when they fit without the overflow button", () => {
    expect(fitItems({ ...base, widths: [100, 100, 100], available: 320 })).toEqual({ shown: [0, 1, 2], hidden: [] });
  });

  it("should show the items that fit beside the overflow button, in order, and hide the rest", () => {
    // 300 less the 50 and the gap before the overflow button leaves 240: two items and the gap between them.
    expect(fitItems({ ...base, widths: [100, 100, 100, 100], available: 300 })).toEqual({ shown: [0, 1], hidden: [2, 3] });
  });

  it("should put the open item in the last place shown when it would otherwise be hidden", () => {
    expect(fitItems({ ...base, widths: [100, 100, 100, 100], available: 300, current: 3 })).toEqual({ shown: [0, 3], hidden: [1, 2] });
  });

  it("should leave the order alone when the open item already fits", () => {
    expect(fitItems({ ...base, widths: [100, 100, 100, 100], available: 300, current: 1 })).toEqual({ shown: [0, 1], hidden: [2, 3] });
  });

  it("should hide every item when not even the first fits beside the overflow button", () => {
    expect(fitItems({ ...base, widths: [100, 100], available: 120, current: 1 })).toEqual({ shown: [], hidden: [0, 1] });
  });

  it("should show nothing when there are no items", () => {
    expect(fitItems({ ...base, widths: [], available: 0 })).toEqual({ shown: [], hidden: [] });
  });
});
