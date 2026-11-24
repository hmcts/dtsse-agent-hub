/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionsList } from "@/components/feedback/dev/MentionsList";
import type { FeedbackMentionView } from "@/feedback/mention-store";
import type { ActionResult } from "@/web/action";
import { ANN, BEN } from "./feedback-fixtures";

function mention(commentId: string, more: Partial<FeedbackMentionView> = {}): FeedbackMentionView {
  return {
    commentId,
    threadId: `t-${commentId}`,
    projectId: "p1",
    projectName: "Claims",
    pagePath: "/check",
    pageTitle: "Check your answers – Claims – GOV.UK",
    anchor: { selector: "#fee", text: "The court fee is £404.", tag: "p", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1000, height: 800 } },
    threadStatus: "open",
    author: BEN,
    body: `Over to you @${ANN.name}`,
    named: [ANN],
    createdAt: "2026-11-10T10:00:00.000Z",
    seen: false,
    href: `/assistant/feedback/p1?tab=comments&thread=t-${commentId}`,
    ...more
  };
}

let visibility: DocumentVisibilityState = "visible";
let markSeen: ReturnType<typeof vi.fn<(input: { commentIds: unknown }) => Promise<ActionResult>>>;

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  markSeen = vi.fn<(input: { commentIds: unknown }) => Promise<ActionResult>>().mockResolvedValue({ ok: true });
});

afterEach(() => cleanup());

describe("MentionsList", () => {
  it("should say who mentioned the viewer, where, about what, and link to it", () => {
    render(<MentionsList mentions={[mention("c1", { threadStatus: "resolved" })]} markSeen={markSeen} />);

    const card = within(screen.getByRole("article", { name: `${BEN.name} mentioned you` }));
    expect(card.getByText("Claims")).toBeTruthy();
    expect(card.getByText("On Check your answers, the text “The court fee is £404.” · resolved since")).toBeTruthy();
    expect(card.getByText(`@${ANN.name}`).tagName).toBe("STRONG");
    expect(card.getByRole("link", { name: "Open and reply" }).getAttribute("href")).toBe("/assistant/feedback/p1?tab=comments&thread=t-c1");
  });

  it("should mark the unseen ones it shows as seen, and keep calling them New while it is open", () => {
    const { rerender } = render(<MentionsList mentions={[mention("c2"), mention("c1", { seen: true })]} markSeen={markSeen} />);

    expect(markSeen).toHaveBeenCalledWith({ commentIds: ["c2"] });
    rerender(<MentionsList mentions={[mention("c2", { seen: true }), mention("c1", { seen: true })]} markSeen={markSeen} />);

    expect(markSeen).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("New")).toHaveLength(1);
  });

  it("should mark nothing when every mention is seen", () => {
    render(<MentionsList mentions={[mention("c1", { seen: true })]} markSeen={markSeen} />);

    expect(markSeen).not.toHaveBeenCalled();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("should wait for a hidden tab to be shown before marking anything seen", async () => {
    visibility = "hidden";
    render(<MentionsList mentions={[mention("c1")]} markSeen={markSeen} />);
    expect(markSeen).not.toHaveBeenCalled();

    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(markSeen).toHaveBeenCalledWith({ commentIds: ["c1"] });
  });

  it("should say so when nobody has mentioned the viewer", () => {
    render(<MentionsList mentions={[]} markSeen={markSeen} />);

    expect(screen.getByText(/Nobody has mentioned you yet/)).toBeTruthy();
  });
});
