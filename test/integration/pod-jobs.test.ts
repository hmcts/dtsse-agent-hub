// Pod jobs end to end through Postgres: the panel's request, the frame its pod is sent, the pod's answer, the read
// back, the limits, the expiry, and a feature's own write bound to a job. Two test-only kinds stand in for the
// features, since this layer ships with none of its own. The pod's half is the client package's
// `src/assistant/pod-jobs.test.ts`.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, MAX_REQUEST_BYTES } from "../../src/agent-api/http.ts";
import {
  answerPodJob,
  finishPodJob,
  lockPendingPodJob,
  pendingPodJobFrame,
  podJobAnswerLimit,
  readPodJob,
  requestPodJob,
  sweepPodJobs
} from "../../src/assistant/pod-job-store.ts";
import { POD_JOB_KEEP_MS } from "../../src/assistant/pod-jobs.ts";
import { decodeEvent, HUB_CHANNEL, type NotifiedEvent } from "../../src/realtime/events.ts";
import { ALICE, BOB, podFixture } from "./assistant-pod.ts";
import { connect, type Person, prisma, resetDatabase } from "./database.ts";

vi.mock("../../src/assistant/pod-job-kinds.ts", async () => {
  const { z } = await import("zod");
  const { definePodJobKind, podJobRegistry } = await import("../../src/assistant/pod-jobs.ts");
  const kinds = [
    definePodJobKind({
      kind: "test.echo",
      args: z.strictObject({ text: z.string().max(100) }),
      result: z.strictObject({ echoed: z.string() }),
      errors: ["signed_out"],
      timeoutMs: 60_000,
      rateLimit: { limit: 3, windowMs: 60_000 }
    }),
    definePodJobKind({
      kind: "test.single",
      args: z.strictObject({ name: z.string() }),
      result: z.strictObject({ loaded: z.boolean() }),
      timeoutMs: 60_000,
      rateLimit: { limit: 20, windowMs: 60_000 },
      oneAtATime: true,
      maxResultBytes: 512 * 1024
    })
  ];
  return { POD_JOB_KINDS: kinds, POD_JOB_REGISTRY: podJobRegistry(kinds) };
});

const client = await connect();
afterAll(async () => {
  await client.end();
});
beforeEach(async () => {
  await resetDatabase();
});

const claiming = podFixture(["pod-job:test.echo", "pod-job:test.single"]);

/** A running pod caught up with its generation, claiming both test kinds, and a conversation of its owner's on it. */
async function chatOf(who: Person, features?: string[] | null): Promise<{ assistant: string; conversation: string }> {
  const assistant = await claiming(who, features);
  const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { generation: true, agentId: true } });
  await prisma.virtualAgent.update({ where: { id: assistant }, data: { observedGeneration: row.generation } });
  const conversation = await prisma.assistantConversation.create({ data: { ownerOid: who.oid, virtualAgentId: assistant }, select: { id: true } });
  return { assistant, conversation: conversation.id };
}

async function refusal(work: Promise<unknown>): Promise<HttpError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

/** Every event `act` sent on the hub's channel. */
async function heard(act: () => Promise<unknown>): Promise<NotifiedEvent[]> {
  const listener = await connect();
  try {
    const events: NotifiedEvent[] = [];
    listener.on("notification", (notification) => {
      const event = decodeEvent(notification.payload);
      if (event !== undefined) {
        events.push(event);
      }
    });
    await listener.query(`LISTEN ${HUB_CHANNEL}`);
    await act();
    await listener.query("SELECT 1");
    return events;
  } finally {
    await listener.end();
  }
}

const jobOf = (asked: unknown) => (asked as { job_id: string }).job_id;

describe("pod jobs", () => {
  it("should record a job, frame it for its pod, keep its answer and give it back only to its owner", async () => {
    // Arrange
    const { assistant, conversation } = await chatOf(ALICE);
    const agent = await prisma.agent.create({
      data: { ownerOid: ALICE.oid, sessionId: "conversation-session", name: "chat", virtualAgentId: assistant },
      select: { id: true }
    });
    await prisma.assistantConversation.update({ where: { id: conversation }, data: { agentId: agent.id } });

    // Act
    let asked: unknown;
    const requested = await heard(async () => {
      asked = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "hi" } });
    });
    const jobId = jobOf(asked);
    const frame = await pendingPodJobFrame(prisma, assistant, jobId);
    const before = await readPodJob(prisma, ALICE.oid, conversation, jobId);
    const answered = await heard(() => answerPodJob(prisma, assistant, jobId, { status: "done", result: { echoed: "hi" } }));

    // Assert
    expect(asked).toEqual({ status: "pending", job_id: jobId });
    expect(requested).toEqual([{ type: "assistant_pod_job_requested", job_id: jobId, virtual_agent_id: assistant, owner_oid: ALICE.oid }]);
    expect(frame).toEqual({ job_id: jobId, kind: "test.echo", conversation_id: conversation, agent_id: agent.id, args: { text: "hi" } });
    expect(before).toEqual({ job_id: jobId, kind: "test.echo", status: "pending" });
    expect(answered).toEqual([{ type: "assistant_pod_job", job_id: jobId, conversation_id: conversation, owner_oid: ALICE.oid }]);
    expect(await readPodJob(prisma, ALICE.oid, conversation, jobId)).toEqual({ job_id: jobId, kind: "test.echo", status: "done", result: { echoed: "hi" } });
    expect(await pendingPodJobFrame(prisma, assistant, jobId)).toBeUndefined();
  });

  it("should not let another owner read a job, nor anyone read it through another conversation", async () => {
    // Arrange
    const alice = await chatOf(ALICE);
    const bob = await chatOf(BOB);
    const jobId = jobOf(await requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.echo", args: { text: "hi" } }));
    // Shared with Bob, which lets him read the chat but never what its jobs found.
    await prisma.assistantConversationShare.create({ data: { conversationId: alice.conversation, recipientOid: BOB.oid, sharedByOid: ALICE.oid } });

    // Act
    const asBob = await readPodJob(prisma, BOB.oid, alice.conversation, jobId);
    const elsewhere = await readPodJob(prisma, ALICE.oid, bob.conversation, jobId);
    const notAnId = await readPodJob(prisma, ALICE.oid, alice.conversation, "not-a-job");
    const bobAsks = await refusal(requestPodJob(prisma, BOB.oid, alice.conversation, { kind: "test.echo", args: { text: "hi" } }));
    const strangerAsks = await refusal(requestPodJob(prisma, "oid-nobody", alice.conversation, { kind: "test.echo", args: { text: "hi" } }));

    // Assert
    expect(asBob).toBeUndefined();
    expect(elsewhere).toBeUndefined();
    expect(notAnId).toBeUndefined();
    expect(bobAsks.status).toBe(403);
    expect(strangerAsks.status).toBe(404);
  });

  it("should ignore a stale answer, a repeated one, and one from another assistant's pod", async () => {
    // Arrange
    const alice = await chatOf(ALICE);
    const bob = await chatOf(BOB);
    const jobId = jobOf(await requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.echo", args: { text: "hi" } }));

    // Act
    await answerPodJob(prisma, bob.assistant, jobId, { status: "done", result: { echoed: "bob's" } });
    const framedForBob = await pendingPodJobFrame(prisma, bob.assistant, jobId);
    const limitForBob = await podJobAnswerLimit(prisma, bob.assistant, jobId);
    await answerPodJob(prisma, alice.assistant, jobId, { status: "failed", error: "signed_out", detail: "Sign in to GitHub first." });
    await answerPodJob(prisma, alice.assistant, jobId, { status: "done", result: { echoed: "late" } });
    await answerPodJob(prisma, alice.assistant, "not-a-job", { status: "done", result: { echoed: "x" } });

    // Assert
    expect(framedForBob).toBeUndefined();
    expect(limitForBob).toBeUndefined();
    expect(await readPodJob(prisma, ALICE.oid, alice.conversation, jobId)).toEqual({
      job_id: jobId,
      kind: "test.echo",
      status: "failed",
      error: "signed_out",
      detail: "Sign in to GitHub first."
    });
  });

  it("should refuse an answer the kind does not allow with 400 and keep the job pending", async () => {
    // Arrange
    const { assistant, conversation } = await chatOf(ALICE);
    const jobId = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "hi" } }));

    // Act
    const badResult = await refusal(answerPodJob(prisma, assistant, jobId, { status: "done", result: { echoed: 1 } }));
    const badError = await refusal(answerPodJob(prisma, assistant, jobId, { status: "failed", error: "not_found" }));

    // Assert
    expect(badResult.status).toBe(400);
    expect(badError.status).toBe(400);
    expect((await readPodJob(prisma, ALICE.oid, conversation, jobId))?.status).toBe("pending");
  });

  it("should refuse an unknown kind and bad args with 400 before anything is read", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);

    // Act
    const unknown = await refusal(requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.missing", args: {} }));
    const badArgs = await refusal(requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "hi", extra: true } }));

    // Assert
    expect(unknown.status).toBe(400);
    expect(badArgs.status).toBe(400);
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should answer why nothing was started for a local chat, a replaced assistant, a stopped pod and an unclaimed kind", async () => {
    // Arrange
    const { assistant, conversation } = await chatOf(ALICE, ["pod-job:test.single"]);
    const local = await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: null }, select: { id: true } });
    const other = await prisma.virtualAgent.create({ data: { ownerOid: ALICE.oid, name: "other", modelRoute: "own_licence" }, select: { id: true } });
    const elsewhere = await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: other.id }, select: { id: true } });
    const echo = { kind: "test.echo", args: { text: "hi" } };

    // Act
    const noPod = await requestPodJob(prisma, ALICE.oid, local.id, echo);
    const gone = await requestPodJob(prisma, ALICE.oid, elsewhere.id, echo);
    const unsupported = await requestPodJob(prisma, ALICE.oid, conversation, echo);
    await prisma.virtualAgent.update({ where: { id: assistant }, data: { desired: "stopped", status: "stopped" } });
    const waking = await requestPodJob(prisma, ALICE.oid, conversation, echo);

    // Assert
    expect(noPod).toEqual({ status: "no_pod" });
    expect(gone).toEqual({ status: "assistant_gone" });
    expect(unsupported).toEqual({ status: "unsupported" });
    expect(waking).toEqual({ status: "waking" });
    expect(await prisma.assistantPodJob.count()).toBe(0);
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { desired: true } })).desired).toBe("running");
  });

  it("should refuse a request past the kind's rate limit for that owner, and count each owner and kind on its own", async () => {
    // Arrange
    const alice = await chatOf(ALICE);
    const bob = await chatOf(BOB);
    const now = new Date();
    for (let n = 0; n < 3; n += 1) {
      await requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.echo", args: { text: `${n}` } }, now);
    }

    // Act
    const limited = await refusal(requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.echo", args: { text: "4" } }, now));
    const otherKind = await requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.single", args: { name: "a" } }, now);
    const otherOwner = await requestPodJob(prisma, BOB.oid, bob.conversation, { kind: "test.echo", args: { text: "1" } }, now);
    const later = await requestPodJob(prisma, ALICE.oid, alice.conversation, { kind: "test.echo", args: { text: "5" } }, new Date(now.getTime() + 60_001));

    // Assert
    expect(limited.status).toBe(429);
    expect(otherKind.status).toBe("pending");
    expect(otherOwner.status).toBe("pending");
    expect(later.status).toBe("pending");
  });

  it("should join the pending job of a one-at-a-time kind when the args are the same, and refuse different ones", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);
    const first = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } }));

    // Act
    const joined = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } });
    const different = await refusal(requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "order" } }));
    const manyAtOnce = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "a" } });
    const another = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "a" } });

    // Assert
    expect(joined).toEqual({ status: "pending", job_id: first });
    expect(different.status).toBe(409);
    expect(different.extra).toEqual({ job_id: first });
    expect(jobOf(another)).not.toBe(jobOf(manyAtOnce));
    expect(await prisma.assistantPodJob.count({ where: { kind: "test.single" } })).toBe(1);
  });

  it("should read a job past its time as timed out, ignore its late answer, and let a one-at-a-time kind start again", async () => {
    // Arrange
    const { assistant, conversation } = await chatOf(ALICE);
    const then = new Date(Date.now() - 61_000);
    const stale = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } }, then));

    // Act
    const read = await readPodJob(prisma, ALICE.oid, conversation, stale);
    const frame = await pendingPodJobFrame(prisma, assistant, stale);
    await answerPodJob(prisma, assistant, stale, { status: "done", result: { loaded: true } });
    const fresh = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } });

    // Assert
    expect(read?.status).toBe("timeout");
    expect(frame).toBeUndefined();
    expect(jobOf(fresh)).not.toBe(stale);
    expect((await prisma.assistantPodJob.findUniqueOrThrow({ where: { id: stale }, select: { status: true } })).status).toBe("timeout");
  });

  it("should write down jobs past their time and delete those past their retention when it sweeps", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);
    const now = new Date();
    const stuck = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "a" } }, new Date(now.getTime() - 61_000)));
    const old = jobOf(
      await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "b" } }, new Date(now.getTime() - POD_JOB_KEEP_MS - 1000))
    );
    const live = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "c" } }, now));

    // Act
    const swept = await sweepPodJobs(prisma, now);

    // Assert
    // The old job ran out of time too, and is written down before it is deleted.
    expect(swept).toEqual({ timedOut: 2, deleted: 1 });
    const rows = await prisma.assistantPodJob.findMany({ select: { id: true, status: true }, orderBy: { createdAt: "asc" } });
    expect(rows).toEqual([
      { id: stuck, status: "timeout" },
      { id: live, status: "pending" }
    ]);
    expect(rows.some((row) => row.id === old)).toBe(false);
    expect(await readPodJob(prisma, ALICE.oid, conversation, old)).toBeUndefined();
  });

  it("should give the answer cap of the job's kind, the agent API's for one that declares none", async () => {
    // Arrange
    const { assistant, conversation } = await chatOf(ALICE);
    const echo = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "a" } }));
    const single = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "a" } }));

    // Act and Assert
    expect(await podJobAnswerLimit(prisma, assistant, echo)).toBe(MAX_REQUEST_BYTES);
    expect(await podJobAnswerLimit(prisma, assistant, single)).toBe(512 * 1024);
  });

  it("should bind a feature's own write to a job and finish it in the same transaction", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);
    const jobId = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } }));

    // Act
    const events = await heard(() =>
      prisma.$transaction(async (tx) => {
        const wrongKind = await lockPendingPodJob(tx, jobId, "test.echo");
        const locked = await lockPendingPodJob(tx, jobId, "test.single");
        expect(wrongKind).toBeUndefined();
        expect(locked).toEqual({
          id: jobId,
          kind: "test.single",
          conversationId: conversation,
          ownerOid: ALICE.oid,
          virtualAgentId: expect.any(String),
          args: { name: "claim" }
        });
        await tx.assistantConversation.update({ where: { id: conversation }, data: { title: "Loaded claim" } });
        expect(await finishPodJob(tx, locked!, { loaded: true })).toBe(true);
        expect(await finishPodJob(tx, locked!, { loaded: true })).toBe(false);
      })
    );

    // Assert
    expect(events).toEqual([{ type: "assistant_pod_job", job_id: jobId, conversation_id: conversation, owner_oid: ALICE.oid }]);
    expect(await readPodJob(prisma, ALICE.oid, conversation, jobId)).toEqual({ job_id: jobId, kind: "test.single", status: "done", result: { loaded: true } });
    expect(await prisma.$transaction((tx) => lockPendingPodJob(tx, jobId, "test.single"))).toBeUndefined();
    expect(await prisma.$transaction((tx) => lockPendingPodJob(tx, "not-a-job", "test.single"))).toBeUndefined();
  });

  it("should roll back the feature's write and leave the job pending when the result is not the kind's", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);
    const jobId = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.single", args: { name: "claim" } }));

    // Act
    const error = await refusal(
      prisma.$transaction(async (tx) => {
        const locked = await lockPendingPodJob(tx, jobId, "test.single");
        await tx.assistantConversation.update({ where: { id: conversation }, data: { title: "Loaded claim" } });
        await finishPodJob(tx, locked!, { loaded: "yes" });
      })
    );

    // Assert
    expect(error.status).toBe(400);
    expect((await readPodJob(prisma, ALICE.oid, conversation, jobId))?.status).toBe("pending");
    expect((await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversation }, select: { title: true } })).title).toBeNull();
  });

  it("should delete a conversation's jobs with it", async () => {
    // Arrange
    const { conversation } = await chatOf(ALICE);
    await requestPodJob(prisma, ALICE.oid, conversation, { kind: "test.echo", args: { text: "a" } });

    // Act
    await prisma.assistantConversation.delete({ where: { id: conversation } });

    // Assert
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });
});
