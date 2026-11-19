import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.ts";
import type { RunResult } from "../virtual/process.ts";
import type { VideoResponse } from "../wire.ts";
import { type PodJobContext, PodJobError } from "./pod-jobs.ts";
import { commentBody, parseAttachArgs, videoAttachHandler } from "./video-attach.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const BYTES = Buffer.from("mp4 bytes");

const ok: RunResult = { code: 0, stdout: "", stderr: "" };

function videoResponse(overrides: Partial<VideoResponse> = {}): VideoResponse {
  return {
    video_id: VIDEO,
    name: "PCS journey / v2",
    bytes: BYTES.length,
    has_captions: true,
    chapters: [
      { at: 0, title: "Sign in" },
      { at: 75, title: "Submit" }
    ],
    coverage: "",
    coverage_summary: "2 of 3 stories and 7 ACs are shown.",
    content_mismatches: "",
    jira_key: null,
    posted: null,
    finished_at: "2026-11-18T12:00:00.000Z",
    download_url: "https://blobs.example/video?sig=x",
    ...overrides
  };
}

describe("video-attach", () => {
  let dir: string;
  let tmp: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-"));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-tmp-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setup({
    video = videoResponse(),
    getVideo,
    runs = {},
    fetchStatus = 200,
    body = BYTES,
    noAgent = false
  }: {
    video?: VideoResponse;
    getVideo?: () => Promise<VideoResponse>;
    runs?: { whoami?: RunResult; upload?: RunResult; comment?: RunResult };
    fetchStatus?: number;
    body?: Buffer;
    noAgent?: boolean;
  } = {}) {
    const calls: { cmd: string; args: string[] }[] = [];
    const posted: string[] = [];
    const login = vi.fn(async () => "restored" as const);
    const handler = videoAttachHandler({
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === "whoami") {
          return runs.whoami ?? ok;
        }
        return (args[2] === "attachment" ? runs.upload : runs.comment) ?? ok;
      },
      login,
      fetchImpl: (async () => new Response(fetchStatus === 200 ? body : "no", { status: fetchStatus })) as typeof fetch,
      dir,
      tmp
    });
    const context: PodJobContext = {
      jobId: JOB,
      conversationId: "33333333-3333-4333-8333-333333333333",
      agentId: noAgent ? undefined : "agent-1",
      signal: new AbortController().signal,
      api: {
        getVideo: getVideo ?? (async () => video),
        videoPosted: async (_agent: string, _video: string, key: string) => {
          posted.push(key);
          return null;
        }
      } as unknown as PodJobContext["api"],
      env: {},
      say: () => undefined
    };
    return { handler, context, calls, posted, login };
  }

  it("should download the video, attach it and comment, when the owner is signed in", async () => {
    // Arrange
    const { handler, context, calls, posted } = setup();

    // Act
    const result = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context);

    // Assert
    expect(result).toEqual({ issue_key: "HDPI-1234", url: "https://hmcts.atlassian.net/browse/HDPI-1234", commented: true });
    const upload = calls.find((call) => call.args[2] === "attachment");
    expect(upload?.args.slice(0, 5)).toEqual(["jira", "workitem", "attachment", "upload", "--issue-id=HDPI-1234"]);
    expect(upload?.args[5]).toMatch(/PCS-journey-v2\.mp4$/);
    const comment = calls.find((call) => call.args[2] === "comment");
    expect(comment?.args.find((arg) => arg.startsWith("--body="))).toBe(
      "--body=Journey video attached: PCS-journey-v2.mp4\n\nChapters\n- 00:00:00 Sign in\n- 00:01:15 Submit\n\nCoverage: 2 of 3 stories and 7 ACs are shown."
    );
    expect(posted).toEqual(["HDPI-1234"]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("should answer what the first run did and attach nothing again, when the same job id runs twice", async () => {
    // Arrange
    const { handler, context, calls } = setup();
    await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context);
    const before = calls.length;

    // Act
    const again = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context);

    // Assert
    expect(again).toMatchObject({ issue_key: "HDPI-1234", commented: true });
    expect(calls).toHaveLength(before);
  });

  it("should report the video attached but not commented, when only the comment fails", async () => {
    // Arrange
    const { handler, context } = setup({ runs: { comment: { code: 1, stdout: "", stderr: "boom" } } });

    // Act
    const result = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context);

    // Assert
    expect(result).toMatchObject({ commented: false });
  });

  it.each([
    ["the issue is not found", { code: 1, stdout: "", stderr: "Issue does not exist" }, "issue_not_found"],
    ["Jira refuses", { code: 1, stdout: "", stderr: "403 Forbidden" }, "forbidden"],
    ["twg fails otherwise", { code: 1, stdout: "", stderr: "weird" }, "upload_failed"],
    ["twg is not installed", { code: 127, stdout: "", stderr: "" }, "twg_missing"]
  ])("should fail with a code of its own, when %s", async (_label, upload, code) => {
    // Arrange
    const { handler, context } = setup({ runs: { upload } });

    // Act
    const failure = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context).catch((e: unknown) => e);

    // Assert
    expect(failure).toBeInstanceOf(PodJobError);
    expect((failure as PodJobError).code).toBe(code);
  });

  it("should fail not_signed_in without attaching, when twg is not signed in and the sign-in does not complete", async () => {
    // Arrange
    const { handler, context, calls, login } = setup({ runs: { whoami: { code: 1, stdout: "", stderr: "" } } });
    login.mockResolvedValue("not-signed-in" as never);

    // Act
    const failure = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context).catch((e: unknown) => e);

    // Assert
    expect((failure as PodJobError).code).toBe("not_signed_in");
    expect(calls.some((call) => call.args[2] === "attachment")).toBe(false);
  });

  it("should fail video_gone, when the hub has no video or another one", async () => {
    // Arrange
    const missing = setup({
      getVideo: async () => {
        throw new ApiError(404, { error: "none" }, "GET", "/video");
      }
    });
    const changed = setup({ video: videoResponse({ video_id: "44444444-4444-4444-8444-444444444444" }) });

    // Act
    const a = await missing.handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, missing.context).catch((e: unknown) => e);
    const b = await changed.handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, changed.context).catch((e: unknown) => e);

    // Assert
    expect([(a as PodJobError).code, (b as PodJobError).code]).toEqual(["video_gone", "video_gone"]);
  });

  it("should fail download_failed, when storage refuses or the file is short", async () => {
    // Arrange
    const refused = setup({ fetchStatus: 403 });
    const short = setup({ body: Buffer.from("x") });

    // Act
    const a = await refused.handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, refused.context).catch((e: unknown) => e);
    const b = await short.handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, short.context).catch((e: unknown) => e);

    // Assert
    expect([(a as PodJobError).code, (b as PodJobError).code]).toEqual(["download_failed", "download_failed"]);
  });

  it("should not download the video, when twg is not signed in", async () => {
    // Arrange
    const { handler, context, login } = setup({ runs: { whoami: { code: 1, stdout: "", stderr: "" } }, fetchStatus: 403 });
    login.mockResolvedValue("not-signed-in" as never);

    // Act
    const failure = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context).catch((e: unknown) => e);

    // Assert
    expect((failure as PodJobError).code).toBe("not_signed_in");
  });

  it("should fail no_session, when the frame carried no agent", async () => {
    // Arrange
    const { handler, context } = setup({ noAgent: true });

    // Act
    const failure = await handler.run({ issue_key: "HDPI-1234", video_id: VIDEO }, context).catch((e: unknown) => e);

    // Assert
    expect((failure as PodJobError).code).toBe("no_session");
  });

  it("should refuse arguments it cannot run when they are wrong", () => {
    expect(parseAttachArgs({ issue_key: "HDPI-1", video_id: VIDEO })).toEqual({ issueKey: "HDPI-1", videoId: VIDEO });
    for (const bad of [
      null,
      [],
      {},
      { issue_key: "hdpi-1", video_id: VIDEO },
      { issue_key: "HDPI-1", video_id: "x" },
      { issue_key: "HDPI-1", video_id: VIDEO, more: 1 }
    ]) {
      expect(parseAttachArgs(bad)).toBeNull();
    }
  });

  it("should leave the chapters and coverage out of the comment, when there are none", () => {
    expect(commentBody("a.mp4", [], null)).toBe("Journey video attached: a.mp4");
  });
});
