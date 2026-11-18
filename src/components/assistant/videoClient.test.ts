import { describe, expect, it, vi } from "vitest";
import { type PostOutcome, postFailureSentence, postVideo, readVideo } from "./videoClient.ts";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch answering each call with the next of `answers`, the last one over and over. */
function fakeFetch(...answers: (() => Response)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return (answers.length > 1 ? answers.shift() : answers[0])?.() as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const REQUEST = { issueKey: "HDPI-1", videoId: "22222222-2222-4222-8222-222222222222" };
const noWait = async () => undefined;

describe("readVideo", () => {
  it("should answer undefined when the hub answers 404, and throw when it refuses otherwise", async () => {
    expect(await readVideo("c/1", { fetchImpl: fakeFetch(() => reply(200, { video_id: "v" })).fetchImpl })).toEqual({ video_id: "v" });
    const missing = fakeFetch(() => reply(404, { error: "none" }));
    expect(await readVideo("c/1", { fetchImpl: missing.fetchImpl })).toBeUndefined();
    expect(missing.calls[0]?.url).toBe("/api/ui/assistant/video/c%2F1");
    await expect(readVideo("c/1", { fetchImpl: fakeFetch(() => reply(500, {})).fetchImpl })).rejects.toThrow(/answered 500/);
  });
});

describe("postVideo", () => {
  it("should ask for the job with the issue and video, and answer the issue when it is done", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => reply(200, { status: "pending", job_id: "j1" }),
      () => reply(200, { job_id: "j1", kind: "jira.attach-video", status: "done", result: { issue_key: "HDPI-1", url: "https://x/HDPI-1", commented: true } })
    );
    const onPending = vi.fn();

    const outcome = await postVideo("c1", REQUEST, { fetchImpl, onPending });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "jira.attach-video", args: { issue_key: "HDPI-1", video_id: REQUEST.videoId } });
    expect(outcome).toEqual({ status: "done", issueKey: "HDPI-1", url: "https://x/HDPI-1", commented: true });
    expect(onPending).toHaveBeenCalled();
  });

  it("should ask again when the assistant is waking, then run", async () => {
    const { fetchImpl } = fakeFetch(
      () => reply(200, { status: "waking" }),
      () => reply(200, { status: "pending", job_id: "j1" }),
      () => reply(200, { job_id: "j1", kind: "k", status: "done", result: { issue_key: "HDPI-1", url: "u", commented: false } })
    );
    const onWaking = vi.fn();

    const outcome = await postVideo("c1", REQUEST, { fetchImpl, onWaking, wait: noWait });

    expect(onWaking).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "done", commented: false });
  });

  it.each([
    ["unsupported", { status: "unsupported" }],
    ["no_pod", { status: "no_pod" }]
  ])("should answer %s when the hub says so", async (status, body) => {
    expect(await postVideo("c1", REQUEST, { fetchImpl: fakeFetch(() => reply(200, body)).fetchImpl })).toEqual({ status });
  });

  it("should answer a refusal with its status and words when the hub refuses the request", async () => {
    const outcome = await postVideo("c1", REQUEST, { fetchImpl: fakeFetch(() => reply(429, { error: "slow down" })).fetchImpl });
    expect(outcome).toEqual({ status: "refused", httpStatus: 429, error: "slow down" });
  });

  it("should answer a failed job with its code, a timeout as a failure and a lost job as missing when the job ends", async () => {
    const asked = () => reply(200, { status: "pending", job_id: "j1" });
    const failed = await postVideo("c1", REQUEST, {
      fetchImpl: fakeFetch(asked, () => reply(200, { job_id: "j1", kind: "k", status: "failed", error: "forbidden", detail: "no" })).fetchImpl
    });
    const timeout = await postVideo("c1", REQUEST, { fetchImpl: fakeFetch(asked, () => reply(200, { job_id: "j1", kind: "k", status: "timeout" })).fetchImpl });
    const missing = await postVideo("c1", REQUEST, { fetchImpl: fakeFetch(asked, () => reply(404, { error: "gone" })).fetchImpl });
    expect(failed).toEqual({ status: "failed", error: "forbidden", detail: "no" });
    expect(timeout).toEqual({ status: "failed", error: "timeout" });
    expect(missing).toEqual({ status: "missing" });
  });
});

describe("postFailureSentence", () => {
  const sentences = (outcomes: Exclude<PostOutcome, { status: "done" }>[]) => outcomes.map(postFailureSentence);

  it("should word a sentence for every outcome when the video was not attached", () => {
    const words = sentences([
      { status: "waking" },
      { status: "unsupported" },
      { status: "no_pod" },
      { status: "assistant_gone" },
      { status: "missing" },
      { status: "refused", httpStatus: 429, error: "x" },
      { status: "refused", httpStatus: 404, error: "that video is gone" },
      { status: "failed", error: "not_signed_in" },
      { status: "failed", error: "issue_not_found" },
      { status: "failed", error: "forbidden" },
      { status: "failed", error: "video_gone" },
      { status: "failed", error: "download_failed" },
      { status: "failed", error: "timeout" },
      { status: "failed", error: "upload_failed", detail: "Jira would not take it" },
      { status: "failed", error: "failed" }
    ]);
    expect(new Set(words).size).toBe(words.length);
    expect(words[6]).toBe("That video is gone.");
    expect(words[13]).toBe("Jira would not take it.");
  });
});
