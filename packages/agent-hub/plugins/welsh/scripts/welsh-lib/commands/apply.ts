/**
 * apply: write Welsh into a service clone, on a branch, ready for review.
 *
 *   apply --service X --from catalogue           every scan finding the catalogue answers
 *   apply --service X --from <returned.xlsx>     the rows of a WLU return
 *   ... --repo <clone>  --choose REF=ROW-ID  --dry-run  --test  --pr
 *
 * Works in a temporary worktree off the remote default branch, so the clone
 * itself — someone's working copy, or a pod's shared checkout — is never
 * touched; a clone the workspace does not have yet is cloned first. Every
 * value passes the token check and `verify` before it is written; --dry-run
 * shows the diff and throws the worktree away.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Edit } from "../adapters/types.ts";
import { loadCatalogue, type Row } from "../catalogue.ts";
import { ensureClone, tempWorktree, type Worktree } from "../clones.ts";
import { loadConfig, type RepoConfig } from "../config.ts";
import { COMMIT_TRAILER, commit, draftPr, git, PR_FOOTER } from "../git.ts";
import { branchName } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import { workspace } from "../paths.ts";
import { readReturn } from "../returns.ts";
import { ADAPTERS, type Finding, scanRepo } from "../scan.ts";
import { tokenProblems } from "../tokens.ts";
import { type Pair, verify } from "../verify.ts";
import { resolveRepos } from "./scan.ts";

export async function applyCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      repo: { type: "string" },
      from: { type: "string" },
      choose: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      test: { type: "boolean" },
      pr: { type: "boolean" }
    }
  });
  const service = requireService(values.service);
  if (!values.from) {
    fail("--from catalogue or --from <returned.xlsx> is required");
  }
  const repos = resolveRepos(service, values.repo, undefined);
  if (repos.length > 1 && !values["dry-run"]) {
    fail(`${service}'s welsh/config.yaml lists ${repos.length} repos — pick one with --repo`);
  }
  const repo = repos[0];
  const clone = isAbsolute(repo.path) || repo.path.startsWith("..") ? resolve(workspace(), repo.path) : ensureClone(repo.path);
  const batch = values.from === "catalogue" ? `catalogue-${new Date().toISOString().slice(0, 10)}` : basename(resolve(values.from)).replace(/\.xlsx$/i, "");
  const branch = values["dry-run"] ? `welsh-dry-run/${process.pid}-${Date.now()}` : branchName(batch);
  const wt = tempWorktree(clone, branch);
  let keep = false;
  try {
    const result = await applyIn(wt, service, repo, values, batch, branch);
    keep = Boolean(result.commit);
    return result;
  } finally {
    wt.remove(keep);
  }
}

async function applyIn(wt: Worktree, service: string, repo: RepoConfig, values: ApplyOptions, batch: string, branch: string) {
  const abs = wt.dir;
  const catalogue = loadCatalogue(service);
  const config = loadConfig(service);
  const findings = scanRepo(service, abs, repo, config, catalogue);

  // What Welsh is on offer, by Ref.
  const offered = new Map<string, { welsh: string; source: string }>();
  let returnPairs: Pair[] = [];
  if (values.from === "catalogue") {
    for (const f of findings) {
      if (f.match.kind === "hit") {
        offered.set(f.ref, { welsh: f.match.welsh, source: `catalogue:${f.match.catalogue} ${f.match.row.source}` });
      }
    }
  } else {
    const file = resolve(values.from as string);
    if (!existsSync(file)) {
      fail(`${values.from} does not exist`);
    }
    const check = await readReturn(service, file);
    if (check.problems.length) {
      say(`${check.problems.length} row(s) of the return have problems and are skipped — run welsh import for details.`);
    }
    for (const r of check.valid) {
      offered.set(r.ref, { welsh: r.welsh, source: `WLU:${batch}` });
    }
    returnPairs = check.valid;
  }
  for (const [ref, row] of parseChoices(values.choose ?? [], catalogue.rows)) {
    offered.set(ref, { welsh: row.welsh, source: `${row.source} (BA choice, row ${row.id})` });
  }

  const edits: Applied[] = [];
  const skipped: { where: string; english: string; reason: string }[] = [];
  for (const f of findings) {
    const offer = offered.get(f.ref);
    if (!offer) {
      continue;
    }
    const where = `${f.cyFile}:${f.key}`;
    if (f.readOnly) {
      skipped.push({ where, english: f.english, reason: f.readOnly });
    } else if (tokenProblems(f.english, offer.welsh).length) {
      skipped.push({ where, english: f.english, reason: `placeholders: ${tokenProblems(f.english, offer.welsh).join("; ")}` });
    } else {
      edits.push({ leaf: f, welsh: offer.welsh, source: offer.source });
    }
  }
  if (!edits.length) {
    say(`Nothing to apply in ${repo.path}.${skipped.length ? ` ${skipped.length} skipped:\n${fmtSkipped(skipped)}` : ""}`);
    return { service, repo: repo.path, applied: 0, skipped, commit: null };
  }

  const check = verify(
    edits.map((e) => ({ english: e.leaf.english, welsh: e.welsh, where: e.leaf.cyFile })),
    catalogue,
    returnPairs
  );
  if (!check.ok) {
    fail(`verify refused ${check.failures.length} value(s):\n${check.failures.map((x) => `  ${x.where}: ${x.reason}`).join("\n")}`);
  }

  const changed = writeAll(abs, edits);
  const diff = git(abs, ["diff", "--stat"]);

  if (values["dry-run"]) {
    const full = git(abs, ["diff"]);
    say(`Dry run — ${edits.length} value(s) in ${changed.length} file(s); nothing kept.\n\n${full}`);
    return {
      service,
      repo: repo.path,
      dryRun: true,
      applied: edits.length,
      files: changed,
      skipped,
      verify: check,
      diff: full,
      changes: changeList(edits),
      commit: null
    };
  }

  let tests: { command: string; ok: boolean; output: string } | null = null;
  if (values.test && repo.test) {
    const res = spawnSync("bash", ["-lc", repo.test], { cwd: abs, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    tests = { command: repo.test, ok: res.status === 0, output: `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-40).join("\n") };
    if (!tests.ok) {
      say(`Tests failed, so nothing was committed:\n${tests.output}`);
    }
  }

  let sha: string | null = null;
  let pr: string | null = null;
  if (!tests || tests.ok) {
    sha = commit(
      abs,
      changed,
      `Add Welsh translations from ${batch}\n\n${edits.length} value(s) from ${values.from === "catalogue" ? "the approved catalogue" : "the Welsh Language Unit"}.${COMMIT_TRAILER}`
    );
    if (values.pr) {
      pr = draftPr(abs, `Welsh translations: ${batch}`, prBody(service, batch, edits, skipped));
    }
  }

  say(
    `${edits.length} Welsh value(s) written to ${changed.length} file(s) on ${branch} (from origin/${wt.base}).\n${diff}` +
      (skipped.length ? `\n${skipped.length} skipped:\n${fmtSkipped(skipped)}` : "") +
      (pr ? `\nDraft PR: ${pr}` : sha ? `\nCommitted ${sha} on ${branch}. Open the PR with --pr, or push the branch yourself.` : "")
  );
  return {
    service,
    repo: repo.path,
    branch,
    commit: sha,
    pr,
    applied: edits.length,
    files: changed,
    skipped,
    tests,
    verify: check,
    changes: changeList(edits)
  };
}

/**
 * Each value written, in words a BA can check: the page or list it is on, the English, what the Welsh side shows now,
 * and the Welsh it gets. Capped, as the result is shown on a page; `applied` is the full count.
 */
function changeList(edits: Applied[]): Change[] {
  const NOW: Record<string, string> = {
    identical: "Shows the English",
    marker: "Marked as needing Welsh",
    placeholder: "Placeholder text",
    empty: "Blank",
    "missing-key": "Missing",
    "missing-file": "Missing"
  };
  return edits.slice(0, 500).map((e) => ({
    ref: e.leaf.ref,
    page: pageOf(e.leaf.cyFile),
    file: e.leaf.cyFile,
    key: e.leaf.key,
    english: e.leaf.english,
    now: NOW[e.leaf.signal] ?? e.leaf.signal,
    welsh: e.welsh,
    source: e.source
  }));
}

/** A locale file's page or list, from its folder: `…/pages/(public)/summary-of-publications/cy.ts` is "summary of publications". */
export function pageOf(file: string): string {
  const parts = file
    .split("/")
    .slice(0, -1)
    .filter(
      (p) =>
        !/^\(.*\)$/.test(p) && !["src", "locales", "pages", "apps", "web", "libs", "list-types", "translation", "resources", "main", "en", "cy"].includes(p)
    );
  const name = parts.at(-1) ?? file;
  return name.replace(/[-_]+/g, " ");
}

interface Change {
  ref: string;
  page: string;
  file: string;
  key: string;
  english: string;
  now: string;
  welsh: string;
  source: string;
}

function writeAll(repo: string, edits: Edit[]): string[] {
  const changed = new Set<string>();
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    const mine = edits.filter((e) => e.leaf.adapter === name);
    if (mine.length) {
      for (const f of adapter.write(repo, mine)) {
        changed.add(f);
      }
    }
  }
  return [...changed];
}

function parseChoices(raw: string[], rows: Row[]): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const pair of raw) {
    const [ref, id] = pair.split("=");
    const row = rows.find((r) => r.id === id && r.status === "approved");
    if (!ref || !row) {
      fail(`--choose ${pair}: no approved catalogue row ${id}`);
    }
    out.set(ref, row);
  }
  return out;
}

function fmtSkipped(skipped: { where: string; reason: string }[]): string {
  return skipped.map((s) => `  ${s.where}: ${s.reason}`).join("\n");
}

function prBody(service: string, batch: string, edits: Applied[], skipped: { where: string; english: string; reason: string }[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const rows = edits.map(
    (e) => `| ${e.leaf.ref} | \`${cell(e.leaf.cyFile)}\` \`${cell(e.leaf.key)}\` | ${cell(e.leaf.english)} | ${cell(e.welsh)} | ${cell(e.source)} |`
  );
  return (
    `Welsh translations for **${service}** from \`${batch}\`.\n\n` +
    "Every Welsh value below was supplied by the Welsh Language Unit, either in this batch or earlier via the service's approved " +
    "catalogue, `welsh/catalogue.csv` in its home repo. None was machine-translated. Each passed a placeholder check against its English and the " +
    "`welsh verify` provenance check.\n\n" +
    "| Ref | Where | English | Welsh | Source |\n|---|---|---|---|---|\n" +
    rows.join("\n") +
    (skipped.length ? `\n\n**Not applied** (needs a developer):\n${skipped.map((s) => `- \`${s.where}\`: ${s.reason}`).join("\n")}` : "") +
    PR_FOOTER
  );
}

interface Applied extends Edit {
  leaf: Finding;
  source: string;
}

interface ApplyOptions {
  from?: string;
  choose?: string[];
  "dry-run"?: boolean;
  test?: boolean;
  pr?: boolean;
}
