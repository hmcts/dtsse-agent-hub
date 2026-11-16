import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../src/agent-api/http.ts";
import { markProjectSeen, navProjects, pinProject, projectsLastActive, searchProjects } from "../../src/feedback/nav-store.ts";
import { completeRecording, startRecording } from "../../src/feedback/recording-store.ts";
import { archiveProject, createProject, revokeLink } from "../../src/feedback/store.ts";
import { createThread, patchThread, replyToThread } from "../../src/feedback/thread-store.ts";
import { insertUser, person, prisma, resetDatabase } from "./database.ts";

/**
 * The Assistant sidebar's feedback projects through Postgres. Alice owns the project, Bob is on its team, and Carol
 * reviews through a link and is nobody to the project.
 */

const ALICE = person("alice");
const BOB = person("bob");
const CAROL = person("carol");

const ANCHOR = { selector: "#main button", text: "Continue", tag: "button", rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 1280, height: 800 } };
const T0 = new Date("2026-11-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(async () => {
  await resetDatabase();
  for (const who of [ALICE, BOB, CAROL]) {
    await insertUser(who);
  }
});

async function project(name = "Claims prototype", now = T0) {
  return await createProject(
    prisma,
    ALICE.oid,
    {
      name,
      links: [
        { label: "Version 1", targetUrl: "https://claims-v1.herokuapp.com/start", prototypeVersion: "1.0" },
        { label: "Version 2", targetUrl: "https://claims-v2.herokuapp.com/", prototypeVersion: null }
      ],
      memberOids: [BOB.oid],
      maskInputs: false,
      retentionDays: 90
    },
    now
  );
}

function thread(body: string) {
  return { pagePath: "/start", anchor: ANCHOR, body, snapshot: false, recordingId: null, offsetMs: null };
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

describe("navProjects", () => {
  it("should list the projects the viewer owns or is on the team of, and not one they only reviewed", async () => {
    const made = await project();
    await createThread(prisma, CAROL.oid, made.links[0]!.token, thread("Hard to find"));

    expect((await navProjects(prisma, ALICE.oid)).map((row) => row.name)).toEqual(["Claims prototype"]);
    expect((await navProjects(prisma, BOB.oid)).map((row) => row.name)).toEqual(["Claims prototype"]);
    expect(await navProjects(prisma, CAROL.oid)).toEqual([]);
  });

  it("should leave out a project once it is archived", async () => {
    const made = await project();
    await archiveProject(prisma, ALICE.oid, made.id);

    expect(await navProjects(prisma, ALICE.oid)).toEqual([]);
    expect(await navProjects(prisma, BOB.oid)).toEqual([]);
  });

  it("should let only the owner archive it from the sidebar", async () => {
    await project();

    expect((await navProjects(prisma, ALICE.oid))[0]?.archivable).toBe(true);
    expect((await navProjects(prisma, BOB.oid))[0]?.archivable).toBe(false);
  });

  it("should carry only the live links, in the order they were added", async () => {
    const made = await project();
    await revokeLink(prisma, ALICE.oid, made.id, made.links[0]!.id);

    expect((await navProjects(prisma, BOB.oid))[0]?.links).toEqual([{ label: "Version 2", token: made.links[1]!.token }]);
  });

  it("should date the project by its latest comment, reply, resolve or recording when one is newer than the project", async () => {
    const made = await project("Claims prototype", T0);
    const token = made.links[1]!.token;
    const { thread: created } = await createThread(prisma, CAROL.oid, made.links[0]!.token, thread("Hard to find"), at(10));
    expect((await navProjects(prisma, ALICE.oid))[0]?.lastActiveAt).toEqual(at(10));

    await replyToThread(prisma, BOB.oid, { projectId: made.id }, created.id, "Thanks", at(20));
    expect((await navProjects(prisma, ALICE.oid))[0]?.lastActiveAt).toEqual(at(20));

    await patchThread(prisma, ALICE.oid, { projectId: made.id }, created.id, { status: "resolved" }, at(25));
    expect((await navProjects(prisma, ALICE.oid))[0]?.lastActiveAt).toEqual(at(25));

    const recording = await startRecording(prisma, CAROL.oid, token, at(30));
    expect((await navProjects(prisma, ALICE.oid))[0]?.lastActiveAt).toEqual(at(30));

    await completeRecording(prisma, CAROL.oid, token, recording.id, { durationMs: 1_000 }, at(40));
    expect((await navProjects(prisma, ALICE.oid))[0]?.lastActiveAt).toEqual(at(40));
  });

  it("should date the list of projects as the sidebar does, an archived one included", async () => {
    const made = await project("Claims prototype", T0);
    const other = await project("Possession prototype", T0);
    await createThread(prisma, CAROL.oid, made.links[0]!.token, thread("Hard to find"), at(10));
    const [row] = await navProjects(prisma, ALICE.oid);
    await archiveProject(prisma, ALICE.oid, other.id);

    const latest = await projectsLastActive(prisma, [made.id, other.id]);

    expect(latest.get(made.id)).toEqual(row?.lastActiveAt);
    expect(latest.get(other.id)).toEqual((await prisma.feedbackProject.findUniqueOrThrow({ where: { id: other.id } })).updatedAt);
  });

  it("should list pinned projects first, then the most recently active", async () => {
    const older = await project("Older prototype", at(1));
    await project("Newer prototype", at(2));
    await project("Newest prototype", at(3));
    await pinProject(prisma, ALICE.oid, older.id, true);

    expect((await navProjects(prisma, ALICE.oid)).map((row) => row.name)).toEqual(["Older prototype", "Newest prototype", "Newer prototype"]);
  });
});

describe("unread", () => {
  it("should count every comment and recording by someone else when the viewer has never opened the project", async () => {
    const made = await project();
    const { thread: created } = await createThread(prisma, CAROL.oid, made.links[0]!.token, thread("Hard to find"), at(1));
    await replyToThread(prisma, BOB.oid, { projectId: made.id }, created.id, "Agreed", at(2));
    await replyToThread(prisma, ALICE.oid, { projectId: made.id }, created.id, "Fixing it", at(3));
    const recording = await startRecording(prisma, CAROL.oid, made.links[0]!.token, at(4));
    await completeRecording(prisma, CAROL.oid, made.links[0]!.token, recording.id, { durationMs: 1_000 }, at(5));

    expect((await navProjects(prisma, ALICE.oid))[0]?.unread).toBe(3);
    expect((await navProjects(prisma, BOB.oid))[0]?.unread).toBe(3);
  });

  it("should not count a recording until it is ready to play", async () => {
    const made = await project();
    const token = made.links[0]!.token;
    const recording = await startRecording(prisma, CAROL.oid, token, at(1));
    expect((await navProjects(prisma, ALICE.oid))[0]?.unread).toBe(0);

    await completeRecording(prisma, CAROL.oid, token, recording.id, { durationMs: 1_000 }, at(2));

    expect((await navProjects(prisma, ALICE.oid))[0]?.unread).toBe(1);
  });

  it("should count only what arrived since the viewer last opened the project", async () => {
    const made = await project();
    const { thread: created } = await createThread(prisma, CAROL.oid, made.links[0]!.token, thread("Hard to find"), at(1));
    await markProjectSeen(prisma, ALICE.oid, made.id, at(2));
    await replyToThread(prisma, BOB.oid, { projectId: made.id }, created.id, "Agreed", at(3));

    expect((await navProjects(prisma, ALICE.oid))[0]?.unread).toBe(1);
    expect((await navProjects(prisma, BOB.oid))[0]?.unread).toBe(1);

    await markProjectSeen(prisma, ALICE.oid, made.id, at(4));
    expect((await navProjects(prisma, ALICE.oid))[0]?.unread).toBe(0);
  });

  it("should refuse to mark seen a project the viewer is not on the team of", async () => {
    const made = await project();

    expect(await refusal(markProjectSeen(prisma, CAROL.oid, made.id))).toBe(404);
  });
});

describe("pinProject", () => {
  it("should pin the project for the viewer alone", async () => {
    const made = await project();

    await pinProject(prisma, BOB.oid, made.id, true, at(5));

    expect((await navProjects(prisma, BOB.oid))[0]?.pinnedAt).toEqual(at(5));
    expect((await navProjects(prisma, ALICE.oid))[0]?.pinnedAt).toBeNull();
  });

  it("should keep when it was first pinned when it is pinned again, and clear it when unpinned", async () => {
    const made = await project();

    await pinProject(prisma, ALICE.oid, made.id, true, at(5));
    await pinProject(prisma, ALICE.oid, made.id, true, at(9));
    expect((await navProjects(prisma, ALICE.oid))[0]?.pinnedAt).toEqual(at(5));

    await pinProject(prisma, ALICE.oid, made.id, false);
    expect((await navProjects(prisma, ALICE.oid))[0]?.pinnedAt).toBeNull();
  });

  it("should keep the pin and the last visit apart on the one row", async () => {
    const made = await project();
    await markProjectSeen(prisma, ALICE.oid, made.id, at(3));
    await pinProject(prisma, ALICE.oid, made.id, true, at(5));
    await pinProject(prisma, ALICE.oid, made.id, false);

    expect(await prisma.feedbackProjectPerson.findMany({ select: { pinnedAt: true, seenAt: true } })).toEqual([{ pinnedAt: null, seenAt: at(3) }]);
  });

  it("should refuse someone not on the team, and a pin that is not a yes or no", async () => {
    const made = await project();

    expect(await refusal(pinProject(prisma, CAROL.oid, made.id, true))).toBe(404);
    expect(await refusal(pinProject(prisma, ALICE.oid, made.id, "yes"))).toBe(400);
  });
});

describe("searchProjects", () => {
  it("should find a project by every word of its name, whatever their case", async () => {
    await project("Claims prototype");
    await project("Possession journey");

    expect((await searchProjects(prisma, BOB.oid, ["claim", "proto"], 50)).map((row) => row.name)).toEqual(["Claims prototype"]);
    expect(await searchProjects(prisma, BOB.oid, ["claim", "journey"], 50)).toEqual([]);
  });

  it("should find nothing by a link's label, and nothing for someone not on the team", async () => {
    await project("Claims prototype");

    expect(await searchProjects(prisma, BOB.oid, ["version"], 50)).toEqual([]);
    expect(await searchProjects(prisma, CAROL.oid, ["claims"], 50)).toEqual([]);
  });

  it("should answer with at most the limit, most recently active first", async () => {
    await project("Claims prototype one", at(1));
    await project("Claims prototype two", at(2));
    await project("Claims prototype three", at(3));

    expect((await searchProjects(prisma, BOB.oid, ["claims"], 2)).map((row) => row.name)).toEqual(["Claims prototype three", "Claims prototype two"]);
  });

  it("should treat a LIKE wildcard in a term as the character itself", async () => {
    await project("Claims prototype");

    expect(await searchProjects(prisma, BOB.oid, ["%"], 50)).toEqual([]);
    expect(await searchProjects(prisma, BOB.oid, [], 50)).toEqual([]);
  });
});
