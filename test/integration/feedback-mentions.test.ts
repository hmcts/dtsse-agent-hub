import { beforeEach, describe, expect, it } from "vitest";
import { listMentions, markMentionsSeen, mentionsBadge, unseenMentionCount } from "../../src/feedback/mention-store.ts";
import { archiveProject, createProject, revokeLink } from "../../src/feedback/store.ts";
import { createThread, replyToThread } from "../../src/feedback/thread-store.ts";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * A person's feedback mentions through Postgres. Alice owns the project, Bob is on its team, and Carol reviews
 * through a link and is nobody to the project, so a mention of her opens on the link rather than the project.
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
const T0 = new Date("2026-11-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(async () => {
  await resetDatabase();
  for (const who of [ALICE, BOB, CAROL]) {
    await insertUser(who);
  }
});

async function project() {
  return await createProject(
    prisma,
    ALICE.oid,
    {
      name: "Claims prototype",
      links: [{ label: "Version 1", targetUrl: "https://claims-v1.herokuapp.com/start", prototypeVersion: null }],
      memberOids: [BOB.oid],
      maskInputs: false,
      retentionDays: 90
    },
    T0
  );
}

function thread(body: string) {
  return { pagePath: "/check", pageTitle: "Check your answers – Claims – GOV.UK", anchor: ANCHOR, body, snapshot: false, recordingId: null, offsetMs: null };
}

describe("listMentions", () => {
  it("should list the comments that named the person, newest first, opening on the project for its team", async () => {
    const made = await project();
    const { thread: first } = await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`Fee too late @${ALICE.name}`), at(1));
    await replyToThread(prisma, BOB.oid, { projectId: made.id }, first.id, `And @${ALICE.name} again`, at(2));

    const mentions = await listMentions(prisma, ALICE.oid);

    expect(mentions.map((mention) => mention.body)).toEqual([`And @${ALICE.name} again`, `Fee too late @${ALICE.name}`]);
    expect(mentions[0]).toMatchObject({
      threadId: first.id,
      projectId: made.id,
      projectName: "Claims prototype",
      pagePath: "/check",
      pageTitle: "Check your answers – Claims – GOV.UK",
      anchor: ANCHOR,
      threadStatus: "open",
      author: { oid: BOB.oid, name: BOB.name },
      named: [{ oid: ALICE.oid, name: ALICE.name }],
      seen: false,
      href: `/assistant/feedback/${made.id}?tab=comments&thread=${first.id}`
    });
  });

  it("should open a reviewer's mention on the link's page, and drop it once the link is turned off", async () => {
    const made = await project();
    const link = made.links[0]!;
    const { thread: raised } = await createThread(prisma, CAROL.oid, link.token, thread("Where is the fee?"), at(1));
    await replyToThread(prisma, BOB.oid, { projectId: made.id }, raised.id, `@${CAROL.name} it is on the next page`, at(2));

    expect((await listMentions(prisma, CAROL.oid)).map((mention) => mention.href)).toEqual([`/review/${link.token}?path=%2Fcheck`]);
    expect(await unseenMentionCount(prisma, CAROL.oid)).toBe(1);
    await revokeLink(prisma, ALICE.oid, made.id, link.id, at(3));

    expect(await listMentions(prisma, CAROL.oid)).toEqual([]);
    expect(await unseenMentionCount(prisma, CAROL.oid)).toBe(0);
  });

  it("should keep the team's mentions after the link is turned off, and drop them once the project is archived", async () => {
    const made = await project();
    await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`Look @${ALICE.name}`), at(1));
    await revokeLink(prisma, ALICE.oid, made.id, made.links[0]!.id, at(2));

    expect(await listMentions(prisma, ALICE.oid)).toHaveLength(1);
    await archiveProject(prisma, ALICE.oid, made.id, at(3));

    expect(await listMentions(prisma, ALICE.oid)).toEqual([]);
    expect(await unseenMentionCount(prisma, ALICE.oid)).toBe(0);
  });

  it("should not list a comment that names only someone else, nor one a person wrote naming themselves", async () => {
    const made = await project();
    await createThread(prisma, ALICE.oid, made.links[0]!.token, thread(`Note to self @${ALICE.name}, and @${BOB.name}`), at(1));

    expect(await listMentions(prisma, ALICE.oid)).toEqual([]);
    expect(await listMentions(prisma, BOB.oid)).toHaveLength(1);
  });
});

describe("markMentionsSeen", () => {
  it("should mark only the mentions it is given, keep when one was first seen, and take them off the count", async () => {
    const made = await project();
    await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`One @${ALICE.name}`), at(1));
    await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`Two @${ALICE.name}`), at(2));
    const [two, one] = await listMentions(prisma, ALICE.oid);
    expect(await unseenMentionCount(prisma, ALICE.oid)).toBe(2);

    expect(await markMentionsSeen(prisma, ALICE.oid, [one!.commentId, "not-an-id"], at(5))).toBe(1);
    expect(await markMentionsSeen(prisma, ALICE.oid, [one!.commentId], at(9))).toBe(0);

    expect(await unseenMentionCount(prisma, ALICE.oid)).toBe(1);
    expect((await listMentions(prisma, ALICE.oid)).map((mention) => [mention.commentId, mention.seen])).toEqual([
      [two!.commentId, false],
      [one!.commentId, true]
    ]);
    const row = await prisma.feedbackMention.findFirstOrThrow({ where: { commentId: one!.commentId } });
    expect(row.seenAt).toEqual(at(5));
  });

  it("should mark nothing of another person's, nor when given nothing usable", async () => {
    const made = await project();
    await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`One @${ALICE.name}`), at(1));
    const [mention] = await listMentions(prisma, ALICE.oid);

    expect(await markMentionsSeen(prisma, BOB.oid, [mention!.commentId])).toBe(0);
    expect(await markMentionsSeen(prisma, ALICE.oid, [])).toBe(0);
    expect(await unseenMentionCount(prisma, ALICE.oid)).toBe(1);
  });
});

describe("mentionsBadge", () => {
  it("should hide Mentions from someone nobody has mentioned, count the unseen, and keep the row once all are seen", async () => {
    const made = await project();
    expect(await mentionsBadge(prisma, ALICE.oid)).toBeNull();

    await createThread(prisma, BOB.oid, made.links[0]!.token, thread(`One @${ALICE.name}`), at(1));
    expect(await mentionsBadge(prisma, ALICE.oid)).toBe(1);

    const [mention] = await listMentions(prisma, ALICE.oid);
    await markMentionsSeen(prisma, ALICE.oid, [mention!.commentId]);
    expect(await mentionsBadge(prisma, ALICE.oid)).toBe(0);

    await archiveProject(prisma, ALICE.oid, made.id, at(2));
    expect(await mentionsBadge(prisma, ALICE.oid)).toBeNull();
  });
});
