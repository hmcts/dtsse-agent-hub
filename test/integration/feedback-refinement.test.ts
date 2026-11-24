import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/agent-api/http.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { recordJiraExport } from "../../src/assistant/jira-store.ts";
import { recordRefinement, refinableThreads, setThreadsTheme } from "../../src/feedback/refinement-store.ts";
import { archiveProject, createProject } from "../../src/feedback/store.ts";
import { createThread, listThreads } from "../../src/feedback/thread-store.ts";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * Themes, refinements and their Jira issues on a project's threads, through Postgres. Alice owns the project, Bob is
 * on its team, and Carol reviews through a link and is nobody to the project.
 */

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

const ANCHOR = {
  selector: "#fee",
  text: "The court fee is £404.",
  tag: "p",
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 1280, height: 800 }
};

beforeEach(async () => {
  await resetDatabase();
  for (const who of [ALICE, BOB, CAROL]) {
    await insertUser(who);
  }
});

async function setUp() {
  const made = await createProject(prisma, ALICE.oid, {
    name: "Claims prototype",
    links: [{ label: "Version 1", targetUrl: "https://claims-v1.herokuapp.com/start", prototypeVersion: null }],
    memberOids: [BOB.oid],
    maskInputs: false,
    retentionDays: 90
  });
  const token = made.links[0]!.token;
  const raise = async (body: string) =>
    (
      await createThread(prisma, CAROL.oid, token, {
        pagePath: "/check",
        pageTitle: null,
        anchor: ANCHOR,
        body,
        snapshot: false,
        recordingId: null,
        offsetMs: null
      })
    ).thread.id;
  return { made, token, first: await raise("Fee too late"), second: await raise("Button unclear") };
}

async function refusal(work: Promise<unknown>): Promise<number> {
  try {
    await work;
  } catch (error) {
    if (error instanceof HttpError) {
      return error.status;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A conversation of `owner`'s on a pod, with a ticket document whose Jira export is under way. */
async function exportingConversation(owner: string) {
  const assistant = await ensureAssistant(prisma, { oid: owner, modelRoute: "gateway" });
  const conversation = await prisma.assistantConversation.create({
    data: { ownerOid: owner, virtualAgentId: assistant.id },
    select: { id: true, virtualAgentId: true, ownerOid: true }
  });
  const exportId = randomUUID();
  await prisma.assistantDocument.create({
    data: { conversationId: conversation.id, kind: "ticket", markdown: "# Story", version: 1, jiraExportId: exportId, jiraStatus: "pending" }
  });
  return { conversation, exportId };
}

describe("setThreadsTheme", () => {
  it("should give the team's chosen threads a theme, and clear it with null", async () => {
    const { made, first, second } = await setUp();

    expect(await setThreadsTheme(prisma, BOB.oid, made.id, [first, second, "not-an-id"], "Court fees")).toBe(2);
    expect((await listThreads(prisma, ALICE.oid, { projectId: made.id })).map((thread) => thread.theme)).toEqual(["Court fees", "Court fees"]);

    expect(await setThreadsTheme(prisma, ALICE.oid, made.id, [first], null)).toBe(1);
    expect((await listThreads(prisma, ALICE.oid, { projectId: made.id })).map((thread) => thread.theme)).toEqual([null, "Court fees"]);
  });

  it("should refuse a reviewer, an archived project, and a list with no threads in it", async () => {
    const { made, first } = await setUp();

    expect(await refusal(setThreadsTheme(prisma, CAROL.oid, made.id, [first], "x"))).toBe(404);
    expect(await refusal(setThreadsTheme(prisma, ALICE.oid, made.id, ["nope"], "x"))).toBe(400);
    await archiveProject(prisma, ALICE.oid, made.id);
    expect(await refusal(setThreadsTheme(prisma, ALICE.oid, made.id, [first], "x"))).toBe(409);
  });
});

describe("refinableThreads", () => {
  it("should keep only the project's own threads, and refuse when none of them are", async () => {
    const { made, first } = await setUp();
    const other = await setUp();

    expect(await refinableThreads(prisma, ALICE.oid, made.id, [first, other.first])).toEqual([first]);
    expect(await refusal(refinableThreads(prisma, ALICE.oid, made.id, [other.first]))).toBe(404);
  });

  it("should refuse more threads than one refinement takes", async () => {
    const { made } = await setUp();

    expect(
      await refusal(
        refinableThreads(
          prisma,
          ALICE.oid,
          made.id,
          Array.from({ length: 41 }, () => randomUUID())
        )
      )
    ).toBe(400);
  });
});

describe("recordRefinement and the Jira export", () => {
  it("should show the threads refined in the viewer's own conversation, and the issue exported from it", async () => {
    const { made, first, second } = await setUp();
    const { conversation, exportId } = await exportingConversation(BOB.oid);

    await recordRefinement(prisma, BOB.oid, made.id, conversation.id, [first]);
    await recordJiraExport(prisma, conversation, { export_id: exportId, key: "PCS-123" });
    await recordJiraExport(prisma, conversation, { export_id: exportId, key: "PCS-123" });

    const forBob = await listThreads(prisma, BOB.oid, { projectId: made.id });
    expect(forBob.map((thread) => [thread.id, thread.jiraKeys, thread.refinedIn])).toEqual([
      [first, ["PCS-123"], conversation.id],
      [second, [], null]
    ]);
    // Alice sees the issue, but the conversation is Bob's to open.
    expect((await listThreads(prisma, ALICE.oid, { projectId: made.id }))[0]).toMatchObject({ jiraKeys: ["PCS-123"], refinedIn: null });
    // The reviewer who raised it sees that it went into an issue, but not the team's theme for it, nor Bob's chat.
    await setThreadsTheme(prisma, BOB.oid, made.id, [first], "Won't fix");
    expect((await listThreads(prisma, CAROL.oid, { token: made.links[0]!.token }))[0]).toMatchObject({ jiraKeys: ["PCS-123"], theme: null, refinedIn: null });
    expect((await listThreads(prisma, BOB.oid, { token: made.links[0]!.token }))[0]).toMatchObject({ theme: "Won't fix", refinedIn: conversation.id });
  });

  it("should keep a refinement's Jira issues on its threads after its conversation is deleted", async () => {
    const { made, first } = await setUp();
    const { conversation, exportId } = await exportingConversation(BOB.oid);
    await recordRefinement(prisma, BOB.oid, made.id, conversation.id, [first]);
    await recordJiraExport(prisma, conversation, { export_id: exportId, key: "PCS-7" });

    await prisma.assistantConversation.delete({ where: { id: conversation.id } });

    expect((await listThreads(prisma, BOB.oid, { projectId: made.id }))[0]).toMatchObject({ jiraKeys: ["PCS-7"], refinedIn: null });
  });

  it("should keep a refinement's Jira issues on its threads after the person who started it is deleted", async () => {
    const { made, first } = await setUp();
    const { conversation, exportId } = await exportingConversation(BOB.oid);
    await recordRefinement(prisma, BOB.oid, made.id, conversation.id, [first]);
    await recordJiraExport(prisma, conversation, { export_id: exportId, key: "PCS-8" });

    // Bob leaves: his chat and assistant go with him, then his membership and his user row.
    await prisma.assistantConversation.deleteMany({ where: { ownerOid: BOB.oid } });
    await prisma.virtualAgent.deleteMany({ where: { ownerOid: BOB.oid } });
    await prisma.feedbackMember.deleteMany({ where: { memberOid: BOB.oid } });
    await prisma.user.delete({ where: { oid: BOB.oid } });

    expect((await listThreads(prisma, ALICE.oid, { projectId: made.id }))[0]?.jiraKeys).toEqual(["PCS-8"]);
  });

  it("should leave a failed export, and a conversation that refines nothing, without issues on any thread", async () => {
    const { made, first } = await setUp();
    const refining = await exportingConversation(ALICE.oid);
    const plain = await exportingConversation(ALICE.oid);
    await recordRefinement(prisma, ALICE.oid, made.id, refining.conversation.id, [first]);

    await recordJiraExport(prisma, refining.conversation, { export_id: refining.exportId, error: "Jira said no" });
    await recordJiraExport(prisma, plain.conversation, { export_id: plain.exportId, key: "PCS-9" });

    expect((await listThreads(prisma, ALICE.oid, { projectId: made.id }))[0]?.jiraKeys).toEqual([]);
  });

  it("should refuse to record a refinement in someone else's conversation, or by a reviewer", async () => {
    const { made, first } = await setUp();
    const { conversation } = await exportingConversation(ALICE.oid);

    expect(await refusal(recordRefinement(prisma, BOB.oid, made.id, conversation.id, [first]))).toBe(404);
    expect(await refusal(recordRefinement(prisma, CAROL.oid, made.id, conversation.id, [first]))).toBe(404);
    expect(await prisma.feedbackRefinement.count()).toBe(0);
  });
});
