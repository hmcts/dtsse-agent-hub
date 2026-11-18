import { z } from "zod";
import { HttpError, MAX_REQUEST_BYTES } from "../agent-api/http.ts";
import type { PodJobFeature } from "../agents/client-features.ts";
import { jsonbText } from "./deck.ts";

/**
 * A job an Assistant panel asks the conversation's own pod to run, with its owner's own credentials (`gh`, `az`), which
 * the hub does not hold: a picker's list, a template loaded from a repository. One mechanism for every such job; a
 * feature registers a kind of it in `pod-job-kinds.ts` and a handler for it in the client package's
 * `src/assistant/pod-job-handlers.ts`. See "Pod jobs" in docs/agent-api.md.
 *
 * Pure: the definitions, the checks on what the browser asks and the pod answers, and what a job reads as now.
 */

/** A kind's name: dotted lowercase words, `docmosis.load`. 40 at most, so its claim fits a client-feature name's 50. */
export const POD_JOB_KIND_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
export const MAX_POD_JOB_KIND = 40;
/** An error code: what the panel branches on, never words for the person, which go in `detail`. */
export const POD_JOB_ERROR_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_POD_JOB_DETAIL = 300;
/** Compact JSON. The migration's backstops are twice these, since jsonb's text form spaces every separator. */
export const MAX_POD_JOB_ARGS_BYTES = 8 * 1024;
export const MAX_POD_JOB_RESULT_BYTES = 1024 * 1024;
/** Every kind may answer these whatever its own list says: a fault it did not foresee, and its pod's own time budget. */
export const GENERIC_POD_JOB_ERRORS: readonly string[] = ["failed", "timeout"];
/** How long a job is kept from when it was asked for, done or not; a rate-limit window must fit inside it. */
export const POD_JOB_KEEP_MS = 24 * 60 * 60_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60_000;

export type PodJobStatus = "pending" | "done" | "failed" | "timeout";

export interface PodJobKind {
  readonly kind: string;
  /** What the browser sends. A strict object, so a field the handler would not read is refused rather than ignored. */
  readonly args: z.ZodType;
  /** What the pod answers with `done`. Strict too, so the panel reads only what the contract says is there. */
  readonly result: z.ZodType;
  /** The codes a `failed` answer may carry beside `failed` and `timeout`. */
  readonly errors: readonly string[];
  /** How long a pending job waits for its answer before it reads as `timeout`. The pod's budget sits inside it. */
  readonly timeoutMs: number;
  /** Requests per owner per kind per window. */
  readonly rateLimit: { readonly limit: number; readonly windowMs: number };
  /** One pending job per conversation: an identical request joins it, a different one is refused with 409. */
  readonly oneAtATime: boolean;
  /** The largest answer body the pod may send, `{status, result}` and all. */
  readonly maxResultBytes: number;
}

export interface PodJobKindDefinition {
  kind: string;
  args: z.ZodType;
  result: z.ZodType;
  errors?: readonly string[];
  timeoutMs: number;
  rateLimit: { limit: number; windowMs: number };
  oneAtATime?: boolean;
  maxResultBytes?: number;
}

/**
 * A kind, checked as it is defined, so a bad definition fails the module that makes it — and with it every test that
 * imports the registry — rather than the first request for it.
 */
export function definePodJobKind(definition: PodJobKindDefinition): PodJobKind {
  const { kind, errors = [], timeoutMs, rateLimit, oneAtATime = false, maxResultBytes = MAX_REQUEST_BYTES } = definition;
  const refuse = (why: string): never => {
    throw new Error(`pod job kind ${JSON.stringify(kind)}: ${why}`);
  };
  if (kind.length > MAX_POD_JOB_KIND || !POD_JOB_KIND_RE.test(kind)) {
    refuse(`a kind is at most ${MAX_POD_JOB_KIND} characters matching ${POD_JOB_KIND_RE}`);
  }
  for (const code of errors) {
    if (!POD_JOB_ERROR_RE.test(code) || GENERIC_POD_JOB_ERRORS.includes(code)) {
      refuse(`error ${JSON.stringify(code)} must match ${POD_JOB_ERROR_RE} and not be one every kind has`);
    }
  }
  if (new Set(errors).size !== errors.length) {
    refuse("an error is listed twice");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    refuse(`timeoutMs must be a whole number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(rateLimit.limit) || rateLimit.limit < 1 || !Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs < 1000) {
    refuse("rateLimit needs a limit of at least 1 and a window of at least a second");
  }
  if (rateLimit.windowMs > POD_JOB_KEEP_MS) {
    refuse("rateLimit's window must fit inside the time a job is kept, or the count would miss jobs already deleted");
  }
  if (!Number.isInteger(maxResultBytes) || maxResultBytes < 1024 || maxResultBytes > MAX_POD_JOB_RESULT_BYTES) {
    refuse(`maxResultBytes must be from 1024 to ${MAX_POD_JOB_RESULT_BYTES}`);
  }
  return Object.freeze({
    kind,
    args: definition.args,
    result: definition.result,
    errors: Object.freeze([...errors]),
    timeoutMs,
    rateLimit: Object.freeze({ ...rateLimit }),
    oneAtATime,
    maxResultBytes
  });
}

/** The registry as a lookup, refusing two kinds of one name, which would leave which one runs to the list's order. */
export function podJobRegistry(kinds: readonly PodJobKind[]): ReadonlyMap<string, PodJobKind> {
  const registry = new Map<string, PodJobKind>();
  for (const definition of kinds) {
    if (registry.has(definition.kind)) {
      throw new Error(`pod job kind ${JSON.stringify(definition.kind)} is registered twice`);
    }
    registry.set(definition.kind, definition);
  }
  return registry;
}

/** The client feature a pod claims for each kind it has a handler for. */
export function podJobFeature(kind: string): PodJobFeature {
  return `pod-job:${kind}`;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

const UNSTORABLE = "has text the hub cannot store: a NUL character, or half of a surrogate pair";

/** Whether Postgres can hold `value` in a jsonb or text column, which refuse a NUL and half of a surrogate pair. */
const storable = (value: unknown): boolean => jsonbText(value) !== undefined;

function issueMessage(prefix: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const path = [prefix, ...(issue?.path ?? []).map(String)].join(".");
  return `${path}: ${issue?.message ?? "invalid"}`;
}

/** The browser's `args`, as the kind's schema parses them; a 400 naming the field otherwise. */
export function checkPodJobArgs(definition: PodJobKind, args: unknown): unknown {
  const parsed = definition.args.safeParse(args ?? {});
  if (!parsed.success) {
    throw new HttpError(400, issueMessage("args", parsed.error));
  }
  if (!storable(parsed.data)) {
    throw new HttpError(400, `args: ${UNSTORABLE}`);
  }
  if (jsonBytes(parsed.data) > MAX_POD_JOB_ARGS_BYTES) {
    throw new HttpError(400, `args: at most ${MAX_POD_JOB_ARGS_BYTES} bytes`);
  }
  return parsed.data;
}

/** The pod's answer, shaped; the kind's own checks are `checkPodJobAnswer`'s. */
export const podJobAnswerBody = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("done"), result: z.unknown() }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.string().regex(POD_JOB_ERROR_RE),
    detail: z.string().trim().min(1).max(MAX_POD_JOB_DETAIL).refine(storable, { message: UNSTORABLE }).optional()
  })
]);

export type PodJobAnswer = { status: "done"; result: unknown } | { status: "failed"; error: string; detail?: string };

/**
 * The answer as it is stored: a result the kind's schema parses, or an error. A code the kind does not list is stored
 * as `failed` with its detail, so the job still ends for the person waiting and the panel only ever sees codes it
 * branches on. A 400 for an answer of the wrong shape or a result the kind refuses.
 */
export function checkPodJobAnswer(definition: PodJobKind, body: unknown): PodJobAnswer {
  const shaped = podJobAnswerBody.safeParse(body);
  if (!shaped.success) {
    throw new HttpError(400, issueMessage("answer", shaped.error));
  }
  const answer = shaped.data;
  if (answer.status === "failed") {
    const error = GENERIC_POD_JOB_ERRORS.includes(answer.error) || definition.errors.includes(answer.error) ? answer.error : "failed";
    return answer.detail === undefined ? { status: "failed", error } : { status: "failed", error, detail: answer.detail };
  }
  return { status: "done", result: checkPodJobResult(definition, answer.result) };
}

/** A `done` result as the kind's schema parses it, within the table's cap; a 400 otherwise. */
export function checkPodJobResult(definition: PodJobKind, result: unknown): unknown {
  const parsed = definition.result.safeParse(result);
  if (!parsed.success) {
    throw new HttpError(400, issueMessage("result", parsed.error));
  }
  // Undefined and null cannot be told from "no result" in a nullable jsonb column, so a result is always a value.
  if (parsed.data === undefined || parsed.data === null) {
    throw new HttpError(400, "result: must be a value");
  }
  if (!storable(parsed.data)) {
    throw new HttpError(400, `result: ${UNSTORABLE}`);
  }
  if (jsonBytes(parsed.data) > MAX_POD_JOB_RESULT_BYTES) {
    throw new HttpError(400, `result: at most ${MAX_POD_JOB_RESULT_BYTES} bytes`);
  }
  return parsed.data;
}

/** What a row reads as now: a job left pending past its `expires_at` has timed out, whatever the row still says. */
export function podJobStatus(row: { status: string; expiresAt: Date }, now: Date): PodJobStatus {
  if (row.status === "pending") {
    return now.getTime() >= row.expiresAt.getTime() ? "timeout" : "pending";
  }
  return row.status === "done" || row.status === "failed" ? row.status : "timeout";
}

/** The oldest a job can have been asked for and still be kept. */
export const keptPodJobsSince = (now: Date): Date => new Date(now.getTime() - POD_JOB_KEEP_MS);

/** What asking for a job answers: one to read back, or why none was started. */
export type PodJobRequest =
  | { status: "pending"; job_id: string }
  | { status: "waking" }
  | { status: "unsupported" }
  | { status: "assistant_gone" }
  | { status: "no_pod" };

/** What reading a job back answers. */
export interface PodJobView {
  job_id: string;
  kind: string;
  status: PodJobStatus;
  result?: unknown;
  error?: string;
  detail?: string;
}

export function podJobView(
  row: { id: string; kind: string; status: string; expiresAt: Date; result: unknown; error: string | null; detail: string | null },
  now: Date
): PodJobView {
  const status = podJobStatus(row, now);
  return {
    job_id: row.id,
    kind: row.kind,
    status,
    ...(status === "done" ? { result: row.result } : {}),
    ...(status === "failed" && row.error !== null ? { error: row.error } : {}),
    ...(status === "failed" && row.detail !== null ? { detail: row.detail } : {})
  };
}
