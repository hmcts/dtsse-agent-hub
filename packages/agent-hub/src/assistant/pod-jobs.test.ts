import { describe, expect, it, vi } from "vitest";
import { claimedFeatures, podJobFeatures } from "../features.ts";
import type { PodJobAnswer } from "../wire.ts";
import { POD_JOB_HANDLERS } from "./pod-job-handlers.ts";
import { createPodJobRunner, failureOf, NO_HANDLER, PodJobError, type PodJobHandler, parsePodJobFrame, REFUSED, TOO_SLOW } from "./pod-jobs.ts";

const JOB = "7d2a9e3c-1111-4222-8333-444455556666";
const CONVERSATION = "0f8a6a1e-0000-4000-8000-0000000000c2";
const AGENT = "0f8a6a1e-0000-4000-8000-0000000000a1";

const frame = (overrides: Record<string, unknown> = {}) => ({
  job_id: JOB,
  kind: "test.echo",
  conversation_id: CONVERSATION,
  args: { text: "hi" },
  ...overrides
});

const echo: PodJobHandler = {
  kind: "test.echo",
  budgetMs: 5000,
  run: async (args) => ({ echoed: (args as { text: string }).text })
};

/** A runner on a hub that records every answer, refusing the first ones with `refusals`. */
function runner(handlers: readonly PodJobHandler[], { refusals = [] as number[], clock }: { refusals?: number[]; clock?: () => number } = {}) {
  const answers: { jobId: string; answer: PodJobAnswer }[] = [];
  const said: string[] = [];
  const putPodJob = vi.fn(async (_id: string, jobId: string, answer: PodJobAnswer) => {
    const refused = refusals.shift();
    if (refused !== undefined) {
      throw Object.assign(new Error(`refused ${refused}`), { status: refused });
    }
    answers.push({ jobId, answer });
    return null;
  });
  const jobs = createPodJobRunner({
    api: { putPodJob },
    id: "va-1",
    env: {},
    handlers,
    say: (message) => said.push(message),
    retryWait: async () => undefined,
    ...(clock ? { clock } : {})
  });
  return { jobs, answers, said, putPodJob };
}

/** A handler that waits to be let go, counting how many of it run at once. */
function gated(kind: string, concurrency?: number) {
  const releases: (() => void)[] = [];
  let running = 0;
  let most = 0;
  const handler: PodJobHandler = {
    kind,
    budgetMs: 5000,
    ...(concurrency === undefined ? {} : { concurrency }),
    run: async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return { ok: true };
    }
  };
  return { handler, releases, most: () => most };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parsePodJobFrame", () => {
  it("should take a job with or without the conversation's agent, reading no args as {}", () => {
    expect(parsePodJobFrame(frame({ agent_id: AGENT }))).toEqual({ ...frame(), agent_id: AGENT });
    expect(parsePodJobFrame(frame({ args: undefined }))).toEqual({ ...frame(), args: {} });
  });

  it.each([
    ["nothing", null],
    ["a list", []],
    ["a job id that is not a uuid", frame({ job_id: "j1" })],
    ["no conversation", frame({ conversation_id: undefined })],
    ["a kind that is not one", frame({ kind: "Test Echo" })],
    ["an agent that is not a uuid", frame({ agent_id: "a1" })]
  ])("should refuse %s", (_label, value) => {
    expect(parsePodJobFrame(value)).toBeNull();
  });
});

describe("podJobFeatures and claimedFeatures", () => {
  it("should claim pod-job:<kind> for each handler, sorted", () => {
    expect(podJobFeatures([{ kind: "test.zed" }, { kind: "test.echo" }])).toEqual(["pod-job:test.echo", "pod-job:test.zed"]);
  });

  it("should refuse a handler whose kind the hub would not accept, or one there twice", () => {
    expect(() => podJobFeatures([{ kind: "Test" }])).toThrow(/not a kind/);
    expect(() => podJobFeatures([{ kind: `a${".b".repeat(20)}` }])).toThrow(/not a kind/);
    expect(() => podJobFeatures([{ kind: "test.echo" }, { kind: "test.echo" }])).toThrow(/twice/);
  });

  it("should claim no kind this build has no handler for", () => {
    expect(POD_JOB_HANDLERS).toEqual([]);
    expect(claimedFeatures().filter((name) => name.startsWith("pod-job:"))).toEqual([]);
    expect(claimedFeatures([echo])).toContain("pod-job:test.echo");
  });
});

describe("failureOf", () => {
  it("should answer a handler's own code with its words, and anything else as failed", () => {
    expect(failureOf(new PodJobError("signed_out", "Sign in to GitHub first."))).toEqual({
      status: "failed",
      error: "signed_out",
      detail: "Sign in to GitHub first."
    });
    expect(failureOf(new PodJobError("signed_out"))).toEqual({ status: "failed", error: "signed_out" });
    expect(failureOf(new PodJobError("Not A Code", "words"))).toEqual({ status: "failed", error: "failed", detail: "words" });
    expect(failureOf("boom")).toEqual({ status: "failed", error: "failed", detail: "boom" });
    expect(failureOf(new Error("   "))).toEqual({ status: "failed", error: "failed" });
  });

  it("should cut words for the person to the hub's 300 characters", () => {
    const answer = failureOf(new Error("x".repeat(400)));

    expect(answer.status === "failed" && answer.detail?.length).toBe(300);
  });
});

describe("createPodJobRunner", () => {
  it("should run the kind's handler with the frame's args and context, and answer its result", async () => {
    // Arrange
    const run = vi.fn(echo.run);
    const { jobs, answers } = runner([{ ...echo, run }]);

    // Act
    jobs.podJob(frame({ agent_id: AGENT }));
    await jobs.idle();

    // Assert
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "done", result: { echoed: "hi" } } }]);
    expect(run).toHaveBeenCalledWith(
      { text: "hi" },
      expect.objectContaining({ jobId: JOB, conversationId: CONVERSATION, agentId: AGENT, env: {}, signal: expect.any(AbortSignal) })
    );
  });

  it("should answer failed for a kind with no handler, and never run anything", async () => {
    // Arrange
    const run = vi.fn(echo.run);
    const { jobs, answers } = runner([{ ...echo, run }]);

    // Act
    jobs.podJob(frame({ kind: "test.unclaimed" }));
    await jobs.idle();

    // Assert
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "failed", error: "failed", detail: NO_HANDLER } }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("should pass a handler's error code through", async () => {
    // Arrange
    const { jobs, answers } = runner([
      {
        ...echo,
        run: async () => {
          throw new PodJobError("signed_out", "Sign in first.");
        }
      }
    ]);

    // Act
    jobs.podJob(frame());
    await jobs.idle();

    // Assert
    expect(answers[0]?.answer).toEqual({ status: "failed", error: "signed_out", detail: "Sign in first." });
  });

  it("should answer failed when a handler throws synchronously", async () => {
    const { jobs, answers } = runner([
      {
        ...echo,
        run: () => {
          throw new Error("no gh");
        }
      }
    ]);

    jobs.podJob(frame());
    await jobs.idle();

    expect(answers[0]?.answer).toEqual({ status: "failed", error: "failed", detail: "no gh" });
  });

  it("should abort a handler past its budget and answer timeout", async () => {
    // Arrange
    let signal: AbortSignal | undefined;
    const { jobs, answers } = runner([
      {
        ...echo,
        budgetMs: 20,
        run: (_args, context) => {
          signal = context.signal;
          return new Promise(() => undefined);
        }
      }
    ]);

    // Act
    jobs.podJob(frame());
    await jobs.idle();

    // Assert
    expect(answers[0]?.answer).toEqual({ status: "failed", error: "timeout", detail: TOO_SLOW });
    expect(signal?.aborted).toBe(true);
  });

  it("should answer timeout without running a job whose budget was spent waiting", async () => {
    // Arrange
    let now = 0;
    const slow = gated("test.slow");
    const run = vi.fn(async () => ({ ok: true }));
    const { jobs, answers } = runner([{ ...slow.handler, budgetMs: 1000, run: slow.handler.run }], { clock: () => now });
    jobs.podJob(frame({ job_id: "7d2a9e3c-1111-4222-8333-000000000001", kind: "test.slow" }));
    jobs.podJob(frame({ job_id: "7d2a9e3c-1111-4222-8333-000000000002", kind: "test.slow" }));
    await settle();

    // Act
    now = 5000;
    slow.releases.shift()?.();
    await jobs.idle();

    // Assert
    expect(run).not.toHaveBeenCalled();
    expect(answers.map(({ answer }) => answer.status === "failed" && answer.error)).toEqual([false, "timeout"]);
  });

  it("should run one of a kind at a time unless the handler allows more, and kinds beside each other", async () => {
    // Arrange
    const single = gated("test.single");
    const double = gated("test.double", 2);
    const { jobs, answers } = runner([single.handler, double.handler]);
    for (let n = 1; n <= 3; n += 1) {
      jobs.podJob(frame({ job_id: `7d2a9e3c-1111-4222-8333-00000000000${n}`, kind: "test.single" }));
      jobs.podJob(frame({ job_id: `7d2a9e3c-1111-4222-8333-00000000001${n}`, kind: "test.double" }));
    }
    await settle();

    // Act
    while (answers.length < 6) {
      single.releases.shift()?.();
      double.releases.shift()?.();
      await settle();
    }
    await jobs.idle();

    // Assert
    expect(single.most()).toBe(1);
    expect(double.most()).toBe(2);
  });

  it("should answer failed when the hub refuses a result, so the person is not left waiting", async () => {
    // Arrange
    const { jobs, answers, said } = runner([echo], { refusals: [400] });

    // Act
    jobs.podJob(frame());
    await jobs.idle();

    // Assert
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "failed", error: "failed", detail: REFUSED } }]);
    expect(said.join("\n")).toContain("refused its result");
  });

  it("should retry an answer the hub could not take for now", async () => {
    const { jobs, answers, putPodJob } = runner([echo], { refusals: [503] });

    jobs.podJob(frame());
    await jobs.idle();

    expect(putPodJob).toHaveBeenCalledTimes(2);
    expect(answers).toHaveLength(1);
  });

  it("should say so and carry on when no answer can be sent", async () => {
    // Arrange
    const { jobs, answers, said } = runner([echo], { refusals: [400, 404, 403] });

    // Act
    jobs.podJob(frame());
    jobs.podJob(frame({ kind: "test.unclaimed" }));
    await jobs.idle();

    // Assert
    expect(answers).toEqual([]);
    expect(said.filter((line) => line.includes("could not answer it"))).toHaveLength(2);
  });

  it("should ignore a frame that is not a job", async () => {
    const { jobs, answers, said } = runner([echo]);

    jobs.podJob({ job_id: "nope" });
    await jobs.idle();

    expect(answers).toEqual([]);
    expect(said[0]).toContain("ignoring a pod job that is not one");
  });
});
