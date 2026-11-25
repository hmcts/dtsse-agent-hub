/**
 * Setting a service up for Welsh in one step: a welsh/ folder in the repo the team picks, its catalogue seeded from
 * whatever earlier translations they have (any number of WLU spreadsheets and JSON copies), as one draft pull request.
 * `--dry-run` reads the same files into a scratch folder and reports what the catalogue would hold, committing nothing,
 * which is the Welsh page's check before anything is opened.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { manifestEntries, manifestUrl } from "../clones.ts";
import { branchName, HOME_OVERRIDE, homeRepo, inHome } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import type { LegacySource } from "../legacy.ts";
import { tool } from "../tools.ts";
import { readTable } from "../xlsx.ts";
import { legacySources, scaffold, seedLegacy } from "./catalogue.ts";

/** The title every setup pull request has, `init`'s too, so one still open can be found. */
export const SETUP_TITLE = (service: string) => `Welsh catalogue: set up ${service}`;

/** The service's repos in workspace.yaml, by workspace path: where its welsh/ folder could go. */
export function serviceRepos(service: string): string[] {
  const prefix = `apps/${service}/`;
  return Object.keys(manifestEntries())
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A setup pull request still open in any of these repos, or null. Until it is merged the default branch has no welsh/
 * folder, so the service still reads as not set up, and setting it up again would open a second one. A repo GitHub
 * cannot be asked about counts as having none: this only saves a duplicate, and the team's review catches one anyway.
 */
export function openSetupPr(service: string, repos: readonly string[]): string | null {
  let gh: string;
  try {
    gh = tool("gh");
  } catch {
    return null;
  }
  for (const repo of repos) {
    const url = manifestUrl(repo);
    if (url === null) {
      continue;
    }
    const asked = spawnSync(
      gh,
      ["pr", "list", "--repo", url, "--state", "open", "--search", `"${SETUP_TITLE(service)}" in:title`, "--json", "url", "--jq", '.[0].url // ""'],
      { encoding: "utf8" }
    );
    const found = asked.status === 0 ? asked.stdout.trim() : "";
    if (found !== "") {
      return found;
    }
  }
  return null;
}

/** A file that could not be read as earlier translations, and why, so the team can fix it or leave it out. */
export interface Unreadable {
  file: string;
  problem: string;
}

/** Each source read on its own, so one spreadsheet without an English or Welsh heading is named rather than failing them all. */
export async function unreadableSources(sources: readonly LegacySource[]): Promise<Unreadable[]> {
  const out: Unreadable[] = [];
  for (const source of sources) {
    try {
      if (source.kind === "xlsx") {
        await readTable(source.path);
      } else {
        const parsed: unknown = JSON.parse(readFileSync(source.path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("it is not a JSON object of English to Welsh");
        }
      }
    } catch (e) {
      out.push({ file: source.label.replace(/^legacy:/, ""), problem: (e as Error).message.replace(`${source.path}: `, "") });
    }
  }
  return out;
}

/** What a setup with no earlier translations reports, in the shape of a seeding. */
const EMPTY_SEED = {
  service: "",
  catalogue: "",
  review: "",
  read: 0,
  added: 0,
  unchanged: 0,
  overriddenCopies: 0,
  needsReview: 0,
  conflicts: 0,
  conflictExamples: []
};

export async function setupCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      repo: { type: "string" },
      xlsx: { type: "string", multiple: true },
      json: { type: "string", multiple: true },
      received: { type: "string" },
      "dry-run": { type: "boolean" },
      pr: { type: "boolean" }
    }
  });
  const service = requireService(values.service);
  const sources = legacySources(values.xlsx, values.json);

  // In the folder being made: what every welsh/ folder has, then the earlier translations, if there are any.
  if (process.env[HOME_OVERRIDE]) {
    const created = scaffold(service);
    const seeded = sources.length > 0 ? await seedLegacy(service, sources, values.received) : null;
    const { catalogue: _catalogue, review: _review, service: _service, ...report } = seeded ?? EMPTY_SEED;
    return { service, created, sources: sources.length, ...report };
  }

  const repo = values.repo?.replace(/\/+$/, "");
  if (repo === undefined) {
    fail("--repo is required: the one of the service's repos to keep its Welsh in, apps/<service>/<repo>");
  }
  if (!serviceRepos(service).includes(repo)) {
    fail(`--repo must be one of ${service}'s repos in workspace.yaml, apps/${service}/<repo>`);
  }
  const home = homeRepo(service);
  if (home !== null) {
    fail(`${service} is already set up for Welsh, in ${home}`);
  }
  const open = openSetupPr(service, serviceRepos(service));
  if (open !== null) {
    fail(`a pull request setting up ${service}'s Welsh is already open: ${open}`);
  }
  const unreadable = await unreadableSources(sources);
  // The worktree run starts elsewhere, so every source path is made absolute first.
  const inner = [
    "setup",
    "--service",
    service,
    ...sources.flatMap((s) => [`--${s.kind}`, resolve(s.path)]),
    ...(values.received ? ["--received", values.received] : [])
  ];

  if (values["dry-run"]) {
    const usable = sources.filter((s) => !unreadable.some((u) => s.label === `legacy:${u.file}`));
    const result = await inScratch(service, usable, values.received);
    say(unreadable.length ? `${unreadable.length} file(s) could not be read and would be left out.` : "Every file could be read.");
    return { ...result, repo, dryRun: true, unreadable };
  }
  if (unreadable.length > 0) {
    fail(`these files could not be read: ${unreadable.map((u) => `${u.file} (${u.problem})`).join("; ")}`);
  }
  type Seeded = { created: string[]; sources: number; added: number; needsReview: number; conflicts: number };
  const done = inHome<Seeded>(service, inner, { branch: branchName(`${service}-setup`), pr: Boolean(values.pr), repo }, (r) => ({
    message: `Set up the ${service} Welsh catalogue${r.sources ? ` from ${r.sources} earlier translation file(s)` : ""}\n\n${r.added} rows, ${r.needsReview} needs-review.`,
    title: SETUP_TITLE(service),
    body: setupBody(r)
  }));
  say(done.pr ? `Draft PR: ${done.pr}` : done.branch ? `Committed on ${done.branch} in ${repo}.` : `${service} is already set up.`);
  return { ...done.result, repo, branch: done.branch, pr: done.pr };
}

function setupBody(r: { sources: number; added: number; needsReview: number; conflicts: number }): string {
  const seeded = r.sources
    ? `Seeds \`welsh/catalogue.csv\` from ${r.sources} earlier translation file(s): ${r.added} rows, ${r.needsReview} of them \`needs-review\`, which are not used until a BA approves them. ` +
      (r.conflicts
        ? `${r.conflicts} English strings have more than one Welsh rendering. \`welsh/needs-review.md\` lists every row to settle with the Welsh Language Unit.`
        : "")
    : "Adds an empty `welsh/catalogue.csv`.";
  return (
    `Sets this service up for Welsh translations. ${seeded}\n\n` +
    "Also adds `welsh/config.yaml` and `welsh/returns/` for the Welsh Language Unit's returns. Before the Welsh page can check the code, list the repos to scan in `config.yaml`, with the adapter for each."
  );
}

/** The setup run in a scratch folder: what the catalogue would hold, with nothing committed anywhere. */
async function inScratch(service: string, sources: LegacySource[], received?: string) {
  const dir = mkdtempSync(join(tmpdir(), "welsh-setup-"));
  const before = process.env[HOME_OVERRIDE];
  process.env[HOME_OVERRIDE] = join(dir, "welsh");
  try {
    scaffold(service);
    const seeded = sources.length > 0 ? await seedLegacy(service, sources, received, join(dir, "needs-review.md")) : null;
    const { catalogue: _catalogue, review: _review, service: _service, ...report } = seeded ?? EMPTY_SEED;
    return { service, sources: sources.length, ...report };
  } finally {
    if (before === undefined) {
      delete process.env[HOME_OVERRIDE];
    } else {
      process.env[HOME_OVERRIDE] = before;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
