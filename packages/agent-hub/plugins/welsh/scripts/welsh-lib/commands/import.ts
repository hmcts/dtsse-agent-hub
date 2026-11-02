/**
 * import: add a Welsh Language Unit return to the service catalogue.
 *
 *   import <returned.xlsx> --service X              check, add, report
 *   import <returned.xlsx> --service X --dry-run    check and report only
 *   import <returned.xlsx> --service X --pr         the same in a fresh worktree, then a draft workspace PR
 *   ... --queries-out <file.xlsx>                   where to write the queries spreadsheet
 *
 * With --pr the import runs against a temporary worktree of cft-workspace off
 * its default branch, never the checkout it was started from: in an HMCTS
 * Assistant pod that checkout is shared by every chat and must stay on its
 * default branch. The catalogue changes reach everyone through the PR.
 *
 * Rows that fail a check are written to a queries spreadsheet for the WLU.
 * Welsh that disagrees with an approved catalogue row is added as
 * needs-review rather than replacing it.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCatalogue } from "../catalogue.ts";
import { tempWorktree } from "../clones.ts";
import { COMMIT_TRAILER, commit, draftPr, PR_FOOTER } from "../git.ts";
import { fail, requireService, say } from "../io.ts";
import { WORKSPACE } from "../paths.ts";
import { welshDir } from "../requests.ts";
import { readReturn } from "../returns.ts";
import { writeRequest } from "../xlsx.ts";

export async function importCmd(argv: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { service: { type: "string" }, "dry-run": { type: "boolean" }, pr: { type: "boolean" }, "queries-out": { type: "string" } }
  });
  const file = positionals[0] && resolve(positionals[0]);
  if (!file || !existsSync(file)) {
    fail("give the returned .xlsx file");
  }
  const service = requireService(values.service);
  const batch = basename(file).replace(/\.xlsx$/i, "");
  if (values.pr && !values["dry-run"]) {
    return importWithPr(service, file, batch, values["queries-out"]);
  }
  const check = await readReturn(service, file);

  const cat = loadCatalogue(service);
  const outcome = { added: 0, unchanged: 0, superseded: 0, conflicting: 0 };
  const conflicts: { ref: string; english: string; welsh: string; catalogue: string[] }[] = [];
  for (const r of check.valid) {
    const approved = cat.approved(r.english).filter((x) => x.context === "");
    if (approved.length && !approved.some((x) => x.welsh === r.welsh)) {
      conflicts.push({ ref: r.ref, english: r.english, welsh: r.welsh, catalogue: approved.map((x) => x.welsh) });
      cat.add({
        english: r.english,
        welsh: r.welsh,
        source: `WLU:${batch}`,
        notes: `Differs from approved row(s) — BA to confirm with WLU (${r.ref})`,
        status: "needs-review"
      });
      outcome.conflicting++;
      continue;
    }
    const res = cat.add({ english: r.english, welsh: r.welsh, source: `WLU:${batch}`, notes: r.ref });
    if (res === "unchanged") {
      outcome.unchanged++;
    } else if (res === "superseded-previous") {
      outcome.superseded++;
    } else {
      outcome.added++;
    }
  }

  const dir = welshDir(service);
  const kept = join(dir, "returns", basename(file));
  let queries: string | null = null;
  if (!values["dry-run"]) {
    // Keep the return first: a catalogue row should never exist without the file it came from.
    mkdirSync(dirname(kept), { recursive: true });
    if (resolve(kept) !== file) {
      copyFileSync(file, kept);
    }
    cat.save();
    if (check.problems.length) {
      queries = values["queries-out"] ? resolve(values["queries-out"]) : join(dir, "returns", `${batch}-queries.xlsx`);
      mkdirSync(dirname(queries), { recursive: true });
      await writeRequest(
        queries,
        check.problems.map((p) => ({ ref: p.ref, english: p.english, welsh: p.welsh, context: `Row ${p.row} of ${basename(file)}`, notes: p.problem })),
        { batch: `${batch}-queries`, service, created: new Date().toISOString().slice(0, 10) }
      );
    }
  }

  say(
    `${basename(file)}: ${check.valid.length} usable row(s) — ${outcome.added} added, ${outcome.superseded} replaced an older rendering, ` +
      `${outcome.unchanged} already in the catalogue, ${outcome.conflicting} differ from the catalogue (added as needs-review).\n` +
      `${check.blank.length} row(s) left blank by the WLU; ${check.problems.length} row(s) with problems.` +
      (check.problems.length ? `\n${check.problems.map((p) => `  row ${p.row} ${p.ref}: ${p.problem}`).join("\n")}` : "") +
      (queries ? `\nQueries for the WLU: ${queries}` : "") +
      (values["dry-run"] ? "\nDry run — nothing saved." : "")
  );
  return {
    service,
    file,
    batch,
    dryRun: Boolean(values["dry-run"]),
    ...outcome,
    blank: check.blank.length,
    problems: check.problems,
    conflicts,
    queries,
    pr: null
  };
}

/** The import, run by this same CLI against a fresh worktree, then committed there and opened as a draft PR. */
function importWithPr(service: string, file: string, batch: string, queriesOut: string | undefined): unknown {
  const branch = `welsh/${service}-${batch}`.toLowerCase().replace(/[^a-z0-9/._-]+/g, "-");
  const wt = tempWorktree(WORKSPACE, branch);
  let keep = false;
  try {
    const queries = queriesOut ? resolve(queriesOut) : join(mkdtempSync(join(tmpdir(), "welsh-q-")), `${batch}-queries.xlsx`);
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], "import", file, "--service", service, "--queries-out", queries], {
      encoding: "utf8",
      env: { ...process.env, CFT_WELSH_WORKSPACE: wt.dir },
      maxBuffer: 64 * 1024 * 1024
    });
    process.stderr.write(child.stderr);
    if (child.status !== 0) {
      throw new Error(`import failed in the worktree (exit ${child.status})`);
    }
    const result = JSON.parse(child.stdout) as ImportResult;
    let pr: string | null = null;
    if (result.added + result.superseded + result.conflicting > 0) {
      const summary = `${result.added} added, ${result.superseded} replaced, ${result.conflicting} needs-review`;
      const where = `apps/${service}/welsh`;
      commit(wt.dir, [where], `Add Welsh Language Unit return ${batch} to the ${service} catalogue\n\n${summary}.${COMMIT_TRAILER}`);
      pr = draftPr(
        wt.dir,
        `Welsh catalogue: ${service} ← ${batch}`,
        `Adds the Welsh Language Unit return \`${batch}\` to \`${where}/catalogue.csv\`: ${summary}.\n\n` +
          "Every row was checked before it was added: its Ref matches its English, the Welsh is not blank or a placeholder, and its placeholders match the English. " +
          "Rows that differ from an existing approved rendering are `needs-review` and are not used until a BA approves one." +
          PR_FOOTER
      );
      keep = true;
      say(`Draft PR: ${pr}`);
    } else {
      say("Nothing new for the catalogue, so no PR.");
    }
    return { ...result, queries: result.queries ? queries : null, pr };
  } finally {
    wt.remove(keep);
  }
}

interface ImportResult {
  added: number;
  superseded: number;
  conflicting: number;
  queries: string | null;
}
