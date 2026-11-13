import { randomUUID } from "node:crypto";
import { feedbackMemberOids } from "../access/load.ts";
import { canChangeFeedbackProject, type FeedbackProjectAccess, feedbackLinkAccess, feedbackProjectAccess } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/ids.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { byCodePoint } from "../topics/slug.ts";
import { FEEDBACK_RATE_LIMITED, MAX_LINKS_PER_PROJECT } from "./limits.ts";
import type { MentionablePerson } from "./mentions.ts";
import type { CreateFeedbackProjectInput, FeedbackLinkInput, FeedbackSettingsInput } from "./schemas.ts";
import { isFeedbackToken, newFeedbackToken } from "./tokens.ts";

/**
 * Prototype feedback projects, their share links and their teams: what the owner sets up and the team reads, and the
 * lookups every other feedback store and route starts from. Who may do what is `src/access/rules.ts`; this applies it.
 */

/** A share link as the proxy and the review shell read it: the link, its project, and the project's team. */
export interface FoundFeedbackLink {
  id: string;
  projectId: string;
  token: string;
  origin: string;
  targetUrl: string;
  label: string;
  prototypeVersion: string | null;
  revokedAt: Date | null;
  project: { id: string; name: string; ownerOid: string; archivedAt: Date | null; maskInputs: boolean };
  memberOids: string[];
}

export interface FeedbackLinkView {
  id: string;
  label: string;
  targetUrl: string;
  origin: string;
  token: string;
  prototypeVersion: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface FeedbackPerson {
  oid: string;
  name: string;
  email: string | null;
}

export interface FeedbackProjectView {
  id: string;
  name: string;
  owner: FeedbackPerson;
  access: Exclude<FeedbackProjectAccess, "none">;
  maskInputs: boolean;
  retentionDays: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  links: FeedbackLinkView[];
  members: FeedbackPerson[];
}

export interface FeedbackProjectSummary {
  id: string;
  name: string;
  owner: FeedbackPerson;
  access: Exclude<FeedbackProjectAccess, "none">;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Live links. */
  links: number;
  openThreads: number;
  recordings: number;
}

/** A project the viewer is on the team of, with what they are to it. */
export interface TeamProject {
  project: { id: string; name: string; ownerOid: string; archivedAt: Date | null; maskInputs: boolean; retentionDays: number };
  access: Exclude<FeedbackProjectAccess, "none">;
  memberOids: string[];
}

/** A live link the viewer may review through, with what they are to it. */
export interface OpenFeedbackLink {
  link: FoundFeedbackLink;
  access: "team" | "reviewer";
}

const NOT_FOUND = "that feedback project is not there";
const LINK_NOT_FOUND = "that feedback link is not there, or has been turned off";
const OWNER_ONLY = "only the project's owner can change it";
const ARCHIVED = "that project is archived";

const PERSON = { select: { oid: true, name: true, email: true } } as const;

const LINK_COLUMNS = {
  id: true,
  label: true,
  targetUrl: true,
  origin: true,
  token: true,
  prototypeVersion: true,
  revokedAt: true,
  createdAt: true
} as const;

function linkView(link: {
  id: string;
  label: string;
  targetUrl: string;
  origin: string;
  token: string;
  prototypeVersion: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}): FeedbackLinkView {
  return { ...link, revokedAt: link.revokedAt?.toISOString() ?? null, createdAt: link.createdAt.toISOString() };
}

/** The share link a token names, live or not, or `undefined` for none. Applies no rule: see `openFeedbackLink`. */
export async function findLink(db: Database, token: string): Promise<FoundFeedbackLink | undefined> {
  if (!isFeedbackToken(token)) {
    return undefined;
  }
  const row = await db.feedbackLink.findUnique({
    where: { token },
    select: {
      id: true,
      projectId: true,
      token: true,
      origin: true,
      targetUrl: true,
      label: true,
      prototypeVersion: true,
      revokedAt: true,
      project: { select: { id: true, name: true, ownerOid: true, archivedAt: true, maskInputs: true, members: { select: { memberOid: true } } } }
    }
  });
  if (row === null) {
    return undefined;
  }
  const { members, ...project } = row.project;
  return {
    ...row,
    project,
    memberOids: members.map((member) => member.memberOid).sort(byCodePoint)
  };
}

/** The link a token names when the viewer may review through it, or the 404 a dead or unknown one is reported as. */
export async function openFeedbackLink(db: Database, viewerOid: string, token: string): Promise<OpenFeedbackLink> {
  const link = await findLink(db, token);
  const access = link === undefined ? "none" : feedbackLinkAccess(viewerOid, link, link.memberOids);
  if (link === undefined || access === "none") {
    throw new HttpError(404, LINK_NOT_FOUND);
  }
  return { link, access };
}

/** The project when the viewer is on its team, or the 404 anyone else's is reported as. */
export async function teamProject(db: Database, viewerOid: string, projectId: string): Promise<TeamProject> {
  const project = isUuid(projectId)
    ? await db.feedbackProject.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, ownerOid: true, archivedAt: true, maskInputs: true, retentionDays: true }
      })
    : null;
  if (project === null) {
    throw new HttpError(404, NOT_FOUND);
  }
  const memberOids = await feedbackMemberOids(db, projectId);
  const access = feedbackProjectAccess(viewerOid, project, memberOids);
  if (access === "none") {
    throw new HttpError(404, NOT_FOUND);
  }
  return { project, access, memberOids };
}

/** The project when the viewer owns it and it is not archived, or why not. */
async function ownedProject(db: Database, viewerOid: string, projectId: string): Promise<TeamProject> {
  const team = await teamProject(db, viewerOid, projectId);
  if (!canChangeFeedbackProject(team.access)) {
    throw new HttpError(403, OWNER_ONLY);
  }
  if (team.project.archivedAt !== null) {
    throw new HttpError(409, ARCHIVED);
  }
  return team;
}

/**
 * Takes the link's row for the rest of the transaction, so that the rate limits counted under it are counted one
 * write at a time: two tabs cannot both find room under a limit.
 */
export async function lockFeedbackLink(db: Database, linkId: string): Promise<void> {
  await db.$queryRaw`SELECT 1 FROM feedback_link WHERE id = ${linkId}::uuid FOR UPDATE`;
}

/** Refuses with a 429 when what `count` counted, under `lockFeedbackLink`, is already at `max`. */
export async function underLimit(count: Promise<number>, max: number): Promise<void> {
  if ((await count) >= max) {
    throw new HttpError(429, FEEDBACK_RATE_LIMITED);
  }
}

async function announce(db: Database, projectId: string, linkId: string | null = null): Promise<void> {
  await notify(db, { type: "feedback", project_id: projectId, link_id: linkId });
}

/** Refuses a team that names someone the hub has never seen, or the owner. */
async function checkedMembers(db: Database, ownerOid: string, memberOids: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(memberOids)];
  if (wanted.includes(ownerOid)) {
    throw new HttpError(400, "the project's owner is on its team already");
  }
  const known = await db.user.count({ where: { oid: { in: wanted } } });
  if (known !== wanted.length) {
    throw new HttpError(400, "someone named has not used the hub yet, so cannot be added");
  }
  return wanted;
}

function linkData(input: FeedbackLinkInput) {
  return {
    label: input.label,
    targetUrl: input.targetUrl,
    origin: new URL(input.targetUrl).origin,
    token: newFeedbackToken(),
    prototypeVersion: input.prototypeVersion
  };
}

/** A new project, its links and its team, made at once by its owner. */
export async function createProject(
  prisma: PrismaClient,
  ownerOid: string,
  input: CreateFeedbackProjectInput,
  now: Date = new Date()
): Promise<FeedbackProjectView> {
  const memberOids = await checkedMembers(prisma, ownerOid, input.memberOids);
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.feedbackProject.create({
      data: {
        id,
        ownerOid,
        name: input.name,
        maskInputs: input.maskInputs,
        retentionDays: input.retentionDays,
        createdAt: now,
        updatedAt: now,
        // A millisecond apart, so the links list in the order they were entered rather than by their random ids.
        links: { create: input.links.map((link, index) => ({ ...linkData(link), createdAt: new Date(now.getTime() + index) })) },
        members: { create: memberOids.map((memberOid) => ({ memberOid, addedByOid: ownerOid, createdAt: now })) }
      }
    });
    await announce(tx, id);
  });
  return await getProject(prisma, ownerOid, id);
}

/** The projects the viewer owns or is on the team of, newest first; archived ones only when asked for. */
export async function listProjects(
  db: Database,
  viewerOid: string,
  { includeArchived = false }: { includeArchived?: boolean } = {}
): Promise<FeedbackProjectSummary[]> {
  const rows = await db.feedbackProject.findMany({
    where: {
      OR: [{ ownerOid: viewerOid }, { members: { some: { memberOid: viewerOid } } }],
      ...(includeArchived ? {} : { archivedAt: null })
    },
    select: {
      id: true,
      name: true,
      ownerOid: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      owner: PERSON,
      members: { where: { memberOid: viewerOid }, select: { memberOid: true } },
      _count: { select: { links: { where: { revokedAt: null } }, threads: { where: { status: "open" } }, recordings: true } }
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }]
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    owner: row.owner,
    access: feedbackProjectAccess(
      viewerOid,
      row,
      row.members.map((member) => member.memberOid)
    ) as FeedbackProjectSummary["access"],
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    links: row._count.links,
    openThreads: row._count.threads,
    recordings: row._count.recordings
  }));
}

/** One project as its team sees it: settings, every link with its token, and the team. */
export async function getProject(db: Database, viewerOid: string, projectId: string): Promise<FeedbackProjectView> {
  const { access } = await teamProject(db, viewerOid, projectId);
  const row = await db.feedbackProject.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      maskInputs: true,
      retentionDays: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      owner: PERSON,
      links: { select: LINK_COLUMNS, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      members: { select: { member: PERSON }, orderBy: [{ createdAt: "asc" }, { memberOid: "asc" }] }
    }
  });
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    access,
    maskInputs: row.maskInputs,
    retentionDays: row.retentionDays,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    links: row.links.map(linkView),
    members: row.members.map((member) => member.member)
  };
}

/** Another link on the owner's project, with a token of its own. */
export async function addLink(
  prisma: PrismaClient,
  viewerOid: string,
  projectId: string,
  input: FeedbackLinkInput,
  now: Date = new Date()
): Promise<FeedbackLinkView> {
  await ownedProject(prisma, viewerOid, projectId);
  return await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM feedback_project WHERE id = ${projectId}::uuid FOR UPDATE`;
    if ((await tx.feedbackLink.count({ where: { projectId } })) >= MAX_LINKS_PER_PROJECT) {
      throw new HttpError(409, `a project holds at most ${MAX_LINKS_PER_PROJECT} links`);
    }
    const link = await tx.feedbackLink.create({ data: { projectId, ...linkData(input), createdAt: now }, select: LINK_COLUMNS });
    await tx.feedbackProject.update({ where: { id: projectId }, data: { updatedAt: now } });
    await announce(tx, projectId, link.id);
    return linkView(link);
  });
}

async function ownedLink(db: Database, projectId: string, linkId: string): Promise<{ id: string; revokedAt: Date | null }> {
  const link = isUuid(linkId) ? await db.feedbackLink.findFirst({ where: { id: linkId, projectId }, select: { id: true, revokedAt: true } }) : null;
  if (link === null) {
    throw new HttpError(404, "that link is not on this project");
  }
  return link;
}

/** Turns a link off for everyone at once. Its threads and recordings are kept; revoking one already off changes nothing. */
export async function revokeLink(prisma: PrismaClient, viewerOid: string, projectId: string, linkId: string, now: Date = new Date()): Promise<void> {
  await ownedProject(prisma, viewerOid, projectId);
  const link = await ownedLink(prisma, projectId, linkId);
  if (link.revokedAt !== null) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.feedbackLink.update({ where: { id: linkId }, data: { revokedAt: now } });
    await announce(tx, projectId, linkId);
  });
}

/** Gives a live link a new token, so the old share URL stops working and the link's threads stay with it. */
export async function rotateLink(prisma: PrismaClient, viewerOid: string, projectId: string, linkId: string): Promise<FeedbackLinkView> {
  await ownedProject(prisma, viewerOid, projectId);
  const link = await ownedLink(prisma, projectId, linkId);
  if (link.revokedAt !== null) {
    throw new HttpError(409, "that link is turned off; add a new one instead");
  }
  return await prisma.$transaction(async (tx) => {
    const rotated = await tx.feedbackLink.update({ where: { id: linkId }, data: { token: newFeedbackToken() }, select: LINK_COLUMNS });
    await announce(tx, projectId, linkId);
    return linkView(rotated);
  });
}

/** Replaces the team with `memberOids`, keeping when each person still on it was first added. */
export async function setMembers(
  prisma: PrismaClient,
  viewerOid: string,
  projectId: string,
  memberOids: readonly string[],
  now: Date = new Date()
): Promise<FeedbackPerson[]> {
  const { project } = await ownedProject(prisma, viewerOid, projectId);
  const wanted = await checkedMembers(prisma, project.ownerOid, memberOids);
  await prisma.$transaction(async (tx) => {
    await tx.feedbackMember.deleteMany({ where: { projectId, memberOid: { notIn: wanted } } });
    await tx.feedbackMember.createMany({
      data: wanted.map((memberOid) => ({ projectId, memberOid, addedByOid: viewerOid, createdAt: now })),
      skipDuplicates: true
    });
    await tx.feedbackProject.update({ where: { id: projectId }, data: { updatedAt: now } });
    await announce(tx, projectId);
  });
  return (await getProject(prisma, viewerOid, projectId)).members;
}

/** Renames the project, or changes its masking or retention. A shorter retention is applied at the next sweep. */
export async function updateSettings(
  prisma: PrismaClient,
  viewerOid: string,
  projectId: string,
  input: FeedbackSettingsInput,
  now: Date = new Date()
): Promise<FeedbackProjectView> {
  await ownedProject(prisma, viewerOid, projectId);
  await prisma.$transaction(async (tx) => {
    await tx.feedbackProject.update({
      where: { id: projectId },
      data: { name: input.name, maskInputs: input.maskInputs, retentionDays: input.retentionDays, updatedAt: now }
    });
    await announce(tx, projectId);
  });
  return await getProject(prisma, viewerOid, projectId);
}

/**
 * Archives the project: every link stops working at once, and the sweep deletes the project, its rows and its blobs
 * once it has been archived for `ARCHIVED_PROJECT_DAYS`.
 */
export async function archiveProject(prisma: PrismaClient, viewerOid: string, projectId: string, now: Date = new Date()): Promise<void> {
  await ownedProject(prisma, viewerOid, projectId);
  await prisma.$transaction(async (tx) => {
    await tx.feedbackProject.update({ where: { id: projectId }, data: { archivedAt: now, updatedAt: now } });
    await announce(tx, projectId);
  });
}

/**
 * Who a comment may `@` name: the project's owner and team, and everyone who has commented through `linkId`, or
 * through any of the project's links when there is none. A reviewer is offered the people of their own link, never
 * those who reviewed through another.
 */
export async function mentionablePeople(db: Database, projectId: string, linkId: string | null = null): Promise<MentionablePerson[]> {
  const rows = await db.user.findMany({
    where: {
      OR: [
        { feedbackProjects: { some: { id: projectId } } },
        { feedbackMemberships: { some: { projectId } } },
        { feedbackComments: { some: { thread: linkId === null ? { projectId } : { projectId, linkId } } } }
      ]
    },
    select: { oid: true, name: true },
    orderBy: [{ name: "asc" }, { oid: "asc" }]
  });
  return rows;
}
