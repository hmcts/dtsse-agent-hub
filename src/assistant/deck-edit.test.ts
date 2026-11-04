import { describe, expect, it } from "vitest";
import type { DeckOutline } from "./deck.ts";
import { AMEND_WINDOW_MS, amends, EDITED_SUMMARY, editSummary, REORDERED_SUMMARY, sessionBuildsIt } from "./deck-edit.ts";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ALICE = "alice-oid";

const deck: DeckOutline = {
  title: "Ways of working",
  slides: [
    { id: "a", layout: "HMCTS_SECTION", title: "One" },
    { id: "b", layout: "HMCTS_CONTENT", title: "Two", bullets: ["x", { text: "y", bullets: ["z"] }] },
    { id: "c", layout: "HMCTS_CLOSING", title: "Three" }
  ]
};

describe("amends", () => {
  it("should amend the person's own editor version when it was first written under 10 minutes ago", () => {
    expect(amends({ by: "user", editorOid: ALICE, createdAt: ago(AMEND_WINDOW_MS - 1) }, ALICE, NOW)).toBe(true);
    expect(amends({ by: "user", editorOid: ALICE, createdAt: NOW }, ALICE, NOW)).toBe(true);
  });

  it("should write a new version when the latest is 10 minutes old or more", () => {
    expect(amends({ by: "user", editorOid: ALICE, createdAt: ago(AMEND_WINDOW_MS) }, ALICE, NOW)).toBe(false);
  });

  it("should write a new version over the session's, a restore or a fork's copy, and another person's", () => {
    expect(amends({ by: "agent", editorOid: null, createdAt: NOW }, ALICE, NOW)).toBe(false);
    expect(amends({ by: "user", editorOid: null, createdAt: NOW }, ALICE, NOW)).toBe(false);
    expect(amends({ by: "user", editorOid: "bob-oid", createdAt: NOW }, ALICE, NOW)).toBe(false);
  });

  it("should write a new version when there is none yet, or the clock says the latest is from the future", () => {
    expect(amends(null, ALICE, NOW)).toBe(false);
    expect(amends({ by: "user", editorOid: ALICE, createdAt: new Date(NOW.getTime() + 1000) }, ALICE, NOW)).toBe(false);
  });
});

describe("editSummary", () => {
  it("should say the slides were reordered when the same slides say the same things in another order", () => {
    const [a, b, c] = deck.slides;
    expect(editSummary(deck, { ...deck, slides: [c!, a!, b!] })).toBe(REORDERED_SUMMARY);
  });

  it("should say the slides were edited for any other change, or none, or with nothing to compare with", () => {
    const [a, b, c] = deck.slides;
    expect(editSummary(deck, { ...deck, slides: [c!, a!, { ...b!, title: "Two!" }] })).toBe(EDITED_SUMMARY);
    expect(editSummary(deck, { ...deck, title: "Ways", slides: [c!, a!, b!] })).toBe(EDITED_SUMMARY);
    expect(editSummary(deck, { ...deck, slides: [a!, b!] })).toBe(EDITED_SUMMARY);
    expect(editSummary(deck, deck)).toBe(EDITED_SUMMARY);
    expect(editSummary(undefined, deck)).toBe(EDITED_SUMMARY);
  });

  it("should line slides without an id up by their place", () => {
    const plain: DeckOutline = { title: "T", slides: [{ layout: "HMCTS_SECTION", title: "One" }] };
    expect(editSummary(plain, plain)).toBe(EDITED_SUMMARY);
  });
});

describe("sessionBuildsIt", () => {
  it("should leave a version the person wrote to be built when they ask, and the session's to the session", () => {
    expect(sessionBuildsIt({ updatedBy: "user" })).toBe(false);
    expect(sessionBuildsIt({ updatedBy: "agent" })).toBe(true);
    expect(sessionBuildsIt({ updatedBy: null })).toBe(true);
  });
});
