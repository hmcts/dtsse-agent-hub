/**
 * keep-english: record English that is right as it stands on a Welsh page (an address, a system's name, a cookie's
 * name) in the service's `identical_allowlist`, so a scan stops asking about it.
 *
 *   keep-english --service X --dry-run -- <english>...   say what would be added
 *   keep-english --service X -- <english>...             add it, committed on a branch of the home repo
 *   keep-english --service X --pr -- <english>...        the same, then a draft PR in the home repo
 *
 * Only a BA adds to the list, from what they left out of a Welsh Language Unit spreadsheet. The list is in
 * welsh/config.yaml, which keeps its comments.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { branchName, HOME_OVERRIDE, homeRepo, inHome, welshDir } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import { matchKey } from "../normalise.ts";

export async function keepEnglishCmd(argv: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { service: { type: "string" }, "dry-run": { type: "boolean" }, pr: { type: "boolean" } }
  });
  const service = requireService(values.service);
  const strings = unique(positionals.map((s) => s.trim()).filter(Boolean));
  if (strings.length === 0) {
    fail("give the English to keep, after --");
  }
  if (!values["dry-run"] && !process.env[HOME_OVERRIDE]) {
    return keepInHome(service, strings, Boolean(values.pr));
  }
  const path = join(welshDir(service), "config.yaml");
  if (!existsSync(path)) {
    fail(`${service} has no welsh/config.yaml yet; run init first`);
  }
  const doc = YAML.parseDocument(readFileSync(path, "utf8"));
  const current = ((doc.toJS() as { identical_allowlist?: string[] } | null)?.identical_allowlist ?? []).filter((s) => typeof s === "string");
  const known = new Set(current.map(matchKey));
  const added = strings.filter((s) => !known.has(matchKey(s)));
  if (added.length && !values["dry-run"]) {
    doc.set("identical_allowlist", doc.createNode([...current, ...added]));
    writeFileSync(path, doc.toString({ flowCollectionPadding: false }));
  }
  say(
    `${added.length} added to ${service}'s identical_allowlist, ${strings.length - added.length} already there.` +
      (values["dry-run"] ? "\nDry run — nothing saved." : "")
  );
  return { service, dryRun: Boolean(values["dry-run"]), added, already: strings.length - added.length, branch: null, pr: null };
}

/** The same English, by the key a scan matches on, once. */
function unique(strings: string[]): string[] {
  const seen = new Set<string>();
  return strings.filter((s) => {
    const k = matchKey(s);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

/** The change, run by this same CLI in a worktree of the home repo, committed there, and opened as a draft PR with --pr. */
function keepInHome(service: string, strings: string[], pr: boolean): unknown {
  const done = inHome<KeepResult>(
    service,
    ["keep-english", "--service", service, "--", ...strings],
    { branch: branchName(`${service}-keep-english`), pr },
    (result) => ({
      message: `Keep ${result.added.length} English string(s) as they are in ${service}'s Welsh\n\nAdded to identical_allowlist in welsh/config.yaml.`,
      title: `Welsh: ${service} keeps ${result.added.length} string(s) in English`,
      body:
        `Adds these to \`identical_allowlist\` in \`welsh/config.yaml\`, so a scan no longer asks for their Welsh:\n\n` +
        `${result.added.map((s) => `- \`${s.replace(/`/g, "'")}\``).join("\n")}\n\n` +
        "A BA left them out of the Welsh Language Unit's spreadsheet on the Welsh page, as right in English on a Welsh page: " +
        "an address, a system's name, a cookie's name. Remove any that the Welsh unit says do need Welsh."
    })
  );
  if (done.pr) {
    say(`Draft PR: ${done.pr}`);
  } else if (done.branch) {
    say(`Committed on ${done.branch} in ${homeRepo(service)}/welsh; run again with --pr to open a draft PR.`);
  } else {
    say("All of it is already kept, so nothing was committed.");
  }
  return { ...done.result, branch: done.branch, pr: done.pr };
}

interface KeepResult {
  added: string[];
  already: number;
}
