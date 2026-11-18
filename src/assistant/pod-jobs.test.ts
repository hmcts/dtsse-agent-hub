import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError, MAX_REQUEST_BYTES } from "../agent-api/http.ts";
import { normaliseClientFeatures } from "../agents/client-features.ts";
import { POD_JOB_KINDS, POD_JOB_REGISTRY } from "./pod-job-kinds.ts";
import {
  checkPodJobAnswer,
  checkPodJobArgs,
  checkPodJobResult,
  definePodJobKind,
  keptPodJobsSince,
  MAX_POD_JOB_ARGS_BYTES,
  MAX_POD_JOB_RESULT_BYTES,
  POD_JOB_KEEP_MS,
  type PodJobKindDefinition,
  podJobFeature,
  podJobRegistry,
  podJobStatus,
  podJobView
} from "./pod-jobs.ts";

const TEST_KIND: PodJobKindDefinition = {
  kind: "test.echo",
  args: z.strictObject({ text: z.string().max(100) }),
  result: z.strictObject({ echoed: z.string() }),
  errors: ["signed_out"],
  timeoutMs: 60_000,
  rateLimit: { limit: 3, windowMs: 60_000 }
};

const kind = (overrides: Partial<PodJobKindDefinition> = {}) => definePodJobKind({ ...TEST_KIND, ...overrides });

function refusal(work: () => unknown): HttpError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("definePodJobKind", () => {
  it("should default to many at a time and the agent API's body cap", () => {
    const defined = kind();

    expect(defined.oneAtATime).toBe(false);
    expect(defined.maxResultBytes).toBe(MAX_REQUEST_BYTES);
    expect(defined.errors).toEqual(["signed_out"]);
    expect(Object.isFrozen(defined)).toBe(true);
  });

  it.each([
    ["a kind that is not dotted lowercase words", { kind: "Test.Echo" }],
    ["a kind ending in a dot", { kind: "test." }],
    ["a kind over 40 characters", { kind: `a${".b".repeat(20)}` }],
    ["an error that is not a code", { errors: ["Signed Out"] }],
    ["an error every kind already has", { errors: ["timeout"] }],
    ["an error listed twice", { errors: ["gone", "gone"] }],
    ["a timeout under a second", { timeoutMs: 999 }],
    ["a timeout over an hour", { timeoutMs: 60 * 60_000 + 1 }],
    ["a fractional timeout", { timeoutMs: 1500.5 }],
    ["a rate limit of none", { rateLimit: { limit: 0, windowMs: 60_000 } }],
    ["a fractional rate limit", { rateLimit: { limit: 1.5, windowMs: 60_000 } }],
    ["a rate window under a second", { rateLimit: { limit: 1, windowMs: 10 } }],
    ["a fractional rate window", { rateLimit: { limit: 1, windowMs: 1000.5 } }],
    ["a rate window longer than jobs are kept", { rateLimit: { limit: 1, windowMs: POD_JOB_KEEP_MS + 1 } }],
    ["a result cap over 1 MiB", { maxResultBytes: MAX_POD_JOB_RESULT_BYTES + 1 }],
    ["a result cap under 1 KiB", { maxResultBytes: 10 }],
    ["a fractional result cap", { maxResultBytes: 2048.5 }]
  ] as const)("should refuse %s when it is defined", (_label, overrides) => {
    expect(() => kind(overrides as Partial<PodJobKindDefinition>)).toThrow(/pod job kind/);
  });

  it("should take a kind of exactly 40 characters, whose claim is a valid client-feature name", () => {
    const name = `a${".b".repeat(19)}c`;

    const defined = kind({ kind: name });

    expect(defined.kind).toHaveLength(40);
    expect(normaliseClientFeatures([podJobFeature(defined.kind)])).toEqual([`pod-job:${name}`]);
  });
});

describe("podJobRegistry", () => {
  it("should find each kind by its name", () => {
    const registry = podJobRegistry([kind(), kind({ kind: "test.other" })]);

    expect(registry.get("test.other")?.kind).toBe("test.other");
    expect(registry.get("test.missing")).toBeUndefined();
  });

  it("should refuse a kind registered twice", () => {
    expect(() => podJobRegistry([kind(), kind()])).toThrow(/registered twice/);
  });

  it("should register no production kinds yet", () => {
    expect(POD_JOB_KINDS).toEqual([]);
    expect(POD_JOB_REGISTRY.size).toBe(0);
  });
});

describe("checkPodJobArgs", () => {
  it("should answer the args as the schema parses them, and {} for none", () => {
    expect(checkPodJobArgs(kind(), { text: "hi" })).toEqual({ text: "hi" });
    expect(checkPodJobArgs(kind({ args: z.strictObject({}) }), undefined)).toEqual({});
  });

  it("should refuse a field the schema does not have, naming it", () => {
    const error = refusal(() => checkPodJobArgs(kind(), { text: "hi", extra: 1 }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^args/);
  });

  it("should refuse a wrong value, naming its path", () => {
    expect(refusal(() => checkPodJobArgs(kind(), { text: 3 })).message).toMatch(/^args\.text:/);
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["half of a surrogate pair", "\udc00"]
  ])("should refuse args when they hold %s, which Postgres cannot store", (_label, text) => {
    const error = refusal(() => checkPodJobArgs(kind(), { text }));

    expect(error.status).toBe(400);
    expect(error.message).toBe("args: has text the hub cannot store: a NUL character, or half of a surrogate pair");
  });

  it("should refuse args over the cap", () => {
    const big = kind({ args: z.strictObject({ text: z.string() }) });

    expect(refusal(() => checkPodJobArgs(big, { text: "x".repeat(MAX_POD_JOB_ARGS_BYTES) })).message).toMatch(/at most/);
  });
});

describe("checkPodJobAnswer", () => {
  it("should keep a result the kind's schema parses", () => {
    expect(checkPodJobAnswer(kind(), { status: "done", result: { echoed: "hi" } })).toEqual({ status: "done", result: { echoed: "hi" } });
  });

  it("should refuse a result the kind's schema does not parse, naming the field", () => {
    const error = refusal(() => checkPodJobAnswer(kind(), { status: "done", result: { echoed: 1 } }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^result\.echoed:/);
  });

  it("should refuse a result that is null or over the cap", () => {
    const anything = kind({ result: z.unknown() });

    expect(refusal(() => checkPodJobAnswer(anything, { status: "done", result: null })).message).toMatch(/must be a value/);
    expect(refusal(() => checkPodJobResult(anything, "x".repeat(MAX_POD_JOB_RESULT_BYTES))).message).toMatch(/at most/);
  });

  it.each(["failed", "timeout", "signed_out"])("should keep the error %s when the kind allows it", (code) => {
    expect(checkPodJobAnswer(kind(), { status: "failed", error: code })).toEqual({ status: "failed", error: code });
  });

  it("should keep the detail, trimmed", () => {
    expect(checkPodJobAnswer(kind(), { status: "failed", error: "failed", detail: " Sign in. " })).toEqual({
      status: "failed",
      error: "failed",
      detail: "Sign in."
    });
  });

  it("should store failed with the pod's detail when the code is one the kind does not list", () => {
    expect(checkPodJobAnswer(kind(), { status: "failed", error: "not_found", detail: "No such repo." })).toEqual({
      status: "failed",
      error: "failed",
      detail: "No such repo."
    });
    expect(checkPodJobAnswer(kind(), { status: "failed", error: "not_found" })).toEqual({ status: "failed", error: "failed" });
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["half of a surrogate pair", "a\ud800b"]
  ])("should refuse a result or a detail when it holds %s, which Postgres cannot store", (_label, text) => {
    expect(refusal(() => checkPodJobAnswer(kind(), { status: "done", result: { echoed: text } })).message).toMatch(/^result: has text the hub cannot store/);
    expect(refusal(() => checkPodJobAnswer(kind({ result: z.unknown() }), { status: "done", result: { [text]: 1 } })).message).toMatch(/cannot store/);
    expect(refusal(() => checkPodJobAnswer(kind(), { status: "failed", error: "failed", detail: text })).message).toMatch(
      /^answer\.detail: has text the hub cannot store/
    );
  });

  it.each([
    ["no status", {}],
    ["an unknown status", { status: "pending" }],
    ["an extra field", { status: "done", result: { echoed: "x" }, more: 1 }],
    ["an error that is not a code", { status: "failed", error: "Not Found" }],
    ["a detail over 300 characters", { status: "failed", error: "failed", detail: "x".repeat(301) }]
  ])("should refuse an answer with %s", (_label, body) => {
    expect(refusal(() => checkPodJobAnswer(kind(), body)).message).toMatch(/^answer/);
  });
});

describe("podJobStatus", () => {
  const now = new Date("2026-11-18T10:00:00Z");

  it("should read a pending job past its expiry as timed out", () => {
    expect(podJobStatus({ status: "pending", expiresAt: new Date(now.getTime() + 1) }, now)).toBe("pending");
    expect(podJobStatus({ status: "pending", expiresAt: now }, now)).toBe("timeout");
  });

  it("should read a finished job as it was written, and anything else as timed out", () => {
    expect(podJobStatus({ status: "done", expiresAt: now }, now)).toBe("done");
    expect(podJobStatus({ status: "failed", expiresAt: now }, now)).toBe("failed");
    expect(podJobStatus({ status: "timeout", expiresAt: now }, now)).toBe("timeout");
    expect(podJobStatus({ status: "odd", expiresAt: now }, now)).toBe("timeout");
  });

  it("should keep a job for 24 hours", () => {
    expect(now.getTime() - keptPodJobsSince(now).getTime()).toBe(24 * 60 * 60_000);
  });
});

describe("podJobView", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const later = new Date(now.getTime() + 60_000);
  const row = { id: "j1", kind: "test.echo", expiresAt: later, result: null, error: null, detail: null };

  it("should show a result only when the job is done", () => {
    expect(podJobView({ ...row, status: "done", result: { echoed: "x" } }, now)).toEqual({
      job_id: "j1",
      kind: "test.echo",
      status: "done",
      result: { echoed: "x" }
    });
    expect(podJobView({ ...row, status: "pending", result: { echoed: "x" } }, now)).toEqual({ job_id: "j1", kind: "test.echo", status: "pending" });
  });

  it("should show the error and detail only when the job failed", () => {
    expect(podJobView({ ...row, status: "failed", error: "signed_out", detail: "Sign in." }, now)).toEqual({
      job_id: "j1",
      kind: "test.echo",
      status: "failed",
      error: "signed_out",
      detail: "Sign in."
    });
    expect(podJobView({ ...row, status: "failed", error: "failed" }, now)).toEqual({ job_id: "j1", kind: "test.echo", status: "failed", error: "failed" });
    expect(podJobView({ ...row, status: "pending", error: "failed", expiresAt: now }, now)).toEqual({ job_id: "j1", kind: "test.echo", status: "timeout" });
  });
});
