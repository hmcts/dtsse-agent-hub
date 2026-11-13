import { canChangeFeedbackProject, feedbackProjectAccess } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { teamProject } from "./store.ts";

/**
 * The viewer's feedback projects as the Assistant's sidebar and its search list them: those they own or are on the
 * team of and that are not archived, with their own pin, what is new to them, and the live links they can share.
 */

export interface NavProjectRow {
  id: string;
  name: string;
  pinnedAt: Date | null;
  /** The latest of the project's own change and the creation of any of its threads, comments or recordings. */
  lastActiveAt: Date;
  /** Comments, replies included, and recordings by anyone else since the viewer last opened it; all of them if never. */
  unread: number;
  /** Whether the viewer may archive it (`canChangeFeedbackProject`). */
  archivable: boolean;
  links: { label: string; token: string }[];
}

interface RawProject {
  id: string;
  name: string;
  ownerOid: string;
  isMember: boolean;
  pinnedAt: Date | null;
  lastActiveAt: Date;
  unread: number;
}

/** `terms` given, only the projects whose name holds every one of them, case aside. */
async function readProjects(db: Database, viewerOid: string, terms: readonly string[] | null): Promise<RawProject[]> {
  return await db.$queryRaw<RawProject[]>`
    SELECT p.id::text AS id,
           p.name,
           p.owner_oid AS "ownerOid",
           EXISTS (SELECT 1 FROM feedback_member m WHERE m.project_id = p.id AND m.member_oid = ${viewerOid}) AS "isMember",
           s.pinned_at AS "pinnedAt",
           GREATEST(
             p.updated_at,
             (SELECT max(t.created_at) FROM feedback_thread t WHERE t.project_id = p.id),
             (SELECT max(c.created_at) FROM feedback_comment c JOIN feedback_thread t ON t.id = c.thread_id WHERE t.project_id = p.id),
             (SELECT max(r.started_at) FROM feedback_recording r WHERE r.project_id = p.id)
           ) AS "lastActiveAt",
           ((SELECT count(*) FROM feedback_comment c JOIN feedback_thread t ON t.id = c.thread_id
              WHERE t.project_id = p.id AND c.author_oid <> ${viewerOid} AND (s.seen_at IS NULL OR c.created_at > s.seen_at))
            + (SELECT count(*) FROM feedback_recording r
              WHERE r.project_id = p.id AND r.author_oid <> ${viewerOid} AND (s.seen_at IS NULL OR r.started_at > s.seen_at)))::int AS unread
      FROM feedback_project p
      LEFT JOIN feedback_project_person s ON s.project_id = p.id AND s.person_oid = ${viewerOid}
     WHERE p.archived_at IS NULL
       AND (p.owner_oid = ${viewerOid} OR EXISTS (SELECT 1 FROM feedback_member m WHERE m.project_id = p.id AND m.member_oid = ${viewerOid}))
       AND (${terms}::text[] IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(${terms}::text[]) AS u(term) WHERE strpos(lower(p.name), u.term) = 0))
  `;
}

async function withLinks(db: Database, viewerOid: string, rows: RawProject[]): Promise<NavProjectRow[]> {
  const links = await db.feedbackLink.findMany({
    where: { projectId: { in: rows.map((row) => row.id) }, revokedAt: null },
    select: { projectId: true, label: true, token: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    pinnedAt: row.pinnedAt,
    lastActiveAt: row.lastActiveAt,
    unread: row.unread,
    archivable: canChangeFeedbackProject(feedbackProjectAccess(viewerOid, row, row.isMember ? [viewerOid] : [])),
    links: links.filter((link) => link.projectId === row.id).map(({ label, token }) => ({ label, token }))
  }));
}

export async function navProjects(db: Database, viewerOid: string): Promise<NavProjectRow[]> {
  return await withLinks(db, viewerOid, await readProjects(db, viewerOid, null));
}

/** The projects `navProjects` lists whose name holds every one of `terms`, which are lower-case already. */
export async function searchProjects(db: Database, viewerOid: string, terms: readonly string[]): Promise<NavProjectRow[]> {
  return terms.length === 0 ? [] : await withLinks(db, viewerOid, await readProjects(db, viewerOid, terms));
}

/**
 * Pins the project in the viewer's own sidebar, or unpins it; any of its team may, and nobody else sees it. Pinning
 * one already pinned keeps when it was first pinned, as a chat's pin does. No NOTIFY: a `feedback` frame goes to the
 * whole team, and nobody else's sidebar changes.
 */
export async function pinProject(prisma: PrismaClient, viewerOid: string, projectId: string, pinned: unknown, now: Date = new Date()): Promise<void> {
  if (typeof pinned !== "boolean") {
    throw new HttpError(400, "say whether the project is pinned");
  }
  await teamProject(prisma, viewerOid, projectId);
  const key = { projectId_personOid: { projectId, personOid: viewerOid } };
  const current = await prisma.feedbackProjectPerson.findUnique({ where: key, select: { pinnedAt: true } });
  if ((current?.pinnedAt != null) === pinned) {
    return;
  }
  const pinnedAt = pinned ? now : null;
  await prisma.feedbackProjectPerson.upsert({ where: key, create: { projectId, personOid: viewerOid, pinnedAt }, update: { pinnedAt } });
}

/**
 * Records that the viewer has seen everything on the project up to `now`. No NOTIFY: it changes nothing anyone else
 * sees, and the action that calls it re-renders the viewer's own page.
 */
export async function markProjectSeen(prisma: PrismaClient, viewerOid: string, projectId: string, now: Date = new Date()): Promise<void> {
  await teamProject(prisma, viewerOid, projectId);
  await prisma.feedbackProjectPerson.upsert({
    where: { projectId_personOid: { projectId, personOid: viewerOid } },
    create: { projectId, personOid: viewerOid, seenAt: now },
    update: { seenAt: now }
  });
}
