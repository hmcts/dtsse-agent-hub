import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckOutline } from "@/assistant/deck";

const access = vi.fn();
const saveDeckEdit = vi.fn();
const removeStoredDeck = vi.fn();
let enabled = true;

vi.mock("@/viewer/current", () => ({ requireViewer: async () => ({ oid: "alice-oid" }) }));
vi.mock("@/assistant/shares", () => ({ accessToConversation: (...args: unknown[]) => access(...args) }));
vi.mock("@/virtual-agents/settings", () => ({ virtualAgentsEnabled: () => enabled }));
vi.mock("@/assistant/deck-edit-store", () => ({ saveDeckEdit: (...args: unknown[]) => saveDeckEdit(...args) }));
vi.mock("@/assistant/deck-history-store", () => ({ restoreDeckVersion: vi.fn() }));
vi.mock("@/assistant/deck-store", async (original) => ({ ...(await original<object>()), removeDeck: (...args: unknown[]) => removeStoredDeck(...args) }));
vi.mock("@/store/prisma", () => ({ prisma: {} }));

const { removeDeck, saveDeck } = await import("./decks.ts");
const { DeckAssetsMissing } = await import("@/assistant/deck-store");

const CONVERSATION = { id: "c1", virtualAgentId: "v1", ownerOid: "alice-oid" };
const ITEM = "44444444-4444-4444-4444-444444444444";
const OUTLINE: DeckOutline = { title: "Ways of working", slides: [{ id: "s_0001", layout: "HMCTS_SECTION", title: "Why" }] };
const input = (more: Record<string, unknown> = {}) => ({ conversationId: "c1", itemId: ITEM, outline: OUTLINE, baseVersion: 3, baseRevision: 5, ...more });

beforeEach(() => {
  enabled = true;
  access.mockReset();
  saveDeckEdit.mockReset();
  removeStoredDeck.mockReset();
});

describe("saveDeck", () => {
  it("should save the owner's outline as theirs, from the version and revision they name", async () => {
    access.mockResolvedValue({ conversation: CONVERSATION, access: "owner" });
    saveDeckEdit.mockResolvedValue({ saved: true, id: ITEM, version: 3, revision: 6, outline: OUTLINE, amended: true, unchanged: false });

    expect(await saveDeck(input())).toEqual({ ok: true, saved: true, version: 3, revision: 6, amended: true, unchanged: false });
    expect(saveDeckEdit).toHaveBeenCalledWith({}, CONVERSATION, ITEM, { outline: OUTLINE, baseVersion: 3, baseRevision: 5, editorOid: "alice-oid" });
  });

  it("should refuse a share's reader and a stranger alike, saving nothing", async () => {
    for (const allowed of [{ conversation: CONVERSATION, access: "reader" }, undefined]) {
      access.mockResolvedValue(allowed);
      expect(await saveDeck(input())).toEqual({ ok: false, error: "those slides are not there" });
    }
    expect(saveDeckEdit).not.toHaveBeenCalled();
  });

  it("should refuse a base that is not a whole number before looking the chat up", async () => {
    expect(await saveDeck(input({ baseRevision: -1 }))).toEqual({ ok: false, error: "those slides are not there" });
    expect(await saveDeck(input({ baseVersion: 1.5 }))).toEqual({ ok: false, error: "those slides are not there" });
    expect(access).not.toHaveBeenCalled();
  });

  it("should answer the deck as it is now when it has moved on", async () => {
    access.mockResolvedValue({ conversation: CONVERSATION, access: "owner" });
    const current = { id: ITEM, title: "Newer", outline: OUTLINE, version: 4, revision: 7, updatedBy: "agent", updatedAt: new Date(), pptx: false };
    saveDeckEdit.mockResolvedValue({ saved: false, current });

    expect(await saveDeck(input())).toEqual({
      ok: true,
      saved: false,
      current: { title: "Newer", outline: OUTLINE, version: 4, revision: 7, updatedBy: "agent" }
    });
  });

  it("should refuse an outline the plugin could not build, and one naming a picture the deck does not hold", async () => {
    access.mockResolvedValue({ conversation: CONVERSATION, access: "owner" });
    expect(await saveDeck(input({ outline: { ...OUTLINE, title: "" } }))).toEqual({ ok: false, error: "outline.title must be non-empty text" });

    saveDeckEdit.mockRejectedValue(new DeckAssetsMissing(["a".repeat(64)]));
    expect(await saveDeck(input())).toEqual({ ok: false, error: "the slides name a picture that is no longer kept; remove it, then they will save" });
  });

  it("should refuse a deck id that is not a uuid before looking the chat up", async () => {
    expect(await saveDeck(input({ itemId: "not-a-uuid" }))).toEqual({ ok: false, error: "those slides are not there" });
    expect(access).not.toHaveBeenCalled();
  });

  it("should say the workspace is off when virtual agents are", async () => {
    enabled = false;
    expect(await saveDeck(input())).toEqual({ ok: false, error: "the CFT Workspace is not available on this deployment" });
  });
});

describe("removeDeck", () => {
  it("should remove the owner's deck, naming the conversation and the deck", async () => {
    access.mockResolvedValue({ conversation: CONVERSATION, access: "owner" });
    removeStoredDeck.mockResolvedValue(undefined);

    expect(await removeDeck({ conversationId: "c1", itemId: ITEM })).toEqual({ ok: true });
    expect(removeStoredDeck).toHaveBeenCalledWith({}, CONVERSATION, ITEM);
  });

  it("should refuse a share's reader, a stranger and an id that is not a uuid alike, removing nothing", async () => {
    for (const allowed of [{ conversation: CONVERSATION, access: "reader" }, undefined]) {
      access.mockResolvedValue(allowed);
      expect(await removeDeck({ conversationId: "c1", itemId: ITEM })).toEqual({ ok: false, error: "those slides are not there" });
    }
    access.mockResolvedValue({ conversation: CONVERSATION, access: "owner" });
    expect(await removeDeck({ conversationId: "c1", itemId: "nope" })).toEqual({ ok: false, error: "those slides are not there" });
    expect(removeStoredDeck).not.toHaveBeenCalled();
  });

  it("should say the workspace is off when virtual agents are", async () => {
    enabled = false;
    expect(await removeDeck({ conversationId: "c1", itemId: ITEM })).toEqual({ ok: false, error: "the CFT Workspace is not available on this deployment" });
  });
});
