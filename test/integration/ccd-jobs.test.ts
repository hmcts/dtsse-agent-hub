// The Bulk Scan builder's two CCD pod jobs through Postgres with the real registry: asked on the person's own chat, gated
// on the pod's claim, answered with a case type's fields at the size the pod sends, and read back. And which chat the
// builder runs them in. The pod's half is the client package's `ccd-case-types.test.ts`.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/agent-api/http.ts";
import { MAX_FIELDS_BYTES } from "../../src/assistant/ccd-jobs.ts";
import { answerablePodJob, answerPodJob, pendingPodJobFrame, readPodJob, requestPodJob } from "../../src/assistant/pod-job-store.ts";
import { podConversationId } from "../../src/bulk-scan/pod-conversation.ts";
import { ALICE, BOB, podFixture } from "./assistant-pod.ts";
import { connect, type Person, prisma, resetDatabase } from "./database.ts";

const client = await connect();
afterAll(async () => {
  await client.end();
});
beforeEach(async () => {
  await resetDatabase();
});

const CLAIMS = ["pod-job:ccd.case-types", "pod-job:ccd.case-type-fields"];
const withMainSession = podFixture([]);

async function chatOf(who: Person, features: string[] | null = CLAIMS): Promise<{ assistant: string; conversation: string }> {
  const assistant = await withMainSession(who);
  const row = await prisma.virtualAgent.findUniqueOrThrow({ where: { id: assistant }, select: { generation: true } });
  await prisma.virtualAgent.update({
    where: { id: assistant },
    data: { observedGeneration: row.generation, ...(features === null ? {} : { clientFeatures: features }) }
  });
  const conversation = await prisma.assistantConversation.create({ data: { ownerOid: who.oid, virtualAgentId: assistant }, select: { id: true } });
  return { assistant, conversation: conversation.id };
}

const jobOf = (asked: unknown) => (asked as { job_id: string }).job_id;

describe("asking for a case type's fields", () => {
  it("should send the pod the job and keep an answer at the size the pod cuts to, whole", async () => {
    const { assistant, conversation } = await chatOf(ALICE);
    const asked = await requestPodJob(prisma, ALICE.oid, conversation, { kind: "ccd.case-type-fields", args: { case_type: "NFD", product: "nfdiv" } });
    const id = jobOf(asked);
    expect(await pendingPodJobFrame(prisma, assistant, id)).toMatchObject({ kind: "ccd.case-type-fields", args: { case_type: "NFD", product: "nfdiv" } });

    const row = { ID: "x".repeat(40), Label: "L".repeat(150), FieldType: "Text" };
    const rows = Array.from({ length: Math.floor(MAX_FIELDS_BYTES / (JSON.stringify(row).length + 1)) }, (_, i) => ({ ...row, ID: `${row.ID}${i}` }));
    const job = await answerablePodJob(prisma, assistant, id);
    await answerPodJob(prisma, job as NonNullable<typeof job>, { status: "done", result: { fields: rows, total: rows.length, omitted: 0 } });

    const read = await readPodJob(prisma, ALICE.oid, conversation, id);
    expect(read?.status).toBe("done");
    expect(((read?.result ?? {}) as { fields?: unknown[] }).fields).toHaveLength(rows.length);
  });

  it("should refuse an answer whose fields are not the job's shape, keeping the job pending", async () => {
    const { assistant, conversation } = await chatOf(ALICE);
    const id = jobOf(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "ccd.case-type-fields", args: { case_type: "NFD" } }));
    const job = await answerablePodJob(prisma, assistant, id);

    await expect(
      answerPodJob(prisma, job as NonNullable<typeof job>, { status: "done", result: { fields: [{ ID: "a" }], total: 1, omitted: 0 } })
    ).rejects.toBeInstanceOf(HttpError);
    expect((await readPodJob(prisma, ALICE.oid, conversation, id))?.status).toBe("pending");
  });

  it("should say the assistant is unsupported when its pod's claim leaves the job out, and ask nothing", async () => {
    const { conversation } = await chatOf(ALICE, ["pod-job:ccd.case-types"]);

    expect(await requestPodJob(prisma, ALICE.oid, conversation, { kind: "ccd.case-type-fields", args: { case_type: "NFD" } })).toEqual({
      status: "unsupported"
    });
    expect(await prisma.assistantPodJob.count()).toBe(0);
  });

  it("should refuse anyone but the chat's owner", async () => {
    const { conversation } = await chatOf(ALICE);
    await chatOf(BOB);

    await expect(requestPodJob(prisma, BOB.oid, conversation, { kind: "ccd.case-types", args: {} })).rejects.toMatchObject({ status: 404 });
  });

  it("should refuse a case type id that could be read as an option", async () => {
    const { conversation } = await chatOf(ALICE);

    await expect(requestPodJob(prisma, ALICE.oid, conversation, { kind: "ccd.case-type-fields", args: { case_type: "--product" } })).rejects.toMatchObject({
      status: 400
    });
  });
});

describe("the chat the builder runs its jobs in", () => {
  it("should be the person's most recently active chat on their assistant", async () => {
    const { assistant, conversation } = await chatOf(ALICE);
    const newer = await prisma.assistantConversation.create({
      data: { ownerOid: ALICE.oid, virtualAgentId: assistant, lastActiveAt: new Date(Date.now() + 60_000) },
      select: { id: true }
    });
    await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: assistant, lastActiveAt: new Date(Date.now() - 60_000) } });

    expect(await podConversationId(prisma, ALICE.oid)).toBe(newer.id);
    expect(newer.id).not.toBe(conversation);
  });

  it("should be none for a person with no assistant, or no chat on it, and never another person's", async () => {
    await chatOf(BOB);
    expect(await podConversationId(prisma, ALICE.oid)).toBeNull();

    await withMainSession(ALICE);
    expect(await podConversationId(prisma, ALICE.oid)).toBeNull();
  });

  it("should leave out a local session's chat, which has no pod", async () => {
    await withMainSession(ALICE);
    await prisma.assistantConversation.create({ data: { ownerOid: ALICE.oid, virtualAgentId: null } });

    expect(await podConversationId(prisma, ALICE.oid)).toBeNull();
  });
});
