/**
 * What the Welsh page shows of a job's result. Pure. The result is whatever cft-workspace's `scripts/welsh` printed,
 * which is released separately from this app, so every field is read defensively: a missing or mistyped one shows as
 * nothing rather than breaking the page. Welsh is only ever displayed here, exactly as the result carries it.
 */

type Json = Record<string, unknown>;

const rec = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(rec) : []);
const nullable = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export interface WelshInfo {
  initialised: boolean;
  repos: string[];
  /** Whether any repo marks pages as staff-only, which scans skip. */
  skipsStaffPages: boolean;
  approved: number;
  needsReview: number;
  sharedApproved: number;
}

export function infoView(result: Json): WelshInfo {
  const catalogue = rec(result.catalogue);
  return {
    initialised: result.initialised === true,
    repos: list(result.repos)
      .map((r) => str(r.path))
      .filter(Boolean),
    skipsStaffPages: list(result.repos).some((r) => Array.isArray(r.staffOnly) && r.staffOnly.length > 0),
    approved: num(catalogue.approved),
    needsReview: num(catalogue.needsReview),
    sharedApproved: num(rec(result.shared).approved)
  };
}

export interface CatalogueHit {
  id: string;
  english: string;
  welsh: string;
  context: string;
  status: string;
  source: string;
  catalogue: string;
}

export function searchView(result: Json): { total: number; hits: CatalogueHit[] } {
  return {
    total: num(result.total),
    hits: list(result.hits).map((h) => ({
      id: str(h.id),
      english: str(h.english),
      welsh: str(h.welsh),
      context: str(h.context),
      status: str(h.status),
      source: str(h.source),
      catalogue: str(h.catalogue)
    }))
  };
}

export interface CatalogueOption {
  id: string;
  welsh: string;
  context: string;
  source: string;
}

export interface Ambiguous {
  ref: string;
  english: string;
  where: string;
  options: CatalogueOption[];
}

const options = (v: unknown): CatalogueOption[] => list(v).map((o) => ({ id: str(o.id), welsh: str(o.welsh), context: str(o.context), source: str(o.source) }));

export interface ScanView {
  places: number;
  unique: number;
  fromCatalogue: number;
  ambiguousCount: number;
  toWluCount: number;
  ambiguous: Ambiguous[];
  toWlu: { ref: string; english: string; where: string }[];
  filled: { ref: string; english: string; welsh: string; where: string }[];
}

export function scanView(result: Json): ScanView {
  const summary = rec(result.summary);
  return {
    places: num(summary.total),
    unique: num(summary.unique),
    fromCatalogue: num(summary.fromCatalogue),
    ambiguousCount: num(summary.ambiguous),
    toWluCount: num(summary.toWlu),
    ambiguous: list(result.ambiguous).map((a) => ({ ref: str(a.ref), english: str(a.english), where: str(a.where), options: options(a.options) })),
    toWlu: list(result.toWlu).map((t) => ({ ref: str(t.ref), english: str(t.english), where: str(t.where) })),
    filled: list(result.fromCatalogue).map((f) => ({ ref: str(f.ref), english: str(f.english), welsh: str(f.welsh), where: str(f.where) }))
  };
}

export interface ImportView {
  added: number;
  superseded: number;
  unchanged: number;
  conflicting: number;
  blank: number;
  problems: { row: number; ref: string; english: string; problem: string }[];
  pr: string | null;
}

export function importView(result: Json): ImportView {
  return {
    added: num(result.added),
    superseded: num(result.superseded),
    unchanged: num(result.unchanged),
    conflicting: num(result.conflicting),
    blank: num(result.blank),
    problems: list(result.problems).map((p) => ({ row: num(p.row), ref: str(p.ref), english: str(p.english), problem: str(p.problem) })),
    pr: nullable(result.pr)
  };
}

export interface Change {
  page: string;
  english: string;
  /** What the Welsh side shows today: the English, a placeholder, nothing. */
  now: string;
  welsh: string;
  /** Where the Welsh came from, in words: the catalogue, a Welsh unit return, or the person's choice. */
  from: string;
}

export interface ApplyView {
  applied: number;
  /** Each change, grouped by page in the order they come. */
  pages: { page: string; changes: Change[] }[];
  files: string[];
  skipped: { where: string; english: string; reason: string }[];
  pr: string | null;
  branch: string | null;
  diff: string;
  verified: boolean;
}

export function applyView(result: Json): ApplyView {
  return {
    applied: num(result.applied),
    pages: groupByPage(
      list(result.changes).map((c) => ({ page: str(c.page), english: str(c.english), now: str(c.now), welsh: str(c.welsh), from: fromOf(str(c.source)) }))
    ),
    files: Array.isArray(result.files) ? result.files.filter((f): f is string => typeof f === "string") : [],
    skipped: list(result.skipped).map((s) => ({ where: str(s.where), english: str(s.english), reason: str(s.reason) })),
    pr: nullable(result.pr),
    branch: nullable(result.branch),
    diff: str(result.diff),
    verified: rec(result.verify).ok === true
  };
}

function fromOf(source: string): string {
  if (source.includes("BA choice")) {
    return "Your choice";
  }
  if (source.startsWith("WLU:")) {
    return "Welsh unit return";
  }
  return source.includes("catalogue:shared") ? "Shared catalogue" : "Catalogue";
}

/** The same English on one page appears once per place it is used; a BA checks the words, so it is shown once. */
function groupByPage(changes: Change[]): { page: string; changes: Change[] }[] {
  const pages = new Map<string, Change[]>();
  for (const change of changes) {
    const list = pages.get(change.page) ?? [];
    if (!list.some((c) => c.english === change.english && c.welsh === change.welsh)) {
      list.push(change);
    }
    pages.set(change.page, list);
  }
  return [...pages].map(([page, list]) => ({ page, changes: list }));
}

export interface StoryCandidates {
  title: string;
  url: string;
  candidates: { english: string; origin: string }[];
  existing: { ref: string; english: string; welsh: string }[];
}

export function storyCandidatesView(result: Json): StoryCandidates {
  return {
    title: str(result.summary),
    url: str(result.url),
    candidates: list(result.candidates)
      .map((c) => ({ english: str(c.english), origin: str(c.origin) }))
      .filter((c) => c.english !== ""),
    existing: list(result.existing).map((e) => ({ ref: str(e.ref), english: str(e.english), welsh: str(e.welsh) }))
  };
}

export type StoryRowState = "filled" | "required" | "ambiguous" | "hand-edited";

export interface StoryRow {
  ref: string;
  english: string;
  welsh: string;
  source: string;
  state: StoryRowState;
  options: CatalogueOption[];
}

const STATES: readonly StoryRowState[] = ["filled", "required", "ambiguous", "hand-edited"];

export function storyPreviewView(result: Json): { rows: StoryRow[]; verified: boolean; failures: string[] } {
  const verify = rec(result.verify);
  return {
    rows: list(result.rows).map((r) => {
      const state = str(r.state) as StoryRowState;
      return {
        ref: str(r.ref),
        english: str(r.english),
        welsh: str(r.welsh),
        source: str(r.source),
        state: STATES.includes(state) ? state : "required",
        options: options(r.options)
      };
    }),
    verified: verify.ok === true,
    failures: list(verify.failures).map((f) => `"${str(f.english)}": ${str(f.reason)}`)
  };
}

export function storyWriteView(result: Json): { url: string; required: number } {
  return { url: str(result.url), required: num(rec(result.counts).required) };
}

/** What the script said to a person at a terminal, which the page shows under the figures. */
export function messageOf(result: Json): string {
  return str(result.message);
}

/** Only https links to GitHub or the HMCTS Atlassian site are shown as links; anything else is shown as text. */
export function safeLink(url: string | null): string | null {
  return url !== null && /^https:\/\/(github\.com|hmcts\.atlassian\.net)\//.test(url) ? url : null;
}
