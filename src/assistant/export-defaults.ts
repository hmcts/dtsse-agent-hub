import { type ConfluencePageChoice, checkParent } from "./confluence.ts";
import type { JiraProjectChoice } from "./jira.ts";
import { JIRA_PROJECT_RE, MAX_LOOKUP_ANCESTORS } from "./lookups.ts";

/**
 * Where a person's documents go by default: a Jira project and a Confluence parent page, each optional. The document
 * panel starts from them, and the person can change either for one document there. Pure; the store is
 * `export-default-store.ts`.
 */

export type DefaultJiraProject = JiraProjectChoice;

export type DefaultConfluencePage = ConfluencePageChoice;

export interface ExportDefaults {
  jira: DefaultJiraProject | null;
  confluence: DefaultConfluencePage | null;
}

export const NO_DEFAULTS: ExportDefaults = { jira: null, confluence: null };

const MAX_NAME = 200;
const MAX_ANCESTOR = 255;

/** A Jira project as the browser sent it, or `undefined` when it is not one. `null` is no default. */
export function checkJiraDefault(value: unknown): DefaultJiraProject | null | undefined {
  if (value === null) {
    return null;
  }
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (typeof raw.key !== "string" || !JIRA_PROJECT_RE.test(raw.key) || name === "" || name.length > MAX_NAME) {
    return undefined;
  }
  return { key: raw.key, name };
}

/** A Confluence page as the browser sent it, with the titles above it, or `undefined` when it is not one. */
export function checkConfluenceDefault(value: unknown): DefaultConfluencePage | null | undefined {
  if (value === null) {
    return null;
  }
  const parent = checkParent(value);
  const ancestors = (value as { ancestors?: unknown }).ancestors ?? [];
  if (
    parent === undefined ||
    !Array.isArray(ancestors) ||
    ancestors.length > MAX_LOOKUP_ANCESTORS ||
    !ancestors.every((title) => typeof title === "string" && title.trim() !== "" && title.length <= MAX_ANCESTOR)
  ) {
    return undefined;
  }
  return { ...parent, ancestors: ancestors.map((title: string) => title.trim()) };
}

export interface ExportDefaultRow {
  jiraProject: string | null;
  jiraProjectName: string | null;
  confluenceParentId: string | null;
  confluenceParentTitle: string | null;
  confluenceSpaceId: string | null;
  confluenceSpaceKey: string | null;
  confluenceSpaceName: string | null;
  confluenceAncestors: unknown;
}

/** The stored row as the settings and the panel read it, each half dropped when it is not whole. */
export function exportDefaultsOf(row: ExportDefaultRow | null): ExportDefaults {
  if (row === null) {
    return NO_DEFAULTS;
  }
  const jira = row.jiraProject === null ? null : { key: row.jiraProject, name: row.jiraProjectName ?? row.jiraProject };
  const confluence =
    row.confluenceParentId === null
      ? null
      : (checkConfluenceDefault({
          id: row.confluenceParentId,
          title: row.confluenceParentTitle,
          space_id: row.confluenceSpaceId,
          space_key: row.confluenceSpaceKey,
          space_name: row.confluenceSpaceName ?? row.confluenceSpaceKey,
          ancestors: row.confluenceAncestors
        }) ?? null);
  return { jira, confluence };
}
