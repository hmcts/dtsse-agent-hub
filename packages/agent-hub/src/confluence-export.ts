// `agent-hub confluence export`: everything a CFT Workspace conversation's session does to publish its document
// as a new Confluence page, as one command. The session still runs it, so the page is created with the owner's own
// twg sign-in and they are its author; what this saves is a model turn per step. See "Confluence export" under
// Conversations in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import path from "node:path";
import type { Api, Artefact, ConfluenceExportReport } from "./api.ts";
import type { Env } from "./env.ts";
import { withRetry } from "./retry.ts";
import { hubHome, readJson, writeJson } from "./session.ts";
import { claimExport, releaseExport, twgFailureLine, twgSignInProblem } from "./twg-export.ts";

export const CONFLUENCE_EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONFLUENCE_ID_RE = /^[0-9]{1,20}$/;
export const MAX_CONFLUENCE_ERROR = 300;
// Confluence refuses a title over 255 characters.
export const MAX_PAGE_TITLE = 255;
const FALLBACK_TITLE = "CFT Workspace document";
const CREATE_TIMEOUT_MS = 120000;

export type { RunResult } from "./virtual/sign-in.ts";

import type { RunResult } from "./virtual/sign-in.ts";

export type ConfluenceExportRequest = {
  exportId: string;
  spaceId: string;
  parentId: string;
};

export type ConfluenceExportDeps = {
  api: Pick<Api, "getArtefact" | "putConfluenceExport">;
  agentId: string;
  env: Env;
  run: (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;
  /** Signs twg in, relaying a device code to the owner; null outside a pod, where there is nobody to relay it to. */
  login: (() => Promise<"restored" | "signed-in" | "not-signed-in">) | null;
  print: (message: string) => void;
  /** Where created pages are remembered; `hubHome()/confluence-exports` unless a test says otherwise. */
  dir?: string;
  /** Today, for the title tried again when Confluence already has one of the document's. */
  today?: () => Date;
};

export type ConfluenceExportOutcome = { pageId: string; title: string; again: boolean } | { error: string };

export function confluenceExportsDir(): string {
  return path.join(hubHome(), "confluence-exports");
}

// The page is remembered before it is reported, so a report that fails cannot lead to a second page: running the
// command again reports the remembered one instead.
function remembered(dir: string, exportId: string): { pageId: string; title: string } | null {
  const saved = readJson(path.join(dir, `${exportId}.json`)) as { page_id?: unknown; title?: unknown } | null;
  return typeof saved?.page_id === "string" && CONFLUENCE_ID_RE.test(saved.page_id)
    ? { pageId: saved.page_id, title: typeof saved.title === "string" ? saved.title : FALLBACK_TITLE }
    : null;
}

/** One line of page title: the document's title, else its first heading, else a plain fallback. */
export function pageTitle(doc: Pick<Artefact, "title" | "markdown">): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(doc.markdown)?.[1];
  const line = (doc.title?.trim() || heading?.trim() || FALLBACK_TITLE).replace(/\s+/g, " ").trim();
  return line.length > MAX_PAGE_TITLE ? `${line.slice(0, MAX_PAGE_TITLE - 1)}…` : line;
}

/**
 * The page's body: the document's markdown without a leading `#` heading that only repeats the title, because
 * Confluence shows the title above the body and twg's markdown guidance says not to start with it.
 */
export function pageBody(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(markdown);
  return match && match[1]?.replace(/\s+/g, " ").trim() === title ? markdown.slice(match[0].length).replace(/^\s*\n/, "") : markdown;
}

/** The title tried when Confluence already has a page of the document's title in that space. */
export function datedTitle(title: string, today: Date): string {
  const date = today.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  const suffix = ` (${date})`;
  return `${title.slice(0, MAX_PAGE_TITLE - suffix.length)}${suffix}`;
}

/**
 * The new page's id in `twg confluence content create --output=json`: the first numeric `id` found nearest the top,
 * under `data` where there is one, since a created page's JSON also names its space and parent. Null when there is none.
 */
export function parseCreatedPageId(stdout: string, exclude: readonly string[] = []): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = (parsed as { data?: unknown } | null)?.data ?? parsed;
  // Breadth first, so the page's own id is found before any id nested in what it refers to.
  let level: unknown[] = [root];
  for (let depth = 0; depth < 5 && level.length > 0; depth++) {
    const next: unknown[] = [];
    for (const value of level) {
      if (value === null || typeof value !== "object") {
        continue;
      }
      const record = value as Record<string, unknown>;
      for (const key of ["id", "contentId", "pageId"]) {
        const id = typeof record[key] === "number" ? String(record[key]) : record[key];
        if (typeof id === "string" && CONFLUENCE_ID_RE.test(id) && !exclude.includes(id)) {
          return id;
        }
      }
      next.push(...(Array.isArray(value) ? value : Object.values(record)));
    }
    level = next;
  }
  return null;
}

/** Why twg failed, in one line the person can read: its JSON error message when it gave one, else stderr's first line. */
export function confluenceFailure(result: RunResult): string {
  return twgFailureLine(result, "Confluence refused the page", MAX_CONFLUENCE_ERROR);
}

const TITLE_TAKEN_RE = /already exists|same title|title .*(?:taken|in use|exists)/i;

async function create(deps: ConfluenceExportDeps, request: ConfluenceExportRequest, dir: string): Promise<ConfluenceExportOutcome> {
  const doc = await withRetry(() => deps.api.getArtefact(deps.agentId), { attempts: 3 });
  if (!doc.markdown.trim()) {
    return { error: "The document is empty, so there was nothing to publish." };
  }
  const notSignedIn = await twgSignInProblem(deps, "the page");
  if (notSignedIn) {
    return { error: notSignedIn };
  }
  const title = pageTitle(doc);
  // The body goes through a file in this private directory rather than an argument: a document can be larger than one
  // argument may be, and nothing in it is ever read as part of a command either way.
  const bodyFile = path.join(dir, `${request.exportId}.md`);
  fs.writeFileSync(bodyFile, pageBody(doc.markdown, title), { mode: 0o600 });
  try {
    const attempt = (withTitle: string) =>
      deps.run(
        "twg",
        [
          "confluence",
          "content",
          "create",
          `--space-id=${request.spaceId}`,
          `--parent-id=${request.parentId}`,
          "--content-type=page",
          `--title=${withTitle}`,
          `--body-file=${bodyFile}`,
          "--format=md",
          "--ack-body-formats",
          "-y",
          "--output=json",
          "--output-summary=none"
        ],
        { env: deps.env, timeoutMs: CREATE_TIMEOUT_MS }
      );
    let used = title;
    let result = await attempt(used);
    if (result.code !== 0 && TITLE_TAKEN_RE.test(`${result.stdout}\n${result.stderr}`)) {
      used = datedTitle(title, (deps.today ?? (() => new Date()))());
      result = await attempt(used);
    }
    if (result.code !== 0) {
      return { error: confluenceFailure(result) };
    }
    const pageId = parseCreatedPageId(result.stdout, [request.spaceId, request.parentId]);
    return pageId
      ? { pageId, title: used, again: false }
      : { error: "twg answered without a page id, so the page may or may not exist. Check Confluence before publishing again." };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/**
 * Creates the page for one export, once, and reports the outcome to the hub. A page already created for this export
 * id is reported again instead. Throws only when the hub cannot be told, so the session can run it again.
 */
export async function runConfluenceExport(deps: ConfluenceExportDeps, request: ConfluenceExportRequest): Promise<ConfluenceExportOutcome> {
  const dir = deps.dir ?? confluenceExportsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let outcome: ConfluenceExportOutcome;
  const known = remembered(dir, request.exportId);
  if (known) {
    outcome = { ...known, again: true };
  } else {
    if (!claimExport(dir, request.exportId)) {
      throw new Error(`export ${request.exportId} is already running in another command; wait for that one rather than starting another`);
    }
    try {
      outcome = await create(deps, request, dir);
      if ("pageId" in outcome) {
        writeJson(path.join(dir, `${request.exportId}.json`), { page_id: outcome.pageId, title: outcome.title, created_at: new Date().toISOString() });
      }
    } finally {
      releaseExport(dir, request.exportId);
    }
  }
  const report: ConfluenceExportReport =
    "pageId" in outcome
      ? { export_id: request.exportId, page_id: outcome.pageId, title: outcome.title }
      : { export_id: request.exportId, error: outcome.error };
  await withRetry(() => deps.api.putConfluenceExport(deps.agentId, report), { attempts: 3 });
  return outcome;
}
