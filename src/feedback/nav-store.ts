import { canChangeFeedbackProject, feedbackProjectAccess } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { clientPrisma } from "../store/client-namespace.ts";
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
  /** See `lastActive`. */
  lastActiveAt: Date;
  /** Comments, replies included, and finished recordings by anyone else since the viewer last opened it; all of them if never. */
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

/**
 * When project `p` last saw activity: its own change, or the latest change to one of its threads (a resolve or
 * re-anchor included), comments or recordings. The one definition the sidebar, its search and the list of projects share.
 */
function lastActive() {
  return clientPrisma().sql`GREATEST(
    p.updated_at,
    (SELECT max(t.updated_at) FROM feedback_thread t WHERE t.project_id = p.id),
    (SELECT max(c.created_at) FROM feedback_comment c JOIN feedback_thread t ON t.id = c.thread_id WHERE t.project_id = p.id),
    (SELECT max(GREATEST(r.started_at, r.ended_at)) FROM feedback_recording r WHERE r.project_id = p.id)
  )`;
}

function onTeam(viewerOid: string) {
  return clientPrisma().sql`p.archived_at IS NULL
    AND (p.owner_oid = ${viewerOid} OR EXISTS (SELECT 1 FROM feedback_member m WHERE m.project_id = p.id AND m.member_oid = ${viewerOid}))`;
}

/** As many as the sidebar reads of a person's chats. Pinned ones first, so the limit never drops a pin. */
const NAV_LIMIT = 200;

export async function navProjects(db: Database, viewerOid: string): Promise<NavProjectRow[]> {
  const rows = await db.$queryRaw<RawProject[]>`
    SELECT p.id::text AS id,
           p.name,
           p.owner_oid AS "ownerOid",
           EXISTS (SELECT 1 FROM feedback_member m WHERE m.project_id = p.id AND m.member_oid = ${viewerOid}) AS "isMember",
           s.pinned_at AS "pinnedAt",
           ${lastActive()} AS "lastActiveAt",
           ((SELECT count(*) FROM feedback_comment c JOIN feedback_thread t ON t.id = c.thread_id
              WHERE t.project_id = p.id AND c.author_oid <> ${viewerOid} AND (s.seen_at IS NULL OR c.created_at > s.seen_at))
            + (SELECT count(*) FROM feedback_recording r
              WHERE r.project_id = p.id AND r.status = 'ready' AND r.author_oid <> ${viewerOid} AND (s.seen_at IS NULL OR r.started_at > s.seen_at)))::int AS unread
      FROM feedback_project p
      LEFT JOIN feedback_project_person s ON s.project_id = p.id AND s.person_oid = ${viewerOid}
     WHERE ${onTeam(viewerOid)}
     ORDER BY s.pinned_at IS NULL, "lastActiveAt" DESC, p.id
     LIMIT ${NAV_LIMIT}
  `;
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

export type ProjectMatchRow = Pick<NavProjectRow, "id" | "name" | "lastActiveAt">;

/**
 * Up to `limit` of the projects `navProjects` lists whose name holds every one of `terms`, which are lower-case
 * already, most recently active first.
 */
export async function searchProjects(db: Database, viewerOid: string, terms: readonly string[], limit: number): Promise<ProjectMatchRow[]> {
  if (terms.length === 0) {
    return [];
  }
  return await db.$queryRaw<ProjectMatchRow[]>`
    SELECT p.id::text AS id, p.name, ${lastActive()} AS "lastActiveAt"
      FROM feedback_project p
     WHERE ${onTeam(viewerOid)}
       AND NOT EXISTS (SELECT 1 FROM unnest(${terms}::text[]) AS u(term) WHERE strpos(lower(p.name), u.term) = 0)
     ORDER BY "lastActiveAt" DESC, p.id
     LIMIT ${limit}
  `;
}

/** `lastActive` of each of `projectIds`, archived or not, for the list of projects. */
export async function projectsLastActive(db: Database, projectIds: readonly string[]): Promise<Map<string, Date>> {
  const rows = await db.$queryRaw<{ id: string; at: Date }[]>`
    SELECT p.id::text AS id, ${lastActive()} AS at FROM feedback_project p WHERE p.id = ANY(${projectIds}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row.at]));
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
