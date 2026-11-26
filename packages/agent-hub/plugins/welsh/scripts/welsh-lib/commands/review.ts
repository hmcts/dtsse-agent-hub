/**
 * review: settle the catalogue's needs-review rows, once the Welsh Language Unit has said which Welsh is right.
 *
 *   review --service X                         list each English with Welsh to review, and its renderings
 *   review --service X --approve ROW-ID...     approve those rows, committed on a branch of the home repo
 *   review --service X --approve ROW-ID... --pr  the same, then a draft PR in the home repo
 *
 * Approving a row makes it the one used for its English and context: every other rendering of the same English in the
 * same context, approved or awaiting review, is marked superseded. welsh/needs-review.md is rebuilt to match. What is
 * not approved is left as it is, for later.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { cataloguePath, loadCatalogue, type Row } from "../catalogue.ts";
import { manifestUrl } from "../clones.ts";
import { branchName, HOME_OVERRIDE, homeRepo, inHome } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import { matchKey } from "../normalise.ts";
import { REVIEW_FILE, reviewMarkdown } from "../review.ts";
import { openPrTitled } from "./setup.ts";

/** How every review pull request's title starts, so one still open can be found. */
export const REVIEW_TITLE = (service: string) => `Welsh catalogue: ${service} approves`;

/**
 * A review pull request still open in the service's home repo, or null. Until it is merged the catalogue on the
 * default branch still has those rows waiting, so they are listed again, and approving them again would open a second
 * pull request that conflicts with the first.
 */
export function openReviewPr(service: string): string | null {
  const home = homeRepo(service);
  const url = home === null ? null : manifestUrl(home);
  return url === null ? null : openPrTitled(REVIEW_TITLE(service), [url]);
}

/** How many English strings a list gives, for the Welsh page to show; the count is always the full one. */
export const REVIEW_LIST_LIMIT = 300;

/** One English, in one context, with Welsh to review: every rendering it has, the approved one too if there is one. */
export interface ReviewGroup {
  english: string;
  context: string;
  why: string[];
  options: { id: string; welsh: string; status: string; source: string; received: string }[];
}

const groupKey = (row: Pick<Row, "english" | "context">) => `${matchKey(row.english)}\u0000${row.context.trim()}`;

export function reviewGroups(rows: readonly Row[]): ReviewGroup[] {
  const waiting = new Set(rows.filter((r) => r.status === "needs-review").map(groupKey));
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupKey(row);
    if (waiting.has(key) && row.status !== "superseded") {
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      english: group[0]?.english ?? "",
      context: group[0]?.context ?? "",
      why: [...new Set(group.filter((r) => r.status === "needs-review").map((r) => r.notes.trim()))].filter(Boolean),
      options: group.map((r) => ({ id: r.id, welsh: r.welsh, status: r.status, source: r.source, received: r.received }))
    }))
    .sort((a, b) => (a.english < b.english ? -1 : a.english > b.english ? 1 : 0));
}

/**
 * Approves each row named, superseding the other renderings of its English in its context. The row may be one awaiting
 * review, or the one already approved when the Welsh Language Unit says that is still right. Refuses a row whose
 * English has nothing awaiting review, and two rows for the same English, rather than guess which was meant.
 */
export function approve(rows: Row[], ids: readonly string[]): { approved: Row[]; superseded: Row[] } {
  const waiting = new Set(rows.filter((r) => r.status === "needs-review").map(groupKey));
  const chosen = ids.map((id) => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) {
      fail(`no catalogue row ${id}`);
    }
    if (row.status === "superseded" || !waiting.has(groupKey(row))) {
      fail(`row ${id} ("${row.english}") has nothing waiting for review`);
    }
    return row;
  });
  const keys = chosen.map(groupKey);
  if (new Set(keys).size !== keys.length) {
    fail("approve one Welsh for each English: two of those rows are for the same English");
  }
  const superseded: Row[] = [];
  for (const row of chosen) {
    for (const other of rows) {
      if (other !== row && groupKey(other) === groupKey(row) && other.status !== "superseded") {
        other.status = "superseded";
        superseded.push(other);
      }
    }
    row.status = "approved";
    row.notes = "";
  }
  return { approved: chosen, superseded };
}

export async function reviewCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { service: { type: "string" }, approve: { type: "string", multiple: true }, pr: { type: "boolean" } }
  });
  const service = requireService(values.service);
  const ids = [...new Set(values.approve ?? [])];
  const cat = loadCatalogue(service);

  if (ids.length === 0) {
    const groups = reviewGroups(cat.rows);
    const openPr = openReviewPr(service);
    say(`${groups.length} English string(s) in ${service}'s catalogue have Welsh to review.${openPr ? ` A review is waiting to be merged: ${openPr}` : ""}`);
    return { service, total: groups.length, groups: groups.slice(0, REVIEW_LIST_LIMIT), openPr };
  }

  if (!process.env[HOME_OVERRIDE]) {
    // Checked here first, against the catalogue as it is, so a mistake is said before a worktree is made.
    approve(structuredClone(cat.rows), ids);
    const open = openReviewPr(service);
    if (open !== null) {
      fail(`a review of ${service}'s Welsh is waiting to be merged: ${open}. Approve more once it is merged, or add to that pull request`);
    }
    return reviewInHome(service, ids, Boolean(values.pr));
  }
  const done = approve(cat.rows, ids);
  cat.save();
  writeFileSync(join(dirname(cataloguePath(service)), REVIEW_FILE), reviewMarkdown(cat));
  const left = reviewGroups(cat.rows).length;
  say(`${done.approved.length} approved, ${done.superseded.length} superseded; ${left} English string(s) still to review.`);
  return {
    service,
    approved: done.approved.map((r) => ({ id: r.id, english: r.english, welsh: r.welsh })),
    superseded: done.superseded.length,
    left
  };
}

interface Reviewed {
  approved: { id: string; english: string; welsh: string }[];
  superseded: number;
  left: number;
}

function reviewInHome(service: string, ids: string[], pr: boolean): unknown {
  const done = inHome<Reviewed>(
    service,
    ["review", "--service", service, ...ids.flatMap((id) => ["--approve", id])],
    { branch: branchName(`${service}-review`), pr },
    (r) => ({
      message: `Approve ${r.approved.length} Welsh translation(s) in ${service}'s catalogue\n\n${r.superseded} other rendering(s) superseded; ${r.left} still to review.`,
      title: `${REVIEW_TITLE(service)} ${r.approved.length} translation(s) after review`,
      body:
        "A BA settled these with the Welsh Language Unit on the Welsh page. Each is now the Welsh used for its English, and every other rendering of the same English is `superseded`:\n\n" +
        "| English | Approved Welsh | Row |\n|---|---|---|\n" +
        r.approved.map((a) => `| ${cell(a.english)} | ${cell(a.welsh)} | \`${a.id}\` |`).join("\n") +
        `\n\n\`welsh/needs-review.md\` is rebuilt: ${r.left} English string(s) are still to review.`
    })
  );
  say(done.pr ? `Draft PR: ${done.pr}` : done.branch ? `Committed on ${done.branch} in ${homeRepo(service)}.` : "Nothing changed.");
  return { ...done.result, branch: done.branch, pr: done.pr };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
