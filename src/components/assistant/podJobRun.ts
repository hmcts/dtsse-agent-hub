import { jobFailure } from "@/components/assistant/notify-data";
import { type PodJobEvents, PodJobRefused, requestPodJob, waitForPodJob } from "@/components/assistant/podJobClient";

/** How often a pod that is still waking is asked again, and how many times, past the hub's 30 seconds of grace. */
export const WAKING_RETRY_MS = 3000;
const WAKING_ATTEMPTS = 20;

export type JobResult<T> = { ok: true; result: T } | { ok: false; message: string; status?: "unsupported" | "no_pod" | "assistant_gone" | "waking" };

/** What the person is told when the job cannot be asked for, in the feature's own words. */
export interface PodJobWords {
  unsupported: string;
  noPod: string;
  assistantGone: string;
  /** Words for a job's own error code; the generic ones are used for the rest. */
  failure?: (outcome: Parameters<typeof jobFailure>[0]) => string;
  /** Called each time the pod is found still starting, so the panel can say so. */
  onWaking?: () => void;
}

/**
 * One pod job from asking to answer. A pod still waking is asked again every `WAKING_RETRY_MS`, which is how the first
 * ask after its first status report goes through; a refusal, a pod that cannot run the kind, and a job that ends in
 * anything but `done` come back as words to show.
 */
export async function runPodJob<T>(
  conversationId: string,
  kind: string,
  args: unknown,
  events: PodJobEvents,
  signal: AbortSignal,
  words: PodJobWords
): Promise<JobResult<T>> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      const asked = await requestPodJob(conversationId, kind, args, { signal });
      if (asked.status === "waking") {
        words.onWaking?.();
        if (attempt + 1 >= WAKING_ATTEMPTS) {
          return { ok: false, status: "waking", message: "Your assistant is still starting. Try again in a moment." };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, WAKING_RETRY_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true }
          );
        });
        continue;
      }
      if (asked.status === "unsupported") {
        return { ok: false, status: "unsupported", message: words.unsupported };
      }
      if (asked.status === "no_pod") {
        return { ok: false, status: "no_pod", message: words.noPod };
      }
      if (asked.status === "assistant_gone") {
        return { ok: false, status: "assistant_gone", message: words.assistantGone };
      }
      const outcome = await waitForPodJob(conversationId, asked.job_id, { signal, events });
      if (outcome.status === "done") {
        return { ok: true, result: outcome.result as T };
      }
      return { ok: false, message: (words.failure ?? jobFailure)(outcome) };
    }
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return { ok: false, message: error instanceof PodJobRefused ? error.message : "Your assistant could not be reached. Try again." };
  }
}
