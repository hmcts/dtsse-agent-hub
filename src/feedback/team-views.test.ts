import { describe, expect, it } from "vitest";
import type { FeedbackRecordingView } from "./recording-store.ts";
import {
  durationText,
  filterThreads,
  lastActivity,
  marginOrder,
  NO_FILTER,
  pagesOf,
  recentActivity,
  reviewersOf,
  reviewerTimeline,
  threadCounts
} from "./team-views.ts";
import type { FeedbackThreadView } from "./thread-store.ts";

const ANN = { oid: "ann", name: "Ann" };
const BEN = { oid: "ben", name: "Ben" };

function thread(id: string, more: Partial<FeedbackThreadView> = {}): FeedbackThreadView {
  const author = more.author ?? ANN;
  const createdAt = more.createdAt ?? "2026-11-10T10:00:00.000Z";
  return {
    id,
    projectId: "p",
    linkId: "l1",
    pagePath: "/start",
    anchor: { selector: "#x", text: "x", tag: "p", rect: { x: 0, y: 100, width: 10, height: 10 }, viewport: { width: 1200, height: 800 } },
    status: "open",
    author,
    resolvedBy: null,
    resolvedAt: null,
    snapshotBlob: null,
    recordingId: null,
    offsetMs: null,
    prototypeVersion: null,
    createdAt,
    updatedAt: createdAt,
    comments: [{ id: `${id}-c1`, author, body: `about ${id}`, createdAt, mentions: [] }],
    ...more
  };
}

function recording(id: string, more: Partial<FeedbackRecordingView> = {}): FeedbackRecordingView {
  return {
    id,
    projectId: "p",
    linkId: "l1",
    author: BEN,
    startedAt: "2026-11-11T09:00:00.000Z",
    endedAt: "2026-11-11T09:05:00.000Z",
    durationMs: 300_000,
    status: "ready",
    prototypeVersion: null,
    ...more
  };
}

const at = (y: number, x = 0) => ({ selector: "#x", text: "", tag: "p", rect: { x, y, width: 1, height: 1 }, viewport: { width: 1200, height: 800 } });

describe("threadCounts", () => {
  it("should count the threads in each status", () => {
    expect(threadCounts([{ status: "open" }, { status: "open" }, { status: "resolved" }, { status: "detached" }])).toEqual({
      open: 2,
      resolved: 1,
      detached: 1
    });
  });
});

describe("filterThreads", () => {
  const threads = [thread("a"), thread("b", { linkId: "l2", author: BEN }), thread("c", { status: "resolved", pagePath: "/end" })];

  it("should keep every thread when nothing is chosen", () => {
    expect(filterThreads(threads, NO_FILTER)).toHaveLength(3);
  });

  it("should keep only threads matching every filter chosen", () => {
    expect(filterThreads(threads, { ...NO_FILTER, linkId: "l1", status: "resolved" }).map((t) => t.id)).toEqual(["c"]);
    expect(filterThreads(threads, { ...NO_FILTER, authorOid: "ben" }).map((t) => t.id)).toEqual(["b"]);
    expect(filterThreads(threads, { ...NO_FILTER, pagePath: "/end" }).map((t) => t.id)).toEqual(["c"]);
  });
});

describe("pagesOf", () => {
  it("should list each link's pages once, in order, with how many threads each has", () => {
    const threads = [thread("a", { pagePath: "/z" }), thread("b", { linkId: "l0", pagePath: "/z" }), thread("c"), thread("d", { pagePath: "/z" })];

    expect(pagesOf(threads)).toEqual([
      { linkId: "l0", pagePath: "/z", threads: 1 },
      { linkId: "l1", pagePath: "/start", threads: 1 },
      { linkId: "l1", pagePath: "/z", threads: 2 }
    ]);
  });
});

describe("marginOrder", () => {
  it("should order a page's threads by where their element is down the page, then across it, then by when", () => {
    const threads = [
      thread("low", { anchor: at(900) }),
      thread("right", { anchor: at(100, 50) }),
      thread("later", { anchor: at(100), createdAt: "2026-11-12T00:00:00.000Z" }),
      thread("left", { anchor: at(100) }),
      thread("gone", { anchor: at(50), status: "detached" })
    ];

    const { onPage, detached } = marginOrder(threads);

    expect(onPage.map((t) => t.id)).toEqual(["left", "later", "right", "low"]);
    expect(detached.map((t) => t.id)).toEqual(["gone"]);
  });

  it("should fall back to the id when two threads are the same in every other way", () => {
    expect(marginOrder([thread("b"), thread("a")]).onPage.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("reviewersOf", () => {
  it("should count each person's threads, messages and recordings, the most active first", () => {
    const threads = [
      thread("a", {
        comments: [
          { id: "1", author: ANN, body: "x", createdAt: "2026-11-10T10:00:00.000Z", mentions: [] },
          { id: "2", author: BEN, body: "y", createdAt: "2026-11-10T11:00:00.000Z", mentions: [] }
        ]
      })
    ];

    expect(reviewersOf(threads, [recording("r1"), recording("r2")])).toEqual([
      { oid: "ben", name: "Ben", threads: 0, comments: 1, recordings: 2 },
      { oid: "ann", name: "Ann", threads: 1, comments: 1, recordings: 0 }
    ]);
  });

  it("should put people equally active in name order", () => {
    expect(reviewersOf([thread("b", { author: BEN }), thread("a")], []).map((r) => r.name)).toEqual(["Ann", "Ben"]);
  });
});

describe("recentActivity", () => {
  const resolved = thread("a", {
    status: "resolved",
    resolvedAt: "2026-11-12T08:00:00.000Z",
    resolvedBy: BEN,
    comments: [
      { id: "1", author: ANN, body: "first", createdAt: "2026-11-10T10:00:00.000Z", mentions: [] },
      { id: "2", author: BEN, body: "reply", createdAt: "2026-11-11T10:00:00.000Z", mentions: [] }
    ]
  });

  it("should list comments, replies, resolutions and recordings, newest first", () => {
    expect(recentActivity([resolved], [recording("r")]).map((item) => item.kind)).toEqual(["resolved", "reply", "recording", "thread"]);
  });

  it("should stop at the limit asked for, and give an empty first comment for a thread with none", () => {
    expect(recentActivity([thread("x", { comments: [] })], [], 1)).toEqual([
      { kind: "thread", at: "2026-11-10T10:00:00.000Z", who: "Ann", text: "", threadId: "x", pagePath: "/start" }
    ]);
  });

  it("should take the last activity from the latest thing that happened, or the project's own change", () => {
    expect(lastActivity("2026-01-01T00:00:00.000Z", [resolved], [])).toBe("2026-11-12T08:00:00.000Z");
    expect(lastActivity("2026-12-01T00:00:00.000Z", [resolved], [])).toBe("2026-12-01T00:00:00.000Z");
    expect(lastActivity("2026-12-01T00:00:00.000Z", [], [])).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("reviewerTimeline", () => {
  it("should list a person's threads, those they replied to, and recordings, in the order they made them", () => {
    const replied = thread("replied", {
      comments: [
        { id: "1", author: ANN, body: "x", createdAt: "2026-11-09T10:00:00.000Z", mentions: [] },
        { id: "2", author: BEN, body: "y", createdAt: "2026-11-12T10:00:00.000Z", mentions: [] }
      ]
    });
    const items = reviewerTimeline(
      "ben",
      [thread("own", { author: BEN }), replied, thread("not-theirs")],
      [recording("r"), recording("other", { author: ANN })]
    );

    expect(items.map((item) => [item.kind, item.at])).toEqual([
      ["thread", "2026-11-10T10:00:00.000Z"],
      ["recording", "2026-11-11T09:00:00.000Z"],
      ["thread", "2026-11-12T10:00:00.000Z"]
    ]);
  });
});

describe("durationText", () => {
  it.each([
    [null, "still recording"],
    [45_000, "45s"],
    [185_000, "3m 05s"],
    [3_720_000, "1h 02m"]
  ])("should say %s as %s", (ms, text) => {
    expect(durationText(ms)).toBe(text);
  });
});
