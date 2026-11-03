import { isOwner } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import {
  checkConfluenceDefault,
  checkGithubDefault,
  checkGithubProjectDefault,
  checkJiraDefault,
  checkTicketTool,
  type ExportDefaults,
  exportDefaultsOf
} from "./export-defaults.ts";

/**
 * Each person's own export defaults, one row each. `isOwner` is asked on every call, as it is for templates, and the
 * `owner_oid` in every query is what makes another person's unreachable.
 */

export interface DefaultsTarget {
  actorOid: string;
  ownerOid: string;
}

function allow({ actorOid, ownerOid }: DefaultsTarget): void {
  if (!isOwner(actorOid, { ownerOid })) {
    throw new HttpError(403, "you can only change your own defaults");
  }
}

const SELECT = {
  jiraProject: true,
  jiraProjectName: true,
  confluenceParentId: true,
  confluenceParentTitle: true,
  confluenceSpaceId: true,
  confluenceSpaceKey: true,
  confluenceSpaceName: true,
  confluenceAncestors: true,
  ticketTool: true,
  githubRepo: true,
  githubProjectOwner: true,
  githubProjectNumber: true,
  githubProjectTitle: true
} as const;

export async function readExportDefaults(db: Database, target: DefaultsTarget): Promise<ExportDefaults> {
  allow(target);
  return exportDefaultsOf(await db.assistantExportDefault.findUnique({ where: { ownerOid: target.ownerOid }, select: SELECT }));
}

/**
 * Replaces the defaults with what the person chose, and answers them as stored. The project, repository and page may
 * each be none; a ticket tool left out is Jira, so a caller that knows nothing of GitHub keeps a person on Jira.
 */
export async function saveExportDefaults(
  db: Database,
  target: DefaultsTarget,
  input: { ticketTool?: unknown; jira: unknown; github?: unknown; githubProject?: unknown; confluence: unknown },
  now: Date = new Date()
): Promise<ExportDefaults> {
  allow(target);
  const jira = checkJiraDefault(input.jira ?? null);
  if (jira === undefined) {
    throw new HttpError(400, "pick a Jira project from the search");
  }
  const ticketTool = checkTicketTool(input.ticketTool ?? "jira");
  if (ticketTool === undefined) {
    throw new HttpError(400, "pick Jira or GitHub for your tickets");
  }
  const github = checkGithubDefault(input.github ?? null);
  if (github === undefined) {
    throw new HttpError(400, "name the GitHub repository as owner/name, such as hmcts/cft-workspace");
  }
  const githubProject = checkGithubProjectDefault(input.githubProject ?? null);
  if (githubProject === undefined) {
    throw new HttpError(400, "pick the GitHub Project from the search, or none");
  }
  const confluence = checkConfluenceDefault(input.confluence ?? null);
  if (confluence === undefined) {
    throw new HttpError(400, "pick a Confluence page from the search");
  }
  const data = {
    ticketTool,
    githubRepo: github,
    githubProjectOwner: githubProject?.owner ?? null,
    githubProjectNumber: githubProject?.number ?? null,
    githubProjectTitle: githubProject?.title ?? null,
    jiraProject: jira?.key ?? null,
    jiraProjectName: jira?.name ?? null,
    confluenceParentId: confluence?.id ?? null,
    confluenceParentTitle: confluence?.title ?? null,
    confluenceSpaceId: confluence?.space_id ?? null,
    confluenceSpaceKey: confluence?.space_key ?? null,
    confluenceSpaceName: confluence?.space_name ?? null,
    confluenceAncestors: confluence?.ancestors ?? [],
    updatedAt: now
  };
  await db.assistantExportDefault.upsert({ where: { ownerOid: target.ownerOid }, create: { ownerOid: target.ownerOid, ...data }, update: data });
  return { ticketTool, jira, github, githubProject, confluence };
}
