import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPodJob, WAKING_RETRY_MS } from "@/components/assistant/podJobRun";

const requestPodJob = vi.hoisted(() => vi.fn());
vi.mock("@/components/assistant/podJobClient", () => ({ requestPodJob, waitForPodJob: vi.fn(), PodJobRefused: class extends Error {} }));

const WORDS = { unsupported: "u", noPod: "n", assistantGone: "g" };

beforeEach(() => {
  vi.useFakeTimers();
  requestPodJob.mockResolvedValue({ status: "waking" });
});
afterEach(() => {
  vi.useRealTimers();
  requestPodJob.mockReset();
});

describe("runPodJob on a pod that is still waking", () => {
  it("should keep asking for about three minutes, since a stopped pod takes longer than one, before it gives up", async () => {
    let result: Awaited<ReturnType<typeof runPodJob>> | undefined;
    void runPodJob("c", "k", {}, () => () => undefined, new AbortController().signal, WORDS).then((r) => {
      result = r;
    });

    await vi.advanceTimersByTimeAsync(170_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000 + WAKING_RETRY_MS);

    expect(result).toMatchObject({ ok: false, status: "waking" });
  });
});
