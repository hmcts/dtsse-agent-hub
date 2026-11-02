/**
 * import: add a Welsh Language Unit return to the service catalogue.
 *
 *   import <returned.xlsx> --service X --dry-run    check and report only
 *   import <returned.xlsx> --service X              add it, committed on a branch of the home repo
 *   import <returned.xlsx> --service X --pr         the same, then a draft PR in the home repo
 *   ... --queries-out <file.xlsx>                   where to write the queries spreadsheet
 *
 * The catalogue is in the service's home repo (home.ts), so an import runs
 * against a temporary worktree of it off its default branch, never a checkout
 * someone is using, and the return itself goes into welsh/returns/ beside it
 * as the record of where those rows came from.
 *
 * Rows that fail a check are written to a queries spreadsheet for the WLU.
 * Welsh that disagrees with an approved catalogue row is added as
 * needs-review rather than replacing it.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCatalogue } from "../catalogue.ts";
import { branchName, HOME_OVERRIDE, homeRepo, inHome, welshDir } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import { readReturn } from "../returns.ts";
import { REVIEW_FILE, reviewMarkdown } from "../review.ts";
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
  if (!values["dry-run"] && !process.env[HOME_OVERRIDE]) {
    return importInHome(service, file, batch, values["queries-out"], Boolean(values.pr));
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
    writeFileSync(join(dir, REVIEW_FILE), reviewMarkdown(cat));
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

/** The import, run by this same CLI in a worktree of the home repo, committed there, and opened as a draft PR with --pr. */
function importInHome(service: string, file: string, batch: string, queriesOut: string | undefined, pr: boolean): unknown {
  const queries = queriesOut ? resolve(queriesOut) : join(mkdtempSync(join(tmpdir(), "welsh-q-")), `${batch}-queries.xlsx`);
  const where = `${homeRepo(service)}/welsh`;
  const done = inHome<ImportResult>(
    service,
    ["import", file, "--service", service, "--queries-out", queries],
    { branch: branchName(`${service}-${batch}`), pr },
    (result) => {
      const summary = `${result.added} added, ${result.superseded} replaced, ${result.conflicting} needs-review`;
      return {
        message: `Add Welsh Language Unit return ${batch} to the ${service} catalogue\n\n${summary}.`,
        title: `Welsh catalogue: ${service} ← ${batch}`,
        body:
          `Adds the Welsh Language Unit return \`${batch}\` to \`welsh/catalogue.csv\`: ${summary}. The return itself is in \`welsh/returns/\`.\n\n` +
          "Every row was checked before it was added: its Ref matches its English, the Welsh is not blank or a placeholder, and its placeholders match the English. " +
          "Rows that differ from an existing approved rendering are `needs-review` and are not used until a BA approves one."
      };
    }
  );
  if (done.pr) {
    say(`Draft PR: ${done.pr}`);
  } else if (done.branch) {
    say(`Committed on ${done.branch} in ${where}; run again with --pr to open a draft PR.`);
  } else {
    say("Nothing new for the catalogue, so nothing was committed.");
  }
  return { ...done.result, queries: done.result.queries ? queries : null, branch: done.branch, pr: done.pr };
}

interface ImportResult {
  added: number;
  superseded: number;
  conflicting: number;
  queries: string | null;
}
