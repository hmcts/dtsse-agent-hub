import { describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_MS, MAX_SEGMENT_BYTES } from "./limits.ts";
import {
  completeFeedbackRecordingBody,
  createFeedbackProjectBody,
  createFeedbackThreadBody,
  feedbackLinkBody,
  feedbackMembersBody,
  feedbackReplyBody,
  feedbackSettingsBody,
  feedbackUploadBody,
  pagePath,
  patchFeedbackThreadBody,
  startFeedbackRecordingBody,
  targetUrl
} from "./schemas.ts";

const ANCHOR = {
  selector: "main > form button.govuk-button",
  text: "Continue",
  tag: "button",
  rect: { x: 10, y: 20.5, width: 120, height: 40 },
  viewport: { width: 1280, height: 800 }
};
const RECORDING = "5b0e8f0c-2d1f-4c8e-9a2b-6f4c1d2e3a4b";

describe("targetUrl", () => {
  it("should accept an https address", () => {
    expect(targetUrl.parse(" https://proto.herokuapp.com/start?x=1 ")).toBe("https://proto.herokuapp.com/start?x=1");
  });

  it.each([
    ["http", "http://proto.example"],
    ["not a URL", "proto.example"],
    ["carrying credentials", "https://user:pass@proto.example/"],
    ["another scheme", "javascript:alert(1)"]
  ])("should refuse an address that is %s", (_label, value) => {
    expect(targetUrl.safeParse(value).success).toBe(false);
  });

  it("should accept an http address when private targets are allowed, as on a developer's machine", () => {
    vi.stubEnv("FEEDBACK_ALLOW_PRIVATE_TARGETS", "true");
    vi.stubEnv("NODE_ENV", "development");
    try {
      expect(targetUrl.parse("http://localhost:4100/")).toBe("http://localhost:4100/");
      expect(targetUrl.safeParse("http://user:pass@localhost:4100/").success).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should refuse an http address in production whatever FEEDBACK_ALLOW_PRIVATE_TARGETS says", () => {
    vi.stubEnv("FEEDBACK_ALLOW_PRIVATE_TARGETS", "true");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(targetUrl.safeParse("http://localhost:4100/").success).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("pagePath", () => {
  it("should accept a root-relative path with a query", () => {
    expect(pagePath.parse("/start?step=2")).toBe("/start?step=2");
  });

  it.each([
    ["relative", "start"],
    ["protocol-relative", "//evil.example/"],
    ["with a newline", "/a\nb"],
    ["empty", ""]
  ])("should refuse a path that is %s", (_label, value) => {
    expect(pagePath.safeParse(value).success).toBe(false);
  });
});

describe("feedbackLinkBody", () => {
  it("should parse to the store's input with no version when none is given", () => {
    expect(feedbackLinkBody.parse({ label: " Start ", url: "https://proto.example/" })).toEqual({
      label: "Start",
      targetUrl: "https://proto.example/",
      prototypeVersion: null
    });
  });

  it("should refuse a label over 80 characters", () => {
    expect(feedbackLinkBody.safeParse({ label: "x".repeat(81), url: "https://proto.example/" }).success).toBe(false);
  });
});

describe("createFeedbackProjectBody", () => {
  it("should fill the defaults when only a name and a link are given", () => {
    expect(createFeedbackProjectBody.parse({ name: "Claims", links: [{ label: "v1", url: "https://proto.example/", prototype_version: "1.2" }] })).toEqual({
      name: "Claims",
      links: [{ label: "v1", targetUrl: "https://proto.example/", prototypeVersion: "1.2" }],
      memberOids: [],
      maskInputs: false,
      retentionDays: 90
    });
  });

  it("should keep the team, masking and retention when they are given", () => {
    const parsed = createFeedbackProjectBody.parse({
      name: "Claims",
      links: [{ label: "v1", url: "https://proto.example/" }],
      member_oids: ["oid-a"],
      mask_inputs: true,
      retention_days: 30
    });

    expect(parsed).toMatchObject({ memberOids: ["oid-a"], maskInputs: true, retentionDays: 30 });
  });

  it.each([
    ["no links", { name: "Claims", links: [] }],
    ["a retention over a year", { name: "Claims", links: [{ label: "v1", url: "https://proto.example/" }], retention_days: 366 }],
    ["an unknown field", { name: "Claims", links: [{ label: "v1", url: "https://proto.example/" }], owner_oid: "x" }]
  ])("should refuse a project with %s", (_label, body) => {
    expect(createFeedbackProjectBody.safeParse(body).success).toBe(false);
  });
});

describe("feedbackMembersBody", () => {
  it("should parse the team", () => {
    expect(feedbackMembersBody.parse({ member_oids: ["oid-a", "oid-b"] })).toEqual({ memberOids: ["oid-a", "oid-b"] });
  });
});

describe("feedbackSettingsBody", () => {
  it("should parse only what is changed", () => {
    expect(feedbackSettingsBody.parse({ mask_inputs: true })).toEqual({ name: undefined, maskInputs: true, retentionDays: undefined });
    expect(feedbackSettingsBody.parse({ name: "New", retention_days: 7 })).toEqual({ name: "New", maskInputs: undefined, retentionDays: 7 });
  });

  it("should refuse a change of nothing", () => {
    expect(feedbackSettingsBody.safeParse({}).success).toBe(false);
  });
});

describe("createFeedbackThreadBody", () => {
  it("should parse a thread with no snapshot or recording", () => {
    expect(createFeedbackThreadBody.parse({ page_path: "/start", anchor: ANCHOR, body: " Hard to find " })).toEqual({
      pagePath: "/start",
      anchor: ANCHOR,
      body: "Hard to find",
      snapshot: false,
      recordingId: null,
      offsetMs: null
    });
  });

  it("should keep the recording and its offset when both are given", () => {
    const parsed = createFeedbackThreadBody.parse({ page_path: "/", anchor: ANCHOR, body: "x", snapshot: true, recording_id: RECORDING, offset_ms: 1500 });

    expect(parsed).toMatchObject({ snapshot: true, recordingId: RECORDING, offsetMs: 1500 });
  });

  it.each([
    ["a recording with no offset", { recording_id: RECORDING }],
    ["an offset with no recording", { offset_ms: 10 }],
    ["an empty comment", { body: "  " }],
    ["a comment over 10,000 characters", { body: "x".repeat(10_001) }],
    ["an anchor with a negative width", { anchor: { ...ANCHOR, rect: { ...ANCHOR.rect, width: -1 } } }],
    ["an anchor with an upper-case tag", { anchor: { ...ANCHOR, tag: "BUTTON" } }]
  ])("should refuse %s", (_label, change) => {
    expect(createFeedbackThreadBody.safeParse({ page_path: "/", anchor: ANCHOR, body: "x", ...change }).success).toBe(false);
  });
});

describe("feedbackReplyBody", () => {
  it("should trim the reply", () => {
    expect(feedbackReplyBody.parse({ body: " ok " })).toEqual({ body: "ok" });
  });
});

describe("patchFeedbackThreadBody", () => {
  it("should parse a status change", () => {
    expect(patchFeedbackThreadBody.parse({ status: "resolved" })).toEqual({ status: "resolved" });
  });

  it("should parse a re-anchor, with or without a new page", () => {
    expect(patchFeedbackThreadBody.parse({ anchor: ANCHOR })).toEqual({ anchor: ANCHOR, pagePath: undefined });
    expect(patchFeedbackThreadBody.parse({ anchor: ANCHOR, page_path: "/next" })).toEqual({ anchor: ANCHOR, pagePath: "/next" });
  });

  it("should refuse a status and an anchor together, and an unknown status", () => {
    expect(patchFeedbackThreadBody.safeParse({ status: "open", anchor: ANCHOR }).success).toBe(false);
    expect(patchFeedbackThreadBody.safeParse({ status: "closed" }).success).toBe(false);
  });
});

describe("startFeedbackRecordingBody", () => {
  it("should take nothing", () => {
    expect(startFeedbackRecordingBody.parse({})).toEqual({});
    expect(startFeedbackRecordingBody.safeParse({ author_oid: "x" }).success).toBe(false);
  });
});

describe("feedbackUploadBody", () => {
  it("should parse a segment, with no page when none is given", () => {
    expect(feedbackUploadBody.parse({ kind: "audio", seq: 0, offset_ms: 0, bytes: 1 })).toEqual({
      kind: "audio",
      seq: 0,
      pagePath: null,
      offsetMs: 0,
      bytes: 1
    });
    expect(feedbackUploadBody.parse({ kind: "replay", seq: 3, page_path: "/a", offset_ms: 30_000, bytes: 900 })).toMatchObject({ pagePath: "/a" });
  });

  it.each([
    ["an unknown kind", { kind: "video" }],
    ["a segment number past the last", { seq: 10_000 }],
    ["an offset past the longest recording", { offset_ms: MAX_RECORDING_MS + 1 }],
    ["more bytes than a segment may hold", { bytes: MAX_SEGMENT_BYTES + 1 }],
    ["no bytes", { bytes: 0 }]
  ])("should refuse %s", (_label, change) => {
    expect(feedbackUploadBody.safeParse({ kind: "audio", seq: 0, offset_ms: 0, bytes: 1, ...change }).success).toBe(false);
  });
});

describe("completeFeedbackRecordingBody", () => {
  it("should parse the duration", () => {
    expect(completeFeedbackRecordingBody.parse({ duration_ms: 61_000 })).toEqual({ durationMs: 61_000 });
  });

  it("should refuse a duration past the longest recording", () => {
    expect(completeFeedbackRecordingBody.safeParse({ duration_ms: MAX_RECORDING_MS + 1 }).success).toBe(false);
  });
});
