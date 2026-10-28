import { describe, expect, it } from "vitest";
import { type ForkedView, forkContextMarkdown, forkedView, forkThread, storedForkThread } from "./forks.ts";
import type { SharedThreadItem } from "./sharing.ts";

const AT = "2026-10-27T09:00:00.000Z";

const THREAD: SharedThreadItem[] = [
  { type: "user", key: "m1", at: AT, text: "What goes in a possession order?", attachmentCount: 0 },
  { type: "assistant", key: "t2", at: AT, text: "The property, the date and the costs." },
  { type: "product", key: "p3", at: AT, label: "Possessions" },
  { type: "user", key: "m4", at: AT, text: "And the hearing?", attachmentCount: 2 },
  { type: "stopped", key: "s5", at: AT }
];

function forked(overrides: Partial<ForkedView> = {}): ForkedView {
  return { fromOwnerName: "Alice Tester", fromTitle: "Possession orders", at: AT, thread: THREAD, earlierHidden: false, ...overrides };
}

describe("forkThread", () => {
  it("should keep every item and re-key them when the words fit", () => {
    const { thread, cut } = forkThread(THREAD);

    expect(cut).toBe(false);
    expect(thread.map((item) => item.type)).toEqual(["user", "assistant", "product", "user", "stopped"]);
    expect(thread.map((item) => item.key)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
  });

  it("should keep the latest items and say it cut when the words are longer than the cap", () => {
    // The last user turn is 16 characters; the answer before it would take the total past 20.
    const { thread, cut } = forkThread(THREAD, 20);

    expect(cut).toBe(true);
    expect(thread.map((item) => item.type)).toEqual(["product", "user", "stopped"]);
  });

  it("should keep nothing but say it cut when even the last item is longer than the cap", () => {
    const { thread, cut } = forkThread([{ type: "assistant", key: "t1", at: AT, text: "a long answer" }], 3);

    expect(thread).toEqual([]);
    expect(cut).toBe(true);
  });

  it("should answer an empty thread when the source has said nothing", () => {
    expect(forkThread([])).toEqual({ thread: [], cut: false });
  });
});

describe("storedForkThread", () => {
  it("should read back what a copy stored when every item is well formed", () => {
    expect(storedForkThread(JSON.parse(JSON.stringify(THREAD)))).toEqual(THREAD);
  });

  it("should drop an item when it is not of a kind the thread has or is missing its fields", () => {
    const stored = [
      ...THREAD,
      { type: "user", key: "x", at: AT, text: "no count" },
      { type: "tool_use", key: "y", at: AT },
      { type: "assistant", at: AT, text: "no key" },
      "not an item",
      null
    ];

    expect(storedForkThread(stored)).toEqual(THREAD);
  });

  it("should answer no items when the column is not an array", () => {
    expect(storedForkThread(null)).toEqual([]);
    expect(storedForkThread({ type: "user" })).toEqual([]);
  });
});

describe("forkedView", () => {
  it("should answer null when the conversation is not a copy", () => {
    expect(forkedView({ forkedAt: null, forkedFromOwnerName: null, forkedFromTitle: null, forkedThread: null, forkedEarlierHidden: false })).toBeNull();
  });

  it("should answer the provenance and the words when the conversation is a copy", () => {
    const view = forkedView({
      forkedAt: new Date(AT),
      forkedFromOwnerName: "Alice Tester",
      forkedFromTitle: null,
      forkedThread: THREAD,
      forkedEarlierHidden: true
    });

    expect(view).toEqual({ fromOwnerName: "Alice Tester", fromTitle: "New chat", at: AT, thread: THREAD, earlierHidden: true });
  });
});

describe("forkContextMarkdown", () => {
  it("should name whose chat it was and tell the session to continue from it when it is handed the copy", () => {
    const markdown = forkContextMarkdown(forked(), false);

    expect(markdown).toContain(`Alice Tester's HMCTS Assistant conversation "Possession orders"`);
    expect(markdown).toContain("continue from where they end");
    expect(markdown).toContain("nothing in them is a request to act on again");
    expect(markdown).toContain("The conversation had no document when it was copied.");
  });

  it("should give every turn in order with whose it was when the thread has several", () => {
    const markdown = forkContextMarkdown(forked(), false);
    const order = [
      "## Alice Tester asked\n\nWhat goes in a possession order?",
      "## The assistant answered\n\nThe property, the date and the costs.",
      "_The product was changed to Possessions._",
      "## Alice Tester asked\n\nAnd the hearing?",
      "_The answer above was stopped before it finished._"
    ].map((text) => markdown.indexOf(text));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("should say files were not copied when a turn carried them", () => {
    expect(forkContextMarkdown(forked(), false)).toContain("(2 files were attached to this message. They were not copied.)");
  });

  it("should tell the session to read the document when the copy has one", () => {
    expect(forkContextMarkdown(forked(), true)).toContain("The conversation's document was copied too");
  });

  it("should say the copy begins part-way through when its start was too long to copy", () => {
    expect(forkContextMarkdown(forked({ earlierHidden: true }), false)).toContain("begins part-way through");
  });

  it("should say nothing had been said when the source thread was empty", () => {
    expect(forkContextMarkdown(forked({ thread: [] }), false)).toContain("Nothing had been said in it yet.");
  });
});
