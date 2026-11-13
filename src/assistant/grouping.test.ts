import { describe, expect, it } from "vitest";
import { bySidebarOrder, dateGroup, groupByDate, groupForSidebar, unreadLabel } from "./grouping.ts";

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
  const isPinned = (item: { pinned: boolean }) => item.pinned;

  it("should leave out the Pinned section when nothing is pinned", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z", pinned: false },
      { id: "b", at: "2026-10-19T08:00:00.000Z", pinned: false }
    ];

    expect(groupForSidebar(items, at, isPinned, NOW)).toEqual([
      { label: "Today", items: [items[0]] },
      { label: "Previous 7 days", items: [items[1]] }
    ]);
  });

  it("should put a pinned item in Pinned above the date groups and not also in its date group when it is pinned", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z", pinned: false },
      { id: "b", at: "2026-10-21T07:00:00.000Z", pinned: true },
      { id: "c", at: "2026-08-01T08:00:00.000Z", pinned: false }
    ];

    expect(groupForSidebar(items, at, isPinned, NOW)).toEqual([
      { label: "Pinned", items: [items[1]] },
      { label: "Today", items: [items[0]] },
      { label: "Older", items: [items[2]] }
    ]);
  });

  it("should keep the given order within Pinned whatever the items' activity", () => {
    const items = [
      { id: "old", at: "2026-08-01T08:00:00.000Z", pinned: true },
      { id: "recent", at: "2026-10-21T08:00:00.000Z", pinned: true },
      { id: "between", at: "2026-10-19T08:00:00.000Z", pinned: true }
    ];

    expect(groupForSidebar(items, at, isPinned, NOW)).toEqual([{ label: "Pinned", items }]);
  });

  it("should ask whether each item is pinned once when partitioning", () => {
    const items = [
      { id: "a", at: "2026-10-21T08:00:00.000Z", pinned: true },
      { id: "b", at: "2026-10-21T07:00:00.000Z", pinned: false }
    ];
    const asked: string[] = [];

    groupForSidebar(
      items,
      at,
      (item) => {
        asked.push(item.id);
        return item.pinned;
      },
      NOW
    );

    expect(asked).toEqual(["a", "b"]);
  });
});

describe("bySidebarOrder", () => {
  const item = (id: string, lastActiveAt: string, pinnedAt: string | null = null) => ({ id, lastActiveAt, pinnedAt });

  it("should put the pinned items first, most recently pinned first, whatever their activity", () => {
    const items = [
      item("recent", "2026-10-21T08:00:00.000Z"),
      item("pinned-early", "2026-10-21T09:00:00.000Z", "2026-10-01T08:00:00.000Z"),
      item("pinned-late", "2026-08-01T08:00:00.000Z", "2026-10-02T08:00:00.000Z")
    ];

    expect([...items].sort(bySidebarOrder).map((entry) => entry.id)).toEqual(["pinned-late", "pinned-early", "recent"]);
  });

  it("should put a feedback project among the chats by its last activity", () => {
    const items = [
      { ...item("chat-old", "2026-10-19T08:00:00.000Z"), kind: "cloud" },
      { ...item("project", "2026-10-20T08:00:00.000Z"), kind: "feedback" },
      { ...item("chat-new", "2026-10-21T08:00:00.000Z"), kind: "cloud" }
    ];

    const grouped = groupForSidebar(
      [...items].sort(bySidebarOrder),
      (entry) => new Date(entry.lastActiveAt),
      (entry) => entry.pinnedAt !== null,
      NOW
    );

    expect(grouped.map((group) => [group.label, group.items.map((entry) => entry.id)])).toEqual([
      ["Today", ["chat-new"]],
      ["Yesterday", ["project"]],
      ["Previous 7 days", ["chat-old"]]
    ]);
  });

  it("should put a pinned project in Pinned beside the pinned chats, by when each was pinned", () => {
    const items = [
      { ...item("chat", "2026-10-21T08:00:00.000Z", "2026-10-20T08:00:00.000Z"), kind: "cloud" },
      { ...item("project", "2026-08-01T08:00:00.000Z", "2026-10-21T08:00:00.000Z"), kind: "feedback" }
    ];

    expect(
      groupForSidebar(
        [...items].sort(bySidebarOrder),
        (entry) => new Date(entry.lastActiveAt),
        (entry) => entry.pinnedAt !== null,
        NOW
      )
    ).toEqual([{ label: "Pinned", items: [items[1], items[0]] }]);
  });

  it("should settle a tie by id when two items were last active at once", () => {
    const items = [item("b", "2026-10-21T08:00:00.000Z"), item("a", "2026-10-21T08:00:00.000Z")];

    expect([...items].sort(bySidebarOrder).map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("unreadLabel", () => {
  it.each([
    [1, "1"],
    [99, "99"],
    [100, "99+"]
  ])("should show %i as %s", (count, label) => {
    expect(unreadLabel(count)).toBe(label);
  });
});
