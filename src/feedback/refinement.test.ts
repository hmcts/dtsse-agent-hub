import { describe, expect, it } from "vitest";
import { thread } from "../components/__tests__/feedback-fixtures.ts";
import { MAX_BODY } from "../messages/limits.ts";
import { checkTheme, MAX_QUOTED_COMMENT, MAX_REFINE_THREADS, MAX_THEME, refinementOrder, refinementRequest } from "./refinement.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const BEN = { oid: "ben", name: "Ben Reviewer" };

describe("checkTheme", () => {
  it("should trim a theme and run its whitespace together", () => {
    expect(checkTheme("  Court \n fees ")).toBe("Court fees");
  });

  it("should take null and a blank theme as clearing it", () => {
    expect(checkTheme(null)).toBeNull();
    expect(checkTheme("   ")).toBeNull();
  });

  it("should refuse a theme that is not text, or is too long", () => {
    expect(checkTheme(7)).toBeUndefined();
    expect(checkTheme("x".repeat(MAX_THEME + 1))).toBeUndefined();
    expect(checkTheme("x".repeat(MAX_THEME))).toHaveLength(MAX_THEME);
  });
});

describe("refinementOrder", () => {
  it("should put themed threads first, by theme, then by page and when they were raised", () => {
    const threads = [
      thread("none", { theme: null, pagePath: "/a" }),
      thread("fees-late", { theme: "Fees", pagePath: "/b", createdAt: "2026-11-10T11:00:00.000Z" }),
      thread("fees-early", { theme: "Fees", pagePath: "/b", createdAt: "2026-11-10T09:00:00.000Z" }),
      thread("access", { theme: "Access", pagePath: "/z" }),
      thread("fees-a", { theme: "Fees", pagePath: "/a" })
    ];

    expect(refinementOrder(threads).map((t) => t.id)).toEqual(["access", "fees-a", "fees-early", "fees-late", "none"]);
  });
});

describe("refinementRequest", () => {
  it("should ask for a summary, options, a recommendation and a story in the document, then list the comments by theme", () => {
    const request = refinementRequest({
      projectName: "Claims",
      threads: [
        thread("a", {
          theme: "Fees",
          pagePath: "/check",
          pageTitle: "Check your answers – Claims – GOV.UK",
          anchor: { ...thread("a").anchor, tag: "p", text: "The fee is £404." },
          comments: [
            { id: "c1", author: BEN, body: "Fee shown\n too late", createdAt: "2026-11-10T10:00:00.000Z", mentions: [] },
            { id: "c2", author: { oid: "ann", name: "Ann Reviewer" }, body: "Agreed", createdAt: "2026-11-10T10:00:00.000Z", mentions: [] }
          ]
        }),
        thread("b", { status: "resolved" })
      ],
      linkLabel: null,
      now: NOW
    });

    expect(request.product).toBe("general");
    expect(request.title).toBe("Refine feedback: Claims, Friday 20 November");
    expect(request.body).toContain('prototype "Claims" into Jira stories. Below are 2 comments');
    expect(request.body).toContain("Each theme is one Jira story.");
    expect(request.body).toContain("Keep the team's themes exactly as they are");
    expect(request.body).toContain("group those into suggested themes of their own");
    expect(request.body).toContain("1. Say what the requirement is");
    expect(request.body).toContain("Suggest 2 or 3 options");
    expect(request.body).toContain("Given, When, Then");
    expect(request.body).toContain("Put each story in its own ticket document in the document panel, titled with its theme");
    expect(request.body).toContain(
      '\n\nTheme: Fees\n[1] On Check your answers (/check), the text “The fee is £404.” — Ben Reviewer: "Fee shown / too late"\n    Reply from Ann Reviewer: "Agreed"'
    );
    expect(request.body).toContain("\n\nTheme: No theme\n[2] On /start, the text “text of b” (resolved) — Ann Reviewer:");
    expect(request.body).not.toContain("left out");
  });

  it("should name each comment's link when asked, and say so of a thread with no comment", () => {
    const request = refinementRequest({ projectName: "Claims", threads: [thread("a", { comments: [] })], linkLabel: () => "Version 2", now: NOW });

    expect(request.body).toContain("Below is 1 comment");
    expect(request.body).toContain("[1] On /start, Version 2, the text “text of a” — no comment");
  });

  it("should cut a long comment short, and leave out whole threads to stay under the message limit", () => {
    const long = "x".repeat(MAX_QUOTED_COMMENT + 500);
    const threads = Array.from({ length: MAX_REFINE_THREADS }, (_, index) =>
      thread(`t${String(index).padStart(2, "0")}`, {
        comments: [{ id: `c${index}`, author: BEN, body: long, createdAt: "2026-11-10T10:00:00.000Z", mentions: [] }]
      })
    );

    const request = refinementRequest({ projectName: "Claims", threads, linkLabel: null, now: NOW });

    expect(request.body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(request.body).toContain(`"${"x".repeat(MAX_QUOTED_COMMENT)}…"`);
    expect(request.body).toMatch(/\(\d+ more comments were left out to keep this message short enough to send\.\)$/);
    const listed = request.body.match(/^\[\d+\] /gm)?.length ?? 0;
    expect(request.body).toContain(`Below are ${listed} comments`);
    expect(listed).toBeLessThan(MAX_REFINE_THREADS);
  });

  it("should take at most the threads one refinement takes, and say when one was left out to fit", () => {
    const body = "y".repeat(MAX_BODY / 21);
    const threads = Array.from({ length: 21 }, (_, index) =>
      thread(`t${String(index).padStart(2, "0")}`, { comments: [{ id: `c${index}`, author: BEN, body, createdAt: "2026-11-10T10:00:00.000Z", mentions: [] }] })
    );

    const request = refinementRequest({ projectName: "Claims", threads, linkLabel: null, now: NOW });

    expect(request.body).toMatch(/\(1 more comment was left out|more comments were left out/);
  });
});
