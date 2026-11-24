import { describe, expect, it } from "vitest";
import { mentionHref } from "./mention-store.ts";

describe("mentionHref", () => {
  const mention = { projectId: "p-1", threadId: "t-1", token: "tok", pagePath: "/check?step=2" };

  it("should open the team on the comment, on its project's comments tab", () => {
    expect(mentionHref("team", mention)).toBe("/assistant/feedback/p-1?tab=comments&thread=t-1");
  });

  it("should open a reviewer on the page of the link the comment is on", () => {
    expect(mentionHref("reviewer", mention)).toBe("/review/tok?path=%2Fcheck%3Fstep%3D2");
  });
});
