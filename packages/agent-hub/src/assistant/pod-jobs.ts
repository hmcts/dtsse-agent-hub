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

/**
 * What a handler throws to answer `failed` with a code of its kind's own: one of the codes the hub's definition of the
 * kind lists, which the panel branches on, and words for the person in `detail`. Anything else a handler throws
 * answers `failed`.
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

export type PodJobContext = {
  jobId: string;
  conversationId: string;
  /** The conversation's current session agent, when it has one. */
  agentId?: string;
  /** Aborted once the job's budget has run out; the answer is `timeout` by then whatever the handler does. */
  signal: AbortSignal;
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

const clip = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL - 1)}…` : trimmed;
};

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
  api: Pick<Api, "putPodJob">;
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
  /** Takes a `pod_job` frame's data and runs it once a slot of its kind is free. */
  podJob: (data: unknown) => void;
  /** Resolves once nothing is running or waiting; for a test, and for the supervisor's shutdown. */
  idle: () => Promise<void>;
};

const status = (e: unknown): unknown => (e as { status?: unknown } | null | undefined)?.status;

/**
 * Runs pod jobs beside the supervisor, each kind with its own number of slots, and answers each one: its result, its
 * handler's code, `timeout` once its budget is spent, or `failed`. Never throws.
 */
export function createPodJobRunner(deps: PodJobDeps): PodJobRunner {
  const say = safeSay(deps.say);
  const clock = deps.clock ?? Date.now;
  const handlers = new Map(deps.handlers.map((handler) => [handler.kind, handler]));
  const slots = new Map<string, { running: number; waiting: (() => void)[] }>();
  const inFlight = new Set<Promise<void>>();

  async function answer(frame: PodJobFrame, body: PodJobAnswer): Promise<void> {
    const put = (value: PodJobAnswer) =>
      withRetry(() => deps.api.putPodJob(deps.id, frame.job_id, value), { attempts: 3, ...(deps.retryWait ? { wait: deps.retryWait } : {}) });
    let fault: unknown;
    try {
      await put(body);
      return;
    } catch (e) {
      fault = e;
    }
    // A result the hub would not take, too big or not the kind's shape, still ends the job for the person waiting.
    if ((status(fault) === 400 || status(fault) === 413) && body.status === "done") {
      say(`pod job ${frame.job_id}: the hub refused its result: ${reason(fault)}`);
      try {
        await put(failed("failed", REFUSED));
        return;
      } catch (e) {
        fault = e;
      }
    }
    say(`pod job ${frame.job_id}: could not answer it: ${reason(fault)}`);
  }

  async function take(kind: string, limit: number): Promise<() => void> {
    let slot = slots.get(kind);
    if (!slot) {
      slot = { running: 0, waiting: [] };
      slots.set(kind, slot);
    }
    const held = slot;
    if (held.running >= limit) {
      await new Promise<void>((resolve) => held.waiting.push(resolve));
    } else {
      held.running += 1;
    }
    return () => {
      const next = held.waiting.shift();
      if (next) {
        next();
      } else {
        held.running -= 1;
      }
    };
  }

  async function runWithin(handler: PodJobHandler, frame: PodJobFrame, budgetMs: number): Promise<PodJobAnswer> {
    if (budgetMs <= 0) {
      return failed("timeout", TOO_SLOW);
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const outOfTime = new Promise<PodJobAnswer>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failed("timeout", TOO_SLOW));
      }, budgetMs);
    });
    const context: PodJobContext = {
      jobId: frame.job_id,
      conversationId: frame.conversation_id,
      ...(frame.agent_id === undefined ? {} : { agentId: frame.agent_id }),
      signal: controller.signal,
      env: deps.env,
      say
    };
    const ran = Promise.resolve()
      .then(() => handler.run(frame.args, context))
      .then(
        (result): PodJobAnswer => ({ status: "done", result }),
        (e: unknown) => failureOf(e)
      );
    try {
      return await Promise.race([ran, outOfTime]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(frame: PodJobFrame, arrived: number): Promise<void> {
    const handler = handlers.get(frame.kind);
    if (!handler) {
      // The hub sends only a kind this pod claimed, so this is a hub ahead of the build it thinks this is.
      await answer(frame, failed("failed", NO_HANDLER));
      return;
    }
    const release = await take(frame.kind, Math.max(1, handler.concurrency ?? 1));
    let body: PodJobAnswer;
    try {
      body = await runWithin(handler, frame, handler.budgetMs - (clock() - arrived));
    } finally {
      release();
    }
    await answer(frame, body);
  }

  return {
    podJob(data) {
      const frame = parsePodJobFrame(data);
      if (!frame) {
        say(`ignoring a pod job that is not one: ${JSON.stringify(data)?.slice(0, 200)}`);
        return;
      }
      const job = run(frame, clock())
        .catch((e: unknown) => say(`pod job ${frame.job_id} failed: ${reason(e)}`))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    },
    idle: async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    }
  };
}
