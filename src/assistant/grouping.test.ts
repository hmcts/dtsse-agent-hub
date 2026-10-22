import { describe, expect, it } from "vitest";
import { dateGroup, groupByDate } from "./grouping.ts";

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
