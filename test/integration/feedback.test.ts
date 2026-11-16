import { beforeEach, describe, expect, it } from "vitest";
import { feedbackTeam } from "../../src/access/load.ts";
import { HttpError } from "../../src/agent-api/http.ts";
import { MAX_THREADS_PER_WINDOW } from "../../src/feedback/limits.ts";
import { completeRecording, getRecording, listRecordings, recordingPages, requestSegment, startRecording } from "../../src/feedback/recording-store.ts";
import {
  addLink,
  archiveProject,
  createProject,
  findLink,
  getProject,
  hasFeedbackProjects,
  listProjects,
  mentionablePeople,
  openFeedbackLink,
  revokeLink,
  rotateLink,
  setMembers,
  updateSettings
} from "../../src/feedback/store.ts";
import { sweepFeedback } from "../../src/feedback/sweep.ts";
import { createThread, listThreads, patchThread, replyToThread } from "../../src/feedback/thread-store.ts";
import { decodeEvent, HUB_CHANNEL } from "../../src/realtime/events.ts";
import { byCodePoint } from "../../src/topics/slug.ts";
import { connect, insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";

/**
 * Prototype feedback through Postgres. Alice owns the project and Bob is on its team. Carol and Dan are nobody to it
 * but signed in, so holding a live link makes each a reviewer, of that link only.
 */

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");
const DAN = person("dan");

const ANCHOR = { selector: "#main button", text: "Continue", tag: "button", rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 1280, height: 800 } };
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  for (const who of [ALICE, BOB, CAROL, DAN]) {
    await insertUser(who);
  }
});

async function project(memberOids: string[] = [BOB.oid]) {
  return await createProject(prisma, ALICE.oid, {
    name: "Claims prototype",
    links: [
      { label: "Version 1", targetUrl: "https://claims-v1.herokuapp.com/start", prototypeVersion: "1.0" },
      { label: "Version 2", targetUrl: "https://claims-v2.herokuapp.com/", prototypeVersion: null }
    ],
    memberOids,
    maskInputs: false,
    retentionDays: 90
  });
}

function thread(body = "Hard to find", extra: { snapshot?: boolean; recordingId?: string | null; offsetMs?: number | null } = {}) {
  return { pagePath: "/start", anchor: ANCHOR, body, snapshot: false, recordingId: null, offsetMs: null, ...extra };
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

/** The `feedback` events `act` sent, heard on the hub's channel. */
async function announced(act: () => Promise<unknown>): Promise<{ project_id: string; link_id: string | null }[]> {
  const listener = await connect();
  try {
    const heard: { project_id: string; link_id: string | null }[] = [];
    listener.on("notification", (notification) => {
      const event = decodeEvent(notification.payload);
      if (event?.type === "feedback") {
        heard.push({ project_id: event.project_id, link_id: event.link_id });
      }
    });
    await listener.query(`LISTEN ${HUB_CHANNEL}`);
    await act();
    await listener.query("SELECT 1");
    return heard;
  } finally {
    await listener.end();
  }
}

describe("feedback projects", () => {
  it("should list a project to its owner and its team and to nobody else", async () => {
    // Arrange
    const made = await project();

    // Act
    const [mine, bobs, carols] = await Promise.all([listProjects(prisma, ALICE.oid), listProjects(prisma, BOB.oid), listProjects(prisma, CAROL.oid)]);

    // Assert
    expect(mine).toEqual([expect.objectContaining({ id: made.id, access: "owner", links: 2, openThreads: 0, recordings: 0 })]);
    expect(bobs).toEqual([expect.objectContaining({ id: made.id, access: "member", owner: { oid: ALICE.oid, name: ALICE.name, email: ALICE.email } })]);
    expect(carols).toEqual([]);
    expect(made.members).toEqual([{ oid: BOB.oid, name: BOB.name, email: BOB.email }]);
    expect(made.links.map((link) => link.origin)).toEqual(["https://claims-v1.herokuapp.com", "https://claims-v2.herokuapp.com"]);
    expect(await refusal(getProject(prisma, CAROL.oid, made.id))).toBe(404);
    expect(await refusal(getProject(prisma, CAROL.oid, "not-a-uuid"))).toBe(404);
  });

  it("should let the owner alone change a project, and refuse a team naming someone the hub has not seen", async () => {
    const made = await project();

    expect(await refusal(addLink(prisma, BOB.oid, made.id, { label: "v3", targetUrl: "https://v3.example/", prototypeVersion: null }))).toBe(403);
    expect(await refusal(setMembers(prisma, ALICE.oid, made.id, ["dev-nobody"]))).toBe(400);
    expect(await refusal(setMembers(prisma, ALICE.oid, made.id, [ALICE.oid]))).toBe(400);
    expect(await setMembers(prisma, ALICE.oid, made.id, [CAROL.oid])).toEqual([{ oid: CAROL.oid, name: CAROL.name, email: CAROL.email }]);
    expect(await listProjects(prisma, BOB.oid)).toEqual([]);
    expect((await updateSettings(prisma, ALICE.oid, made.id, { name: "Renamed", maskInputs: true, retentionDays: undefined })).maskInputs).toBe(true);
  });

  it("should announce a project's changes inside their transactions", async () => {
    let made: Awaited<ReturnType<typeof project>> | undefined;
    const heard = await announced(async () => {
      made = await project();
    });

    expect(heard).toEqual([{ project_id: made?.id, link_id: null }]);
  });

  it("should archive a project, which ends its links for everyone and keeps it out of the list", async () => {
    const made = await project();
    const token = made.links[0]!.token;

    await archiveProject(prisma, ALICE.oid, made.id);

    expect(await refusal(openFeedbackLink(prisma, ALICE.oid, token))).toBe(404);
    expect(await refusal(openFeedbackLink(prisma, CAROL.oid, token))).toBe(404);
    expect(await listProjects(prisma, ALICE.oid)).toEqual([]);
    expect(await listProjects(prisma, ALICE.oid, { includeArchived: true })).toHaveLength(1);
    expect(await refusal(updateSettings(prisma, ALICE.oid, made.id, { name: "x", maskInputs: undefined, retentionDays: undefined }))).toBe(409);
  });
});

describe("feedback links", () => {
  it("should find a link by its token with its project and team", async () => {
    const made = await project();
    const link = made.links[0]!;

    expect(await findLink(prisma, link.token)).toEqual({
      id: link.id,
      projectId: made.id,
      token: link.token,
      origin: "https://claims-v1.herokuapp.com",
      targetUrl: "https://claims-v1.herokuapp.com/start",
      label: "Version 1",
      prototypeVersion: "1.0",
      revokedAt: null,
      project: { id: made.id, name: "Claims prototype", ownerOid: ALICE.oid, archivedAt: null, maskInputs: false, retentionDays: 90 },
      memberOids: [BOB.oid]
    });
    expect(await findLink(prisma, "not a token")).toBeUndefined();
    expect((await openFeedbackLink(prisma, BOB.oid, link.token)).access).toBe("team");
    expect((await openFeedbackLink(prisma, CAROL.oid, link.token)).access).toBe("reviewer");
  });

  it("should stop a revoked link working for anyone, and keep it findable as revoked", async () => {
    const made = await project();
    const link = made.links[0]!;

    await revokeLink(prisma, ALICE.oid, made.id, link.id);

    expect((await findLink(prisma, link.token))?.revokedAt).toBeInstanceOf(Date);
    expect(await refusal(openFeedbackLink(prisma, CAROL.oid, link.token))).toBe(404);
    expect(await refusal(rotateLink(prisma, ALICE.oid, made.id, link.id))).toBe(409);
  });

  it("should give a rotated link a new token and retire the old one", async () => {
    const made = await project();
    const link = made.links[0]!;

    const rotated = await rotateLink(prisma, ALICE.oid, made.id, link.id);

    expect(rotated.token).not.toBe(link.token);
    expect(await findLink(prisma, link.token)).toBeUndefined();
    expect((await findLink(prisma, rotated.token))?.id).toBe(link.id);
  });
});

describe("feedback threads", () => {
  it("should make a thread, its first comment and its mentions in one transaction, and announce it", async () => {
    // Arrange
    const made = await project();
    const link = made.links[0]!;

    // Act
    let created: Awaited<ReturnType<typeof createThread>> | undefined;
    const heard = await announced(async () => {
      created = await createThread(prisma, CAROL.oid, link.token, thread(`@${ALICE.name} and @${BOB.name}, this is hard to find`, { snapshot: true }));
    });

    // Assert
    expect(created?.snapshotPath).toBe(`${made.id}/snapshots/${created?.thread.id}.json.gz`);
    expect(created?.thread).toMatchObject({
      linkId: link.id,
      pagePath: "/start",
      anchor: ANCHOR,
      status: "open",
      author: { oid: CAROL.oid, name: CAROL.name },
      prototypeVersion: "1.0",
      snapshotBlob: created?.snapshotPath
    });
    expect(created?.thread.comments).toEqual([
      expect.objectContaining({ author: { oid: CAROL.oid, name: CAROL.name }, mentions: [ALICE.oid, BOB.oid].sort(byCodePoint) })
    ]);
    expect(heard).toEqual([{ project_id: made.id, link_id: link.id }]);
  });

  it("should write nothing when the thread cannot be made", async () => {
    const made = await project();

    await expect(createThread(prisma, CAROL.oid, made.links[0]!.token, thread("x", { recordingId: crypto.randomUUID(), offsetMs: 5 }))).rejects.toThrow(
      "not one of your recordings"
    );

    expect(await prisma.feedbackThread.count()).toBe(0);
    expect(await prisma.feedbackComment.count()).toBe(0);
  });

  it("should show a reviewer only their own link's threads, and the team every link's", async () => {
    const made = await project();
    const [first, second] = made.links;
    await createThread(prisma, CAROL.oid, first!.token, thread("on one"));
    await createThread(prisma, DAN.oid, second!.token, thread("on two"));

    const carols = await listThreads(prisma, CAROL.oid, { token: first!.token });
    const teams = await listThreads(prisma, BOB.oid, { projectId: made.id });
    const filtered = await listThreads(prisma, BOB.oid, { projectId: made.id }, { linkId: second!.id, authorOid: DAN.oid });

    expect(carols.map((row) => row.comments[0]?.body)).toEqual(["on one"]);
    expect(teams.map((row) => row.comments[0]?.body)).toEqual(["on one", "on two"]);
    expect(filtered.map((row) => row.comments[0]?.body)).toEqual(["on two"]);
    expect(await refusal(listThreads(prisma, CAROL.oid, { projectId: made.id }))).toBe(404);
  });

  it("should offer a reviewer the people of their own link to mention, and never another link's reviewers", async () => {
    const made = await project();
    await createThread(prisma, CAROL.oid, made.links[0]!.token, thread());
    await createThread(prisma, DAN.oid, made.links[1]!.token, thread());

    const people = await mentionablePeople(prisma, made.id, made.links[0]!.id);

    expect(people.map((who) => who.oid).sort(byCodePoint)).toEqual([ALICE.oid, BOB.oid, CAROL.oid].sort(byCodePoint));
  });

  it("should reply, resolve and re-anchor, through the link and from the team's pages", async () => {
    const made = await project();
    const token = made.links[0]!.token;
    const { thread: created } = await createThread(prisma, CAROL.oid, token, thread());

    const reply = await replyToThread(prisma, BOB.oid, { projectId: made.id }, created.id, `Thanks @${CAROL.name}`);
    const resolved = await patchThread(prisma, CAROL.oid, { token }, created.id, { status: "resolved" });
    const moved = await patchThread(prisma, BOB.oid, { projectId: made.id }, created.id, { anchor: { ...ANCHOR, selector: "#other" }, pagePath: "/next" });

    expect(reply).toMatchObject({ author: { oid: BOB.oid, name: BOB.name }, mentions: [CAROL.oid] });
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: { oid: CAROL.oid, name: CAROL.name } });
    expect(moved).toMatchObject({ status: "open", resolvedBy: null, resolvedAt: null, pagePath: "/next", anchor: { selector: "#other" } });
    expect(moved.comments).toHaveLength(2);
    expect(await refusal(replyToThread(prisma, DAN.oid, { token: "x".repeat(43) }, created.id, "hi"))).toBe(404);
  });

  it("should refuse a reviewer's thread with a 429 once they have made the most a window allows on the link", async () => {
    const made = await project();
    const link = made.links[0]!;
    await prisma.feedbackThread.createMany({
      data: Array.from({ length: MAX_THREADS_PER_WINDOW }, () => ({ projectId: made.id, linkId: link.id, authorOid: CAROL.oid, pagePath: "/", anchor: ANCHOR }))
    });

    expect(await refusal(createThread(prisma, CAROL.oid, link.token, thread()))).toBe(429);
    // Somebody else on the same link still has their own room.
    expect((await createThread(prisma, DAN.oid, link.token, thread())).thread.author.oid).toBe(DAN.oid);
  });
});

describe("feedback recordings", () => {
  it("should record segments, retry one at the same path, stop, and play back in order", async () => {
    // Arrange
    const made = await project();
    const token = made.links[0]!.token;
    const recording = await startRecording(prisma, CAROL.oid, token);

    // Act
    const audio = await requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "audio", seq: 0, pagePath: "/start", offsetMs: 0, bytes: 100 });
    const again = await requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "audio", seq: 0, pagePath: "/start", offsetMs: 0, bytes: 120 });
    await requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "replay", seq: 0, pagePath: null, offsetMs: 0, bytes: 50 });
    const { thread: marker } = await createThread(prisma, CAROL.oid, token, thread("during", { recordingId: recording.id, offsetMs: 4000 }));
    const done = await completeRecording(prisma, CAROL.oid, token, recording.id, { durationMs: 12_000 });
    const detail = await getRecording(prisma, BOB.oid, { projectId: made.id }, recording.id);

    // Assert
    expect(audio.blobPath).toBe(`${made.id}/recordings/${recording.id}/audio/0000`);
    expect(again).toEqual(audio);
    expect(done).toMatchObject({ status: "ready", durationMs: 12_000, prototypeVersion: "1.0" });
    expect(detail.segments.map((segment) => [segment.kind, segment.seq, segment.bytes])).toEqual([
      ["audio", 0, 120],
      ["replay", 0, 50]
    ]);
    expect(detail.markers).toEqual([{ threadId: marker.id, offsetMs: 4000, pagePath: "/start" }]);
    expect(await refusal(requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "audio", seq: 1, pagePath: null, offsetMs: 10, bytes: 1 }))).toBe(409);
  });

  it("should show a reviewer their own recordings alone, and the team everyone's", async () => {
    const made = await project();
    const token = made.links[0]!.token;
    const carols = await startRecording(prisma, CAROL.oid, token);
    await startRecording(prisma, DAN.oid, token);

    expect((await listRecordings(prisma, CAROL.oid, { token })).map((row) => row.author.oid)).toEqual([CAROL.oid]);
    expect((await listRecordings(prisma, BOB.oid, { projectId: made.id })).map((row) => row.author.oid).sort(byCodePoint)).toEqual(
      [CAROL.oid, DAN.oid].sort(byCodePoint)
    );
    expect(await refusal(getRecording(prisma, DAN.oid, { token }, carols.id))).toBe(404);
    expect(await refusal(requestSegment(prisma, DAN.oid, token, carols.id, { kind: "audio", seq: 0, pagePath: null, offsetMs: 0, bytes: 1 }))).toBe(404);
    expect(await refusal(completeRecording(prisma, ALICE.oid, token, carols.id, { durationMs: 1 }))).toBe(404);
  });

  it("should complete a recording once when two completes race", async () => {
    const made = await project();
    const token = made.links[0]!.token;
    const recording = await startRecording(prisma, CAROL.oid, token);

    const results = await Promise.allSettled([
      completeRecording(prisma, CAROL.oid, token, recording.id, { durationMs: 1000 }),
      completeRecording(prisma, CAROL.oid, token, recording.id, { durationMs: 2000 })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason instanceof HttpError && refused.reason.status).toBe(409);
    const stored = await prisma.feedbackRecording.findUniqueOrThrow({ where: { id: recording.id } });
    const winner = results.find((result) => result.status === "fulfilled");
    expect(stored.durationMs).toBe(winner?.status === "fulfilled" ? winner.value.durationMs : undefined);
  });
});

describe("sweepFeedback", () => {
  /** Blob deletes that succeed, except for the paths and prefixes `failing` accepts. */
  function blobStub(failing: (path: string) => boolean = () => false) {
    const deleted: string[] = [];
    return {
      deleted,
      blobs: {
        deleteBlobs: async (paths: readonly string[]) => {
          deleted.push(...paths.filter((path) => !failing(path)));
          return paths.filter(failing);
        },
        deletePrefix: async (prefix: string) => {
          if (failing(prefix)) {
            throw new Error("storage down");
          }
          deleted.push(prefix);
          return 1;
        }
      }
    };
  }

  async function aged(who: Person, retentionDays: number) {
    const made = await project();
    await updateSettings(prisma, ALICE.oid, made.id, { name: undefined, maskInputs: undefined, retentionDays });
    const token = made.links[0]!.token;
    const recording = await startRecording(prisma, who.oid, token);
    const { thread: created } = await createThread(prisma, who.oid, token, thread("old", { snapshot: true }));
    const old = new Date(Date.now() - (retentionDays + 1) * DAY_MS);
    await prisma.feedbackRecording.update({ where: { id: recording.id }, data: { startedAt: old } });
    await prisma.feedbackThread.update({ where: { id: created.id }, data: { updatedAt: old } });
    return { made, recording, thread: created };
  }

  it("should delete recordings and threads past their project's retention, blobs first", async () => {
    // Arrange
    const { made, recording, thread: old } = await aged(CAROL, 7);
    const { thread: fresh } = await createThread(prisma, DAN.oid, made.links[0]!.token, thread("new"));
    const { blobs, deleted } = blobStub();

    // Act
    const result = await sweepFeedback(prisma, blobs);

    // Assert
    expect(result).toEqual({ projects: 0, recordings: 1, threads: 1, abandoned: 0, kept: 0 });
    expect(deleted.sort(byCodePoint)).toEqual([`${made.id}/recordings/${recording.id}/`, old.snapshotBlob as string].sort(byCodePoint));
    expect(await prisma.feedbackRecording.count()).toBe(0);
    expect((await prisma.feedbackThread.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([fresh.id]);
  });

  it("should delete a project archived for a week, blobs and rows, and keep one archived since yesterday", async () => {
    const old = await project();
    const recent = await project();
    await archiveProject(prisma, ALICE.oid, old.id, new Date(Date.now() - 8 * DAY_MS));
    await archiveProject(prisma, ALICE.oid, recent.id, new Date(Date.now() - DAY_MS));
    const { blobs, deleted } = blobStub();

    const result = await sweepFeedback(prisma, blobs);

    expect(result?.projects).toBe(1);
    expect(deleted).toEqual([`${old.id}/`]);
    expect((await prisma.feedbackProject.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([recent.id]);
    expect(await prisma.feedbackLink.count({ where: { projectId: old.id } })).toBe(0);
  });

  it("should keep the rows when deleting their blobs fails, for the next sweep to try again", async () => {
    await aged(CAROL, 7);

    const result = await sweepFeedback(prisma, blobStub(() => true).blobs);

    expect(result).toEqual({ projects: 0, recordings: 0, threads: 0, abandoned: 0, kept: 2 });
    expect(await prisma.feedbackRecording.count()).toBe(1);
    expect(await prisma.feedbackThread.count()).toBe(1);
  });

  it("should keep only the rows whose blobs failed, and carry on with every other step", async () => {
    // Arrange
    const first = await aged(CAROL, 7);
    const second = await aged(DAN, 7);
    const archived = await project();
    await archiveProject(prisma, ALICE.oid, archived.id, new Date(Date.now() - 8 * DAY_MS));
    const failing = (path: string) => path.startsWith(`${first.made.id}/recordings/`) || path === second.thread.snapshotBlob;

    // Act
    const result = await sweepFeedback(prisma, blobStub(failing).blobs);

    // Assert
    expect(result).toEqual({ projects: 1, recordings: 1, threads: 1, abandoned: 0, kept: 2 });
    expect((await prisma.feedbackRecording.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([first.recording.id]);
    expect((await prisma.feedbackThread.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([second.thread.id]);
    expect(await prisma.feedbackProject.count({ where: { id: archived.id } })).toBe(0);
  });

  it("should keep a thread a reply reached while its blobs were being deleted", async () => {
    const { made, thread: old } = await aged(CAROL, 7);
    const blobs = {
      deleteBlobs: async () => {
        await replyToThread(prisma, BOB.oid, { projectId: made.id }, old.id, "still looking");
        return [];
      },
      deletePrefix: async () => 0
    };

    const result = await sweepFeedback(prisma, blobs);

    expect(result?.threads).toBe(0);
    expect(await prisma.feedbackThread.count({ where: { id: old.id } })).toBe(1);
  });

  it("should let one pod sweep at a time, holding the lock while the blobs are deleted", async () => {
    await aged(CAROL, 7);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow = {
      deleteBlobs: async () => [],
      deletePrefix: async () => {
        entered();
        await held;
        return 1;
      }
    };

    const first = sweepFeedback(prisma, slow);
    await reached;
    const second = await sweepFeedback(prisma, blobStub().blobs);
    release();

    expect(second).toBeUndefined();
    expect((await first)?.recordings).toBe(1);
  });

  it("should mark failed a recording left running long past the longest one may be", async () => {
    const made = await project();
    const recording = await startRecording(prisma, CAROL.oid, made.links[0]!.token);
    await prisma.feedbackRecording.update({ where: { id: recording.id }, data: { startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000) } });

    const result = await sweepFeedback(prisma, blobStub().blobs);

    expect(result?.abandoned).toBe(1);
    expect((await prisma.feedbackRecording.findUniqueOrThrow({ where: { id: recording.id } })).status).toBe("failed");
  });
});

describe("the team's feedback pages", () => {
  it("should say whether the viewer owns or is on the team of a live project", async () => {
    expect(await hasFeedbackProjects(prisma, ALICE.oid)).toBe(false);
    const made = await project();

    expect(await hasFeedbackProjects(prisma, ALICE.oid)).toBe(true);
    expect(await hasFeedbackProjects(prisma, BOB.oid)).toBe(true);
    expect(await hasFeedbackProjects(prisma, CAROL.oid)).toBe(false);
    await archiveProject(prisma, ALICE.oid, made.id);
    expect(await hasFeedbackProjects(prisma, BOB.oid)).toBe(false);
  });

  it("should read a project's owner and team for the stream's rule, and nothing for one that is not there", async () => {
    const made = await project();

    expect(await feedbackTeam(prisma, made.id)).toEqual({ ownerOid: ALICE.oid, memberOids: [BOB.oid] });
    expect(await feedbackTeam(prisma, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("should list the pages each recording's replay visited, once each, in the order it reached them", async () => {
    const made = await project();
    const token = made.links[0]!.token;
    const recording = await startRecording(prisma, CAROL.oid, token);
    const quiet = await startRecording(prisma, DAN.oid, token);
    for (const [seq, pagePath] of [
      [0, "/start"],
      [1, "/start"],
      [2, "/details"],
      [3, null],
      [4, "/start"]
    ] as const) {
      await requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "replay", seq, pagePath, offsetMs: seq * 1000, bytes: 1 });
    }
    await requestSegment(prisma, CAROL.oid, token, recording.id, { kind: "audio", seq: 0, pagePath: "/audio-only", offsetMs: 0, bytes: 1 });

    const pages = await recordingPages(prisma, [recording.id, quiet.id]);

    expect(pages.get(recording.id)).toEqual(["/start", "/details"]);
    expect(pages.get(quiet.id)).toEqual([]);
    expect((await recordingPages(prisma, [])).size).toBe(0);
  });
});
