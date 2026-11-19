// The supervisor's half of a pod job: a job an Assistant panel asked the conversation's pod to run with its owner's
// own credentials, which the hub does not hold. One runner for every kind; a feature adds a handler for its kind to
// `pod-job-handlers.ts`, and the pod claims `pod-job:<kind>` for each one there. See "Pod jobs" in dtsse-agent-hub's
// docs/agent-api.md.
import type { Api } from "../api.ts";
import type { Env } from "../env.ts";

import { withRetry } from "../retry.ts";
import { POD_JOB_KIND_RE, type PodJobAnswer, type PodJobFrame } from "../wire.ts";
import { reason, safeSay } from "./plugin-deps.ts";

/** The hub's limits: an error code, and the words beside it. */
const ERROR_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_DETAIL = 300;
const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export const TOO_SLOW = "That took too long. Try again.";
export const NO_HANDLER = "Your assistant cannot do that yet. Restart it to update it, then try again.";
export const REFUSED = "The hub would not take your assistant's answer. Try again.";
export const STOPPED = "Your assistant stopped before it finished. Try again.";
export const BUSY = "Your assistant is busy with others of these. Wait for them to finish, then try again.";

/** How many jobs of one kind may wait for a slot; the next is answered `failed` with `BUSY`. */
export const MAX_WAITING = 10;
/** How many job ids are remembered, so a frame the hub sends again is not run twice. */
const REMEMBERED = 1000;

/** How long the supervisor's shutdown waits for the hub to take the answers to the jobs it ends. */
export const STOP_ANSWER_MS = 5000;

/**
 * What a handler throws to answer `failed` with a code of its kind's own, which the panel branches on, and words for
 * the person in `detail`. The hub stores a code its definition of the kind does not list as `failed`, keeping the
 * words. Anything else a handler throws answers `failed`.
 */
export class PodJobError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.name = "PodJobError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The agent API a handler writes into its conversation through, on the conversation's agent (`agentId`), with the
 * supervisor's own client. A handler that needs another call adds it here and to the supervisor's `api`.
 */
export type PodJobHandlerApi = Pick<
  Api,
  | "getArtefact"
  | "putArtefact"
  | "getDocmosis"
  | "putDocmosis"
  | "createDocmosis"
  | "putDocmosisAsset"
  | "docmosisAsset"
  | "putDocmosisPdf"
  | "listNotify"
  | "getNotifyById"
  | "putNotifyById"
  | "createNotify"
  | "getVideo"
  | "videoPosted"
  | "postQuestion"
>;

export type PodJobContext = {
  jobId: string;
  conversationId: string;
  /** The conversation's current session agent, the frame's `agent_id`; `undefined` when the conversation has none yet. */
  agentId: string | undefined;
  /** Aborted once the job's budget has run out, or the supervisor is stopping; the answer is already sent by then. */
  signal: AbortSignal;
  api: PodJobHandlerApi;
  env: Env;
  say: (message: string) => void;
};

export type PodJobHandler = {
  kind: string;
  /** Under the hub's `timeoutMs` for the kind, from when the frame arrived, so an answer is never thrown away. */
  budgetMs: number;
  /** How many of this kind run at once; the rest wait their turn, inside their budget. 1 when not given. */
  concurrency?: number;
  /** The result to answer `done` with. The hub checked `args` against the kind's schema; check them again here. */
  run: (args: unknown, context: PodJobContext) => Promise<unknown>;
};

/** The job on a sessions stream frame, or null for anything that is not exactly one. */
export function parsePodJobFrame(value: unknown): PodJobFrame | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (
    !raw ||
    typeof raw.job_id !== "string" ||
    !UUID_RE.test(raw.job_id) ||
    typeof raw.conversation_id !== "string" ||
    !UUID_RE.test(raw.conversation_id) ||
    typeof raw.kind !== "string" ||
    !POD_JOB_KIND_RE.test(raw.kind) ||
    (raw.agent_id !== undefined && (typeof raw.agent_id !== "string" || !UUID_RE.test(raw.agent_id)))
  ) {
    return null;
  }
  return {
    job_id: raw.job_id,
    kind: raw.kind,
    conversation_id: raw.conversation_id,
    ...(raw.agent_id === undefined ? {} : { agent_id: raw.agent_id as string }),
    args: raw.args ?? {}
  };
}

/** At most `MAX_DETAIL` UTF-16 units, the hub's measure, cut between code points: the hub refuses half a surrogate pair. */
function clip(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.length <= MAX_DETAIL) {
    return trimmed;
  }
  let kept = "";
  for (const point of trimmed) {
    if (kept.length + point.length > MAX_DETAIL - 1) {
      break;
    }
    kept += point;
  }
  return `${kept}…`;
}

function failed(error: string, detail: string | undefined): PodJobAnswer {
  const words = detail === undefined ? undefined : clip(detail);
  return words === undefined ? { status: "failed", error } : { status: "failed", error, detail: words };
}

/** What a handler's throw answers: its own code when it is one, `failed` otherwise. */
export function failureOf(e: unknown): PodJobAnswer {
  if (e instanceof PodJobError && ERROR_RE.test(e.code)) {
    return failed(e.code, e.detail);
  }
  return failed("failed", reason(e));
}

export type PodJobDeps = {
  api: Pick<Api, "putPodJob"> & PodJobHandlerApi;
  /** The virtual agent's id. */
  id: string;
  env: Env;
  handlers: readonly PodJobHandler[];
  say?: (message: string) => void;
  /** Milliseconds since the epoch, for each job's budget; a test passes its own. */
  clock?: () => number;
  /** How the answer is retried; a test passes no wait. */
  retryWait?: (ms: number) => Promise<void>;
};

export type PodJobRunner = {
  /**
   * Takes a `pod_job` frame's data and runs it once a slot of its kind is free. A `job_id` already running, waiting or
   * answered is ignored: the hub sends every pending job again on each sessions stream it opens.
   */
  podJob: (data: unknown) => void;
  /**
   * For the supervisor's shutdown: answers every job running or waiting as `failed` (`STOPPED`), aborts their
   * handlers, and answers any frame after it the same way. Resolves once those answers are sent, or after `withinMs`
   * whatever is still retrying, since the pod is being stopped either way.
   */
  stop: (withinMs?: number) => Promise<void>;
  /** Resolves once nothing is running or waiting, every handler's promise settled; for a test. */
  idle: () => Promise<void>;
};

const status = (e: unknown): unknown => (e as { status?: unknown } | null | undefined)?.status;

/**
 * A job from its frame's arrival to its answer: whichever of its handler, its budget and a stop ends it first. The
 * budget runs from the arrival, whether or not the job has a slot yet, and its timer is cleared as the job ends.
 */
type Job = { over: boolean; end: (answer: PodJobAnswer) => void; ended: Promise<PodJobAnswer>; controller: AbortController };

function startJob(budgetMs: number): Job {
  let resolve: (answer: PodJobAnswer) => void = () => undefined;
  const ended = new Promise<PodJobAnswer>((r) => {
    resolve = r;
  });
  const controller = new AbortController();
  let budget: NodeJS.Timeout | undefined;
  const job: Job = {
    over: false,
    ended,
    controller,
    end: (answer) => {
      if (!job.over) {
        job.over = true;
        clearTimeout(budget);
        resolve(answer);
      }
    }
  };
  budget = setTimeout(() => {
    job.end(failed("timeout", TOO_SLOW));
    controller.abort();
  }, budgetMs);
  return job;
}

/**
 * Runs pod jobs beside the supervisor, each kind with its own number of slots, and answers each one: its result, its
 * handler's code, `timeout` once its budget is spent, or `failed`. Never throws.
 *
 * A slot is held until its handler's promise settles, not until the job is answered: a handler past its budget is
 * answered `timeout` at once but may still be running, and the next job of its kind waits for it, so `concurrency`
 * is how many handlers of a kind are ever running at once. A job waiting for a slot is on its budget all the same, so
 * a handler that never settles costs the jobs behind it their budgets and nothing more, and at most `MAX_WAITING` wait.
 */
export function createPodJobRunner(deps: PodJobDeps): PodJobRunner {
  const say = safeSay(deps.say);
  const clock = deps.clock ?? Date.now;
  const handlers = new Map(deps.handlers.map((handler) => [handler.kind, handler]));
  const slots = new Map<string, { running: number; waiting: (() => void)[] }>();
  const live = new Set<Job>();
  const answering = new Set<Promise<void>>();
  const handling = new Set<Promise<unknown>>();
  // Running, waiting or answered, oldest first. One whose answer never reached the hub is forgotten, so that the hub's
  // resend of the job, still pending to it, runs it again.
  const seen = new Set<string>();
  let stopping = false;

  const track = <T>(set: Set<Promise<T>>, work: Promise<T>): void => {
    const tracked = work.finally(() => set.delete(tracked));
    set.add(tracked);
  };

  /** Whether the hub took an answer to the job, `body` or the plain one standing in for it. */
  async function answer(frame: PodJobFrame, body: PodJobAnswer): Promise<boolean> {
    const put = (value: PodJobAnswer) =>
      withRetry(() => deps.api.putPodJob(deps.id, frame.job_id, value), { attempts: 3, ...(deps.retryWait ? { wait: deps.retryWait } : {}) });
    let fault: unknown;
    try {
      await put(body);
      return true;
    } catch (e) {
      fault = e;
    }
    // An answer the hub would not take, a result too big or not the kind's shape, or words it cannot store, still
    // ends the job for the person waiting, as the one answer every hub takes.
    const plain = body.status === "failed" && body.error === "failed" && body.detail === REFUSED;
    if ((status(fault) === 400 || status(fault) === 413) && !plain) {
      say(`pod job ${frame.job_id}: the hub refused its answer: ${reason(fault)}`);
      try {
        await put(failed("failed", REFUSED));
        return true;
      } catch (e) {
        fault = e;
      }
    }
    say(`pod job ${frame.job_id}: could not answer it: ${reason(fault)}`);
    return false;
  }

  function slotOf(kind: string): { running: number; waiting: (() => void)[] } {
    let slot = slots.get(kind);
    if (!slot) {
      slot = { running: 0, waiting: [] };
      slots.set(kind, slot);
    }
    return slot;
  }

  /** A slot of `kind`, or `undefined` when `job` ended while it waited for one. */
  function take(kind: string, limit: number, job: Job): Promise<(() => void) | undefined> {
    const held = slotOf(kind);
    const release = () => {
      const next = held.waiting.shift();
      if (next) {
        next();
      } else {
        held.running -= 1;
      }
    };
    if (held.running < limit) {
      held.running += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const grant = () => resolve(release);
      held.waiting.push(grant);
      void job.ended.then(() => {
        const at = held.waiting.indexOf(grant);
        if (at >= 0) {
          held.waiting.splice(at, 1);
          resolve(undefined);
        }
      });
    });
  }

  /** Starts the handler, holding `release`'s slot until the handler settles. */
  function start(handler: PodJobHandler, frame: PodJobFrame, job: Job, release: () => void): void {
    const context: PodJobContext = {
      jobId: frame.job_id,
      conversationId: frame.conversation_id,
      agentId: frame.agent_id,
      signal: job.controller.signal,
      api: deps.api,
      env: deps.env,
      say
    };
    const ran = Promise.resolve()
      .then(() => handler.run(frame.args, context))
      .then(
        (result): PodJobAnswer => ({ status: "done", result }),
        (e: unknown) => failureOf(e)
      )
      .then(job.end)
      .finally(release);
    track(handling, ran);
  }

  /** The job's answer: `failed` before it starts, or whatever ends it once it has a slot or waits for one. */
  async function outcome(frame: PodJobFrame, arrived: number): Promise<PodJobAnswer> {
    const handler = handlers.get(frame.kind);
    if (!handler) {
      // The hub sends only a kind this pod claimed, so this is a hub ahead of the build it thinks this is.
      return failed("failed", NO_HANDLER);
    }
    if (stopping) {
      return failed("failed", STOPPED);
    }
    const limit = Math.max(1, handler.concurrency ?? 1);
    const slot = slotOf(frame.kind);
    if (slot.running >= limit && slot.waiting.length >= MAX_WAITING) {
      return failed("failed", BUSY);
    }
    const job = startJob(handler.budgetMs);
    live.add(job);
    const release = await take(frame.kind, limit, job);
    if (release !== undefined) {
      // A timer can fire late on a busy event loop, and a test's clock is not the timers'; the clock is the budget.
      if (clock() - arrived >= handler.budgetMs) {
        job.end(failed("timeout", TOO_SLOW));
      }
      if (job.over) {
        release();
      } else {
        start(handler, frame, job, release);
      }
    }
    const body = await job.ended;
    live.delete(job);
    return body;
  }

  async function run(frame: PodJobFrame, arrived: number): Promise<void> {
    if (!(await answer(frame, await outcome(frame, arrived)))) {
      seen.delete(frame.job_id);
    }
  }

  function remember(jobId: string): void {
    seen.add(jobId);
    if (seen.size > REMEMBERED) {
      const [oldest] = seen;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
  }

  return {
    podJob(data) {
      const frame = parsePodJobFrame(data);
      if (!frame) {
        say(`ignoring a pod job that is not one: ${JSON.stringify(data)?.slice(0, 200)}`);
        return;
      }
      if (seen.has(frame.job_id)) {
        return;
      }
      remember(frame.job_id);
      track(
        answering,
        run(frame, clock()).catch((e: unknown) => say(`pod job ${frame.job_id} failed: ${reason(e)}`))
      );
    },
    stop: async (withinMs = STOP_ANSWER_MS) => {
      stopping = true;
      for (const job of live) {
        job.end(failed("failed", STOPPED));
        job.controller.abort();
      }
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, withinMs);
      });
      try {
        await Promise.race([Promise.allSettled([...answering]), bound]);
      } finally {
        clearTimeout(timer);
      }
    },
    idle: async () => {
      while (answering.size > 0 || handling.size > 0) {
        await Promise.allSettled([...answering, ...handling]);
      }
    }
  };
}
