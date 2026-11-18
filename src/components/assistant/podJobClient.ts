import type { PodJobRequest, PodJobView } from "@/assistant/pod-jobs";

/**
 * The browser's end of a pod job: ask the conversation's pod to run one, then wait for it. The wait hears the
 * `assistant_pod_job` frame on the tab's hub stream, and polls as well, since a frame sent while the stream was
 * reconnecting is gone. See "Pod jobs" in docs/agent-api.md.
 */

const POLL_MS = 2000;

/** A refusal: the hub's status and its words, for the panel to show. */
export class PodJobRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PodJobRefused";
    this.status = status;
  }
}

/** What waiting ends with: the job as it finished, or `missing` for one the hub no longer holds. */
export type PodJobOutcome = PodJobView | { job_id: string; status: "missing" };

/** Hears every `assistant_pod_job` frame on the tab's stream until the returned function is called. */
export type PodJobEvents = (listener: (data: unknown) => void) => () => void;

interface Options {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const base = (conversationId: string) => `/api/ui/assistant/pod-jobs/${encodeURIComponent(conversationId)}`;

async function refusal(response: Response): Promise<PodJobRefused> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return new PodJobRefused(response.status, typeof body.error === "string" ? body.error : "That did not work. Try again.");
}

/** Asks for a job. A refusal (400, 403, 404, 409, 429) is thrown as `PodJobRefused`. */
export async function requestPodJob(conversationId: string, kind: string, args: unknown, { signal, fetchImpl = fetch }: Options = {}): Promise<PodJobRequest> {
  const response = await fetchImpl(base(conversationId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, args }),
    ...(signal === undefined ? {} : { signal })
  });
  if (!response.ok) {
    throw await refusal(response);
  }
  return (await response.json()) as PodJobRequest;
}

/** Statuses a read is tried again after: the hub or its proxy failing for now, or asking for a slower pace. */
const transient = (status: number): boolean => status >= 500 || status === 429;

/** One read of a job; `undefined` when it is still pending, or the read failed in a way the next poll may not. */
async function readOnce(conversationId: string, jobId: string, fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<PodJobOutcome | undefined> {
  const response = await fetchImpl(`${base(conversationId)}/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    ...(signal === undefined ? {} : { signal })
  });
  if (response.status === 404) {
    return { job_id: jobId, status: "missing" };
  }
  if (transient(response.status)) {
    return undefined;
  }
  if (!response.ok) {
    throw await refusal(response);
  }
  const job = (await response.json()) as PodJobView;
  return job.status === "pending" ? undefined : job;
}

/**
 * Resolves once the job is no longer pending: read when its frame arrives on `events`, and every `pollMs` whether or
 * not one does. A network fault, a 5xx and a 429 are tried again on the next poll; any other 4xx but 404 is a refusal
 * and rejects as `PodJobRefused`, and `signal` aborting rejects with its reason.
 */
export function waitForPodJob(
  conversationId: string,
  jobId: string,
  { signal, fetchImpl = fetch, events, pollMs = POLL_MS }: Options & { events?: PodJobEvents; pollMs?: number } = {}
): Promise<PodJobOutcome> {
  return new Promise<PodJobOutcome>((resolve, reject) => {
    let done = false;
    let reading = false;
    let again = false;
    const stop = () => {
      done = true;
      clearInterval(poll);
      unsubscribe();
      signal?.removeEventListener("abort", aborted);
    };
    const check = async (): Promise<void> => {
      if (done) {
        return;
      }
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const outcome = await readOnce(conversationId, jobId, fetchImpl, signal);
        if (outcome !== undefined && !done) {
          stop();
          resolve(outcome);
        }
      } catch (error) {
        if (error instanceof PodJobRefused && !done) {
          stop();
          reject(error);
        }
      } finally {
        reading = false;
      }
      if (again) {
        again = false;
        await check();
      }
    };
    const aborted = () => {
      if (!done) {
        stop();
        reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
      }
    };
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const unsubscribe =
      events?.((data) => {
        if ((data as { job_id?: unknown } | null)?.job_id === jobId) {
          void check();
        }
      }) ?? (() => undefined);
    const poll = setInterval(() => void check(), pollMs);
    signal?.addEventListener("abort", aborted, { once: true });
    void check();
  });
}
