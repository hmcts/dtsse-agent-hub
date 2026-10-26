import { canManageExportDefaults } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import { checkConfluenceDefault, checkJiraDefault, type ExportDefaults, exportDefaultsOf } from "./export-defaults.ts";

/**
 * Each person's own export defaults, one row each. `canManageExportDefaults` is asked on every call, as
 * `canManageTemplate` is for templates, and the `owner_oid` in every query is what makes another person's unreachable.
 */

export interface DefaultsTarget {
  actorOid: string;
  ownerOid: string;
}

function allow({ actorOid, ownerOid }: DefaultsTarget): void {
  if (!canManageExportDefaults(actorOid, ownerOid)) {
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
  confluenceAncestors: true
} as const;

export async function readExportDefaults(db: Database, target: DefaultsTarget): Promise<ExportDefaults> {
  allow(target);
  return exportDefaultsOf(await db.assistantExportDefault.findUnique({ where: { ownerOid: target.ownerOid }, select: SELECT }));
}

/** Replaces both defaults with what the person chose, either of which may be none, and answers them as stored. */
export async function saveExportDefaults(
  db: Database,
  target: DefaultsTarget,
  input: { jira: unknown; confluence: unknown },
  now: Date = new Date()
): Promise<ExportDefaults> {
  allow(target);
  const jira = checkJiraDefault(input.jira ?? null);
  if (jira === undefined) {
    throw new HttpError(400, "pick a Jira project from the search");
  }
  const confluence = checkConfluenceDefault(input.confluence ?? null);
  if (confluence === undefined) {
    throw new HttpError(400, "pick a Confluence page from the search");
  }
  const data = {
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
  return { jira, confluence };
}
