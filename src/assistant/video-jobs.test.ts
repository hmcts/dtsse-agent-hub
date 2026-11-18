import { describe, expect, it } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import { checkPodJobAnswer, checkPodJobArgs } from "./pod-jobs.ts";
import { VIDEO_ATTACH, VIDEO_ATTACH_ERRORS } from "./video-jobs.ts";

const VIDEO = "22222222-2222-4222-8222-222222222222";

function refused(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("jira.attach-video", () => {
  it("should take an issue key and a video id when the args have no other field", () => {
    expect(checkPodJobArgs(VIDEO_ATTACH, { issue_key: "HDPI-1234", video_id: VIDEO })).toEqual({ issue_key: "HDPI-1234", video_id: VIDEO });
    expect(refused(() => checkPodJobArgs(VIDEO_ATTACH, { issue_key: "hdpi-1", video_id: VIDEO })).message).toMatch(
      /^args\.issue_key: must be a Jira issue key/
    );
    expect(refused(() => checkPodJobArgs(VIDEO_ATTACH, { issue_key: "HDPI-1", video_id: "x" })).status).toBe(400);
    expect(refused(() => checkPodJobArgs(VIDEO_ATTACH, { issue_key: "HDPI-1", video_id: VIDEO, project: "X" })).status).toBe(400);
  });

  it("should refuse an answer with more than the issue and the comment flag when the job is done", () => {
    const result = { issue_key: "HDPI-1234", url: "https://hmcts.atlassian.net/browse/HDPI-1234", commented: false };
    expect(checkPodJobAnswer(VIDEO_ATTACH, { status: "done", result })).toEqual({ status: "done", result });
    expect(refused(() => checkPodJobAnswer(VIDEO_ATTACH, { status: "done", result: { ...result, extra: 1 } })).status).toBe(400);
  });

  it("should keep each of its codes and store any other as failed when the pod answers failed", () => {
    for (const code of VIDEO_ATTACH_ERRORS) {
      expect(checkPodJobAnswer(VIDEO_ATTACH, { status: "failed", error: code, detail: "words" })).toEqual({ status: "failed", error: code, detail: "words" });
    }
    expect(checkPodJobAnswer(VIDEO_ATTACH, { status: "failed", error: "busy" })).toEqual({ status: "failed", error: "failed" });
  });

  it("should run one at a time with time for a sign-in and a large upload when a post is asked for", () => {
    expect(VIDEO_ATTACH.oneAtATime).toBe(true);
    expect(VIDEO_ATTACH.timeoutMs).toBe(15 * 60_000);
  });
});

describe("the precheck", () => {
  const ask = async (count: number) => {
    const db = { assistantVideo: { count: async () => count } } as unknown as Database;
    return await VIDEO_ATTACH.precheck?.(db, { viewerOid: "o", conversationId: "c", args: { issue_key: "HDPI-1", video_id: VIDEO } });
  };

  it("should refuse with a 404 when the conversation has no ready video of that id", async () => {
    expect(await ask(1)).toBeUndefined();
    expect(await ask(0)).toMatchObject({ status: 404 });
  });
});
