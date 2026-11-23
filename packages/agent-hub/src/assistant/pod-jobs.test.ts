import { describe, expect, it, vi } from "vitest";
import { claimedFeatures, podJobFeatures } from "../features.ts";
import { MAX_CLIENT_FEATURES, type PodJobAnswer } from "../wire.ts";
import { POD_JOB_HANDLERS } from "./pod-job-handlers.ts";
import {
  BUSY,
  createPodJobRunner,
  failureOf,
  MAX_WAITING,
  NO_HANDLER,
  PodJobError,
  type PodJobHandler,
  type PodJobHandlerApi,
  parsePodJobFrame,
  REFUSED,
  STOPPED,
  TOO_SLOW
} from "./pod-jobs.ts";

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
function runner(
  handlers: readonly PodJobHandler[],
  { refusals = [] as number[], clock, agentApi = {} }: { refusals?: number[]; clock?: () => number; agentApi?: Partial<PodJobHandlerApi> } = {}
) {
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
    api: { ...(agentApi as PodJobHandlerApi), putPodJob },
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

  it("should claim no more features than the hub takes, so a status report is never refused for its claim", () => {
    expect(claimedFeatures().length).toBeLessThanOrEqual(MAX_CLIENT_FEATURES);
    expect(claimedFeatures([...POD_JOB_HANDLERS, echo]).length).toBeLessThanOrEqual(MAX_CLIENT_FEATURES);
  });

  it("should claim exactly the kinds this build has a handler for when it reports its claim", () => {
    expect(POD_JOB_HANDLERS.map((handler) => handler.kind)).toEqual([
      "docmosis.load",
      "notify.list",
      "notify.pull",
      "jira.attach-video",
      "ccd.case-types",
      "ccd.case-type-fields"
    ]);
    expect(claimedFeatures().filter((name) => name.startsWith("pod-job:"))).toEqual([
      "pod-job:ccd.case-type-fields",
      "pod-job:ccd.case-types",
      "pod-job:docmosis.load",
      "pod-job:jira.attach-video",
      "pod-job:notify.list",
      "pod-job:notify.pull"
    ]);
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

  it("should cut words between code points when the cut falls inside a surrogate pair", () => {
    const answer = failureOf(new Error(`${"x".repeat(298)}${"😀".repeat(5)}`));
    const detail = answer.status === "failed" ? (answer.detail ?? "") : "";

    expect(detail).toBe(`${"x".repeat(298)}…`);
    expect(detail.isWellFormed()).toBe(true);
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
          return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ late: true })));
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
    expect(said.join("\n")).toContain("refused its answer");
  });

  it("should answer plain failed once when the hub refuses a failed answer, so the person is not left waiting", async () => {
    // Arrange
    const { jobs, answers, putPodJob } = runner(
      [
        {
          ...echo,
          run: async () => {
            throw new PodJobError("signed_out", "Sign in first.");
          }
        }
      ],
      { refusals: [400] }
    );

    // Act
    jobs.podJob(frame());
    await jobs.idle();

    // Assert
    expect(putPodJob).toHaveBeenCalledTimes(2);
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "failed", error: "failed", detail: REFUSED } }]);
  });

  it("should not answer again when the hub refuses the plain failed answer itself", async () => {
    const { jobs, putPodJob } = runner([echo], { refusals: [400, 400] });

    jobs.podJob(frame());
    await jobs.idle();

    expect(putPodJob).toHaveBeenCalledTimes(2);
  });

  it("should give a handler the supervisor's api and the frame's agent id, so it can write into its conversation", async () => {
    // Arrange
    const putArtefact = vi.fn(async () => ({ version: 2 }));
    const writer: PodJobHandler = {
      kind: "test.write",
      budgetMs: 5000,
      run: async (_args, { api, agentId }) => {
        if (agentId === undefined) {
          throw new PodJobError("no_session", "Open the chat first.");
        }
        return await api.putArtefact(agentId, { markdown: "# Loaded", base_version: 1 });
      }
    };
    const { jobs, answers } = runner([writer], { agentApi: { putArtefact } });

    // Act
    jobs.podJob(frame({ kind: "test.write", agent_id: AGENT }));
    jobs.podJob(frame({ kind: "test.write", job_id: "7d2a9e3c-1111-4222-8333-000000000009" }));
    await jobs.idle();

    // Assert
    expect(putArtefact).toHaveBeenCalledTimes(1);
    expect(putArtefact).toHaveBeenCalledWith(AGENT, { markdown: "# Loaded", base_version: 1 });
    expect(answers.map(({ answer }) => answer)).toEqual([
      { status: "done", result: { version: 2 } },
      { status: "failed", error: "no_session", detail: "Open the chat first." }
    ]);
  });

  it("should keep a kind's slot held while a handler past its budget is still running, though it answered timeout", async () => {
    // Arrange
    let finish: () => void = () => undefined;
    let started = 0;
    const stuck: PodJobHandler = {
      kind: "test.stuck",
      budgetMs: 20,
      run: async () => {
        started += 1;
        if (started === 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return { ok: true };
      }
    };
    const { jobs, answers } = runner([{ ...stuck, budgetMs: 20 }]);
    jobs.podJob(frame({ kind: "test.stuck", job_id: "7d2a9e3c-1111-4222-8333-000000000001" }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Act
    jobs.podJob(frame({ kind: "test.stuck", job_id: "7d2a9e3c-1111-4222-8333-000000000002" }));
    await settle();
    const startedWhileStuck = started;
    const answeredWhileStuck = answers.map(({ answer }) => answer.status === "failed" && answer.error);
    finish();
    await jobs.idle();

    // Assert
    expect(answeredWhileStuck).toEqual(["timeout"]);
    expect(startedWhileStuck).toBe(1);
    expect(started).toBe(2);
  });

  it("should answer every running and waiting job as failed when it stops, and any job sent after", async () => {
    // Arrange
    const slow = gated("test.slow");
    let aborted: AbortSignal | undefined;
    const { jobs, answers } = runner([
      {
        ...slow.handler,
        run: async (args, context) => {
          aborted = context.signal;
          return await slow.handler.run(args, context);
        }
      }
    ]);
    jobs.podJob(frame({ kind: "test.slow", job_id: "7d2a9e3c-1111-4222-8333-000000000001" }));
    jobs.podJob(frame({ kind: "test.slow", job_id: "7d2a9e3c-1111-4222-8333-000000000002" }));
    await settle();

    // Act
    await jobs.stop();
    jobs.podJob(frame({ kind: "test.slow", job_id: "7d2a9e3c-1111-4222-8333-000000000003" }));
    await settle();

    // Assert
    const stopped = { status: "failed", error: "failed", detail: STOPPED };
    expect(answers.map(({ answer }) => answer)).toEqual([stopped, stopped, stopped]);
    expect(aborted?.aborted).toBe(true);
    slow.releases.shift()?.();
    await jobs.idle();
    expect(answers).toHaveLength(3);
  });

  it("should stop waiting for answers after its bound when the hub cannot be reached", async () => {
    // Arrange
    const slow = gated("test.slow");
    const hung = vi.fn(() => new Promise<null>(() => undefined));
    const jobs = createPodJobRunner({ api: { putPodJob: hung } as never, id: "va-1", env: {}, handlers: [slow.handler] });
    jobs.podJob(frame({ kind: "test.slow" }));
    await settle();

    // Act
    const before = Date.now();
    await jobs.stop(30);

    // Assert
    expect(Date.now() - before).toBeLessThan(1000);
    expect(hung).toHaveBeenCalledWith("va-1", JOB, { status: "failed", error: "failed", detail: STOPPED });
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
    jobs.podJob(frame({ kind: "test.unclaimed", job_id: "7d2a9e3c-1111-4222-8333-000000000002" }));
    await jobs.idle();

    // Assert
    expect(answers).toEqual([]);
    expect(said.filter((line) => line.includes("could not answer it"))).toHaveLength(2);
  });

  it("should answer timeout, and never start it, when a job's budget runs out while it waits behind a handler that never settles", async () => {
    // Arrange
    let started = 0;
    const stuck: PodJobHandler = {
      kind: "test.stuck",
      budgetMs: 30,
      run: () => {
        started += 1;
        return new Promise(() => undefined);
      }
    };
    const { jobs, answers } = runner([stuck]);

    // Act
    jobs.podJob(frame({ kind: "test.stuck", job_id: "7d2a9e3c-1111-4222-8333-000000000001" }));
    jobs.podJob(frame({ kind: "test.stuck", job_id: "7d2a9e3c-1111-4222-8333-000000000002" }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Assert
    expect(started).toBe(1);
    expect(answers.map(({ jobId, answer }) => [jobId.slice(-1), answer])).toEqual([
      ["1", { status: "failed", error: "timeout", detail: TOO_SLOW }],
      ["2", { status: "failed", error: "timeout", detail: TOO_SLOW }]
    ]);
  });

  it("should answer failed as busy when more jobs of a kind are waiting than it queues", async () => {
    // Arrange
    const slow = gated("test.slow");
    const { jobs, answers } = runner([slow.handler]);
    const id = (n: number) => `7d2a9e3c-1111-4222-8333-${String(n).padStart(12, "0")}`;

    // Act
    for (let n = 0; n <= MAX_WAITING + 1; n += 1) {
      jobs.podJob(frame({ kind: "test.slow", job_id: id(n) }));
    }
    await settle();

    // Assert
    expect(answers).toEqual([{ jobId: id(MAX_WAITING + 1), answer: { status: "failed", error: "failed", detail: BUSY } }]);
    await jobs.stop();
  });

  it("should clear every budget timer when it stops, so nothing keeps the process alive", async () => {
    // Arrange
    vi.useFakeTimers();
    try {
      const slow = gated("test.slow");
      const { jobs } = runner([{ ...slow.handler, budgetMs: 60_000 }]);
      jobs.podJob(frame({ kind: "test.slow", job_id: "7d2a9e3c-1111-4222-8333-000000000001" }));
      jobs.podJob(frame({ kind: "test.slow", job_id: "7d2a9e3c-1111-4222-8333-000000000002" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(2);

      // Act
      await jobs.stop();

      // Assert
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should run a job once when the hub sends it again while it runs or after it was answered", async () => {
    // Arrange
    const slow = gated("test.slow", 2);
    const { jobs, answers } = runner([slow.handler]);
    jobs.podJob(frame({ kind: "test.slow" }));
    await settle();

    // Act
    jobs.podJob(frame({ kind: "test.slow" }));
    await settle();
    slow.releases.shift()?.();
    await jobs.idle();
    jobs.podJob(frame({ kind: "test.slow" }));
    await settle();

    // Assert
    expect(slow.most()).toBe(1);
    expect(slow.releases).toEqual([]);
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "done", result: { ok: true } } }]);
  });

  it("should run a job again when the hub sends it again after its answer could not be sent", async () => {
    // Arrange
    const run = vi.fn(echo.run);
    const { jobs, answers } = runner([{ ...echo, run }], { refusals: [404] });
    jobs.podJob(frame());
    await jobs.idle();

    // Act
    jobs.podJob(frame());
    await jobs.idle();

    // Assert
    expect(run).toHaveBeenCalledTimes(2);
    expect(answers).toEqual([{ jobId: JOB, answer: { status: "done", result: { echoed: "hi" } } }]);
  });

  it("should ignore a frame that is not a job", async () => {
    const { jobs, answers, said } = runner([echo]);

    jobs.podJob({ job_id: "nope" });
    await jobs.idle();

    expect(answers).toEqual([]);
    expect(said[0]).toContain("ignoring a pod job that is not one");
  });
});
