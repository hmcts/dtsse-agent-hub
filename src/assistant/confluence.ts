import { JIRA_EXPORT_TIMEOUT_MS } from "./jira.ts";
import { confluencePageUrl, NUMERIC_ID_RE, SPACE_KEY_RE } from "./lookups.ts";

/**
 * Publishing a conversation's document to Confluence, once, as a new page under a parent page the person picked: what
 * the panel shows, and what the conversation's session is told while an export is pending. The session creates the
 * page with `twg` and its owner's sign-in, so they are its author, and reports the page's id; the hub only records
 * what was asked for and what came of it (`confluence-store.ts`). See "Confluence export" under Conversations in
 * docs/agent-api.md.
 */

/** The same as the Jira export's, for the same reason: a stopped assistant has to start, and its owner may sign in. */
export const CONFLUENCE_EXPORT_TIMEOUT_MS = JIRA_EXPORT_TIMEOUT_MS;

/** The page a document goes under: the ids the export needs, and the names that say where that is. */
export interface ConfluenceParent {
  id: string;
  title: string;
  space_id: string;
  space_key: string;
  space_name: string;
}

/** A page as the panel shows it chosen: the parent, and the titles above it that say where it is. */
export type ConfluencePageChoice = ConfluenceParent & { ancestors: string[] };

/**
 * The page offered before the person picks one, as `DEFAULT_JIRA_PROJECT` is the backlog offered: a temporary built-in
 * default, there for now so the export can be tested, until people have set their own. Read with twg, read-only.
 */
export const DEFAULT_CONFLUENCE_PARENT: ConfluencePageChoice = {
  id: "286130747",
  title: "AI Resources",
  space_id: "286130187",
  space_key: "CATHAI",
  space_name: "Court and Tribunal Hearings (CaTH) AI Project",
  ancestors: ["Court and Tribunal Hearings (CaTH) AI Project Home"]
};

const MAX_TITLE = 255;
const MAX_SPACE_NAME = 200;

function shortText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

/** A parent page as the browser sent it, checked field by field, or `undefined` when any of it is not what it should be. */
export function checkParent(value: unknown): ConfluenceParent | undefined {
  const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const title = shortText(raw.title, MAX_TITLE);
  const spaceName = shortText(raw.space_name, MAX_SPACE_NAME);
  if (
    typeof raw.id !== "string" ||
    !NUMERIC_ID_RE.test(raw.id) ||
    typeof raw.space_id !== "string" ||
    !NUMERIC_ID_RE.test(raw.space_id) ||
    typeof raw.space_key !== "string" ||
    !SPACE_KEY_RE.test(raw.space_key) ||
    title === undefined ||
    spaceName === undefined
  ) {
    return undefined;
  }
  return { id: raw.id, title, space_id: raw.space_id, space_key: raw.space_key, space_name: spaceName };
}

export interface ConfluenceExportRow {
  confluenceExportId: string | null;
  confluenceSpaceId: string | null;
  confluenceSpaceKey: string | null;
  confluenceSpaceName: string | null;
  confluenceParentId: string | null;
  confluenceParentTitle: string | null;
  confluenceStatus: string | null;
  confluencePageId: string | null;
  confluencePageTitle: string | null;
  confluenceError: string | null;
  confluenceRequestedAt: Date | null;
}

export const CONFLUENCE_SELECT = {
  confluenceExportId: true,
  confluenceSpaceId: true,
  confluenceSpaceKey: true,
  confluenceSpaceName: true,
  confluenceParentId: true,
  confluenceParentTitle: true,
  confluenceStatus: true,
  confluencePageId: true,
  confluencePageTitle: true,
  confluenceError: true,
  confluenceRequestedAt: true
} as const;

/** Where the export went, or is going, as the panel names it. */
export interface ConfluencePlace {
  parentTitle: string;
  spaceName: string;
}

/** What the document panel shows of the conversation's Confluence export. */
export type ConfluenceExportView =
  | { status: "none" }
  | ({ status: "pending" } & ConfluencePlace)
  | ({ status: "done"; pageId: string; pageTitle: string | null; url: string } & ConfluencePlace)
  | { status: "failed"; place: ConfluencePlace | null; error: string };

const TIMED_OUT = "Confluence did not answer in time. Try again.";

function placeOf(row: ConfluenceExportRow): ConfluencePlace | null {
  return row.confluenceParentTitle === null || row.confluenceSpaceName === null
    ? null
    : { parentTitle: row.confluenceParentTitle, spaceName: row.confluenceSpaceName };
}

function expired(requestedAt: Date | null, now: Date): boolean {
  return requestedAt === null || now.getTime() - requestedAt.getTime() > CONFLUENCE_EXPORT_TIMEOUT_MS;
}

export function confluenceExportView(row: ConfluenceExportRow, now: Date = new Date()): ConfluenceExportView {
  const place = placeOf(row);
  if (row.confluencePageId !== null && row.confluenceSpaceKey !== null) {
    return {
      status: "done",
      pageId: row.confluencePageId,
      pageTitle: row.confluencePageTitle,
      url: confluencePageUrl(row.confluenceSpaceKey, row.confluencePageId),
      parentTitle: place?.parentTitle ?? "",
      spaceName: place?.spaceName ?? row.confluenceSpaceKey
    };
  }
  if (row.confluenceStatus === "pending" && place !== null) {
    return expired(row.confluenceRequestedAt, now) ? { status: "failed", place, error: TIMED_OUT } : { status: "pending", ...place };
  }
  if (row.confluenceStatus === "failed") {
    return { status: "failed", place, error: row.confluenceError ?? "The page could not be created." };
  }
  return { status: "none" };
}

/** What a direct frame to the conversation's session carries while an export is pending: where, and the id to report under. */
export interface ConfluenceExportFrame {
  export_id: string;
  space_id: string;
  parent_id: string;
}

/** The conversation's pending export, for its session's next message; none once reported or timed out. */
export function pendingConfluenceExport(row: ConfluenceExportRow, now: Date = new Date()): ConfluenceExportFrame | undefined {
  if (
    row.confluenceStatus !== "pending" ||
    row.confluencePageId !== null ||
    row.confluenceExportId === null ||
    row.confluenceSpaceId === null ||
    row.confluenceParentId === null ||
    expired(row.confluenceRequestedAt, now)
  ) {
    return undefined;
  }
  return { export_id: row.confluenceExportId, space_id: row.confluenceSpaceId, parent_id: row.confluenceParentId };
}

/** The message the person is shown asking for the export, which is also what wakes the session. */
export function confluenceExportRequest(parent: Pick<ConfluenceParent, "title" | "space_name">): string {
  return `Please publish this document to Confluence, under "${parent.title}" in ${parent.space_name}.`;
}
