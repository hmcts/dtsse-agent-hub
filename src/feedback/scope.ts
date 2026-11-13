import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import { openFeedbackLink, teamProject } from "./store.ts";

/**
 * Where a feedback read or write comes from: the review shell, through a share link's token, or the team's own pages,
 * by project. A reviewer reaches only their link's threads and their own recordings; the team, through either, the
 * whole project.
 */
export type FeedbackScope = { token: string } | { projectId: string };

export interface ResolvedScope {
  projectId: string;
  /** The link a token named; null for the team's pages, which cover every link. */
  linkId: string | null;
  access: "team" | "reviewer";
  /** Whether a write may be made: never to an archived project. A token only ever resolves for a live link. */
  writable: boolean;
  prototypeVersion: string | null;
}

export async function resolveScope(db: Database, viewerOid: string, scope: FeedbackScope): Promise<ResolvedScope> {
  if ("token" in scope) {
    const { link, access } = await openFeedbackLink(db, viewerOid, scope.token);
    return { projectId: link.projectId, linkId: link.id, access, writable: true, prototypeVersion: link.prototypeVersion };
  }
  const { project } = await teamProject(db, viewerOid, scope.projectId);
  return { projectId: project.id, linkId: null, access: "team", writable: project.archivedAt === null, prototypeVersion: null };
}

/** `resolveScope`, refusing an archived project, for a write. */
export async function writableScope(db: Database, viewerOid: string, scope: FeedbackScope): Promise<ResolvedScope> {
  const resolved = await resolveScope(db, viewerOid, scope);
  if (!resolved.writable) {
    throw new HttpError(409, "that project is archived");
  }
  return resolved;
}

/** The row filter that holds a query to what the scope reaches. */
export function scopeWhere(scope: ResolvedScope): { projectId: string; linkId?: string } {
  return scope.linkId === null ? { projectId: scope.projectId } : { projectId: scope.projectId, linkId: scope.linkId };
}
