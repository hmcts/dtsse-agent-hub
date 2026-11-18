import { describe, expect, it } from "vitest";
import { checkVideoBegin, checkVideoPosted, formatStamp, MAX_CHAPTERS, MAX_VIDEO_BYTES, parseVideoPath, videoFileName, videoPath } from "./video.ts";

const CONVERSATION = "0f8a6a1e-0000-4000-8000-000000000001";
const VIDEO = "22222222-2222-4222-8222-222222222222";

const begin = (overrides: Record<string, unknown> = {}) => ({
  name: "pcs-journey",
  bytes: 1000,
  chapters: [{ at: 0, title: "Sign in" }],
  coverage: "# coverage",
  content_mismatches: "",
  ...overrides
});

function refusal(value: unknown): string {
  const checked = checkVideoBegin(value);
  if (checked.ok) {
    throw new Error("expected a refusal");
  }
  return checked.error;
}

describe("checkVideoBegin", () => {
  it("should accept a recording's description with and without the optional parts", () => {
    expect(checkVideoBegin(begin()).ok).toBe(true);
    expect(checkVideoBegin(begin({ captions: "WEBVTT", coverage_summary: "1 of 1 stories and 2 ACs are shown.", jira_key: "HDPI-1234" })).ok).toBe(true);
  });

  it.each([
    ["a size of zero", { bytes: 0 }, /^bytes/],
    ["a size past the cap", { bytes: MAX_VIDEO_BYTES + 1 }, /^bytes/],
    ["a blank name", { name: "  " }, /^name/],
    ["a jira key that is not one", { jira_key: "hdpi" }, /^jira_key must be a Jira issue key/],
    ["too many chapters", { chapters: Array.from({ length: MAX_CHAPTERS + 1 }, (_v, at) => ({ at, title: "x" })) }, /at most 200 chapters/],
    [
      "chapters out of order",
      {
        chapters: [
          { at: 5, title: "b" },
          { at: 1, title: "a" }
        ]
      },
      /time order/
    ],
    ["a NUL in the coverage", { coverage: `a${String.fromCharCode(0)}` }, /NUL/],
    ["a field it does not know", { extra: 1 }, /Unrecognized|extra/i]
  ])("should refuse %s", (_label, change, pattern) => {
    expect(refusal(begin(change))).toMatch(pattern);
  });
});

describe("checkVideoPosted", () => {
  it("should take an issue key and nothing else", () => {
    expect(checkVideoPosted({ issue_key: "HDPI-1" })).toEqual({ ok: true, value: { issue_key: "HDPI-1" } });
    expect(checkVideoPosted({ issue_key: "x" }).ok).toBe(false);
    expect(checkVideoPosted({}).ok).toBe(false);
  });
});

describe("video paths", () => {
  it("should name a blob by its conversation and video, and read the names back", () => {
    expect(videoPath(CONVERSATION, VIDEO)).toBe(`${CONVERSATION}/${VIDEO}.mp4`);
    expect(parseVideoPath(videoPath(CONVERSATION, VIDEO))).toEqual({ conversationId: CONVERSATION, videoId: VIDEO });
    expect(parseVideoPath("other/thing")).toBeUndefined();
    expect(parseVideoPath(`${CONVERSATION}/${VIDEO}.mov`)).toBeUndefined();
  });

  it("should make a file name that is safe and ends .mp4", () => {
    expect(videoFileName("PCS journey / v2.mp4")).toBe("PCS-journey-v2.mp4");
    expect(videoFileName("///")).toBe("journey-video.mp4");
  });
});

describe("formatStamp", () => {
  it("should write seconds as hours, minutes and seconds", () => {
    expect(formatStamp(0)).toBe("00:00:00");
    expect(formatStamp(65)).toBe("00:01:05");
    expect(formatStamp(3723)).toBe("01:02:03");
  });
});
