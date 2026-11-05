import { describe, expect, it } from "vitest";
import { dateGroup, groupByDate, groupForSidebar } from "./grouping.ts";

// 10:00 BST on 21 October 2026.
const NOW = new Date("2026-10-21T09:00:00.000Z");

describe("dateGroup", () => {
  it.each([
    ["2026-10-21T08:59:00.000Z", "Today"],
    ["2026-10-20T22:59:00.000Z", "Yesterday"],
    ["2026-10-20T23:30:00.000Z", "Today"],
    ["2026-10-14T12:00:00.000Z", "Previous 7 days"],
    ["2026-10-13T12:00:00.000Z", "Previous 30 days"],
    ["2026-08-01T12:00:00.000Z", "Older"]
  ])("should put %s under %s when measured in UK time", (at, group) => {
    expect(dateGroup(new Date(at), NOW)).toBe(group);
  });

  it("should call a time just after the server's clock Today when the clocks disagree", () => {
    expect(dateGroup(new Date("2026-10-21T09:00:05.000Z"), NOW)).toBe("Today");
  });
});

describe("groupByDate", () => {
  it("should keep the items' order within each group and leave out empty groups when grouping", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z" },
      { id: "b", at: "2026-10-19T08:00:00.000Z" },
      { id: "c", at: "2026-10-21T07:00:00.000Z" }
    ];

    expect(groupByDate(items, (item) => new Date(item.at), NOW)).toEqual([
      { label: "Today", items: [items[0], items[2]] },
      { label: "Previous 7 days", items: [items[1]] }
    ]);
  });
});

describe("groupForSidebar", () => {
  const at = (item: { at: string }) => new Date(item.at);
  const pinnedAt = (item: { pinnedAt: string | null }) => (item.pinnedAt === null ? null : new Date(item.pinnedAt));

  it("should leave out the Pinned section when nothing is pinned", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z", pinnedAt: null },
      { id: "b", at: "2026-10-19T08:00:00.000Z", pinnedAt: null }
    ];

    expect(groupForSidebar(items, at, pinnedAt, NOW)).toEqual([
      { label: "Today", items: [items[0]] },
      { label: "Previous 7 days", items: [items[1]] }
    ]);
  });

  it("should put a pinned item in Pinned above the date groups and not also in its date group when it is pinned", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z", pinnedAt: null },
      { id: "b", at: "2026-10-21T07:00:00.000Z", pinnedAt: "2026-10-21T08:30:00.000Z" },
      { id: "c", at: "2026-08-01T08:00:00.000Z", pinnedAt: null }
    ];

    expect(groupForSidebar(items, at, pinnedAt, NOW)).toEqual([
      { label: "Pinned", items: [items[1]] },
      { label: "Today", items: [items[0]] },
      { label: "Older", items: [items[2]] }
    ]);
  });

  it("should order Pinned by when each was pinned, most recent first, whatever their activity", () => {
    const items = [
      { id: "active-pinned-first", at: "2026-10-21T08:00:00.000Z", pinnedAt: "2026-10-01T08:00:00.000Z" },
      { id: "old-pinned-last", at: "2026-08-01T08:00:00.000Z", pinnedAt: "2026-10-20T08:00:00.000Z" },
      { id: "between", at: "2026-10-19T08:00:00.000Z", pinnedAt: "2026-10-10T08:00:00.000Z" }
    ];

    expect(groupForSidebar(items, at, pinnedAt, NOW)).toEqual([{ label: "Pinned", items: [items[1], items[2], items[0]] }]);
  });

  it("should keep the items' own order when two were pinned at the same moment", () => {
    const items = [
      { id: "a", at: "2026-10-19T08:00:00.000Z", pinnedAt: "2026-10-20T08:00:00.000Z" },
      { id: "b", at: "2026-10-21T08:00:00.000Z", pinnedAt: "2026-10-20T08:00:00.000Z" }
    ];

    expect(groupForSidebar(items, at, pinnedAt, NOW)).toEqual([{ label: "Pinned", items: [items[0], items[1]] }]);
  });

  it("should put an unpinned item back under its date group when it is no longer pinned", () => {
    const items = [{ id: "a", at: "2026-10-19T08:00:00.000Z", pinnedAt: null }];

    expect(groupForSidebar(items, at, pinnedAt, NOW)).toEqual([{ label: "Previous 7 days", items: [items[0]] }]);
  });
});
