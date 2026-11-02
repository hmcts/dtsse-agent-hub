/** Catalogue commands: init, search, import-legacy. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cataloguePath, loadCatalogue, type SearchMode, search } from "../catalogue.ts";
import { loadConfig } from "../config.ts";
import { branchName, HOME_OVERRIDE, homeRepo, inHome, noHome } from "../home.ts";
import { fail, requireService, say } from "../io.ts";
import { importLegacy, type LegacySource } from "../legacy.ts";
import { REVIEW_FILE, reviewMarkdown } from "../review.ts";

/** Sets a service up: a welsh/ folder in its home repo, committed on a branch, and a draft PR there with --pr. */
export async function init(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({ args: argv, options: { service: { type: "string" }, pr: { type: "boolean" }, repo: { type: "string" } } });
  const service = requireService(values.service);
  if (!process.env[HOME_OVERRIDE]) {
    // A service with no Welsh yet has no home repo to find, so --repo says which of its repos to put welsh/ in.
    const repo = values.repo?.replace(/\/+$/, "");
    if (repo !== undefined && !repo.startsWith(`apps/${service}/`)) {
      fail(`--repo must be one of ${service}'s repos, apps/${service}/<repo>`);
    }
    const done = inHome<{ created: string[] }>(
      service,
      ["init", "--service", service],
      { branch: branchName(`${service}-init`), pr: Boolean(values.pr), ...(repo === undefined ? {} : { repo }) },
      () => ({
        message: `Set up the ${service} Welsh catalogue`,
        title: `Welsh catalogue: set up ${service}`,
        body: "Adds an empty `welsh/catalogue.csv`, a `welsh/config.yaml` to fill in with the repos to scan, and `welsh/returns/` for the Welsh Language Unit's returns."
      })
    );
    say(done.pr ? `Draft PR: ${done.pr}` : done.branch ? `Committed on ${done.branch} in ${repo ?? homeRepo(service)}.` : `${service} is already set up.`);
    return { service, ...done.result, branch: done.branch, pr: done.pr };
  }
  const created: string[] = [];
  const cat = loadCatalogue(service);
  if (!existsSync(cat.path)) {
    mkdirSync(dirname(cat.path), { recursive: true });
    cat.save();
    created.push(cat.path);
  }
  const dir = dirname(cat.path);
  for (const sub of ["returns"]) {
    const keep = join(dir, sub, ".gitkeep");
    if (!existsSync(keep)) {
      mkdirSync(dirname(keep), { recursive: true });
      writeFileSync(keep, "");
      created.push(keep);
    }
  }
  const config = join(dir, "config.yaml");
  if (!existsSync(config)) {
    writeFileSync(config, CONFIG_TEMPLATE(service));
    created.push(config);
  }
  say(created.length ? `Created:\n  ${created.join("\n  ")}` : "welsh/ is already set up.");
  return { service, created };
}

export async function searchCmd(argv: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      service: { type: "string" },
      exact: { type: "boolean" },
      fuzzy: { type: "boolean" },
      all: { type: "boolean" },
      limit: { type: "string" }
    }
  });
  const query = positionals.join(" ").trim();
  if (!query) {
    fail("give the text to search for");
  }
  const service = requireService(values.service);
  const mode: SearchMode = values.exact ? "exact" : values.fuzzy ? "fuzzy" : "contains";
  const limit = Number(values.limit ?? 25);
  const hits = search(query, loadCatalogue(service), mode, Boolean(values.all));
  say(`${hits.length} match(es) for "${query}" (${mode}) in ${service}`);
  return { query, mode, service, total: hits.length, hits: hits.slice(0, limit) };
}

export async function importLegacyCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      xlsx: { type: "string", multiple: true },
      json: { type: "string", multiple: true },
      received: { type: "string" },
      "review-out": { type: "string" },
      pr: { type: "boolean" }
    }
  });
  const service = requireService(values.service);
  if (!process.env[HOME_OVERRIDE]) {
    return legacyInHome(
      service,
      argv.filter((a) => a !== "--pr"),
      Boolean(values.pr)
    );
  }
  const sources: LegacySource[] = [
    ...(values.xlsx ?? []).map((p) => ({ kind: "xlsx" as const, path: resolve(p), label: `legacy:${basename(p)}` })),
    ...(values.json ?? []).map((p) => ({ kind: "json" as const, path: resolve(p), label: `legacy:${basename(p)}` }))
  ];
  if (!sources.length) {
    fail("give at least one --xlsx or --json source");
  }
  for (const s of sources) {
    if (!existsSync(s.path)) {
      fail(`${s.path} does not exist`);
    }
  }

  const cat = loadCatalogue(service);
  mkdirSync(dirname(cat.path), { recursive: true });
  const report = await importLegacy(cat, sources, values.received ?? new Date().toISOString().slice(0, 10));
  cat.save();

  const reviewOut = values["review-out"] ?? join(dirname(cataloguePath(service)), REVIEW_FILE);
  writeFileSync(reviewOut, reviewMarkdown(cat));
  say(
    `Read ${report.read} legacy entries → ${report.added} catalogue rows added, ${report.unchanged} already present` +
      ` (${report.overriddenCopies} JSON copies dropped in favour of the spreadsheet).\n` +
      `${report.needsReview} rows are needs-review and will not be used to fill anything until a BA approves them.\n` +
      (report.conflicts.length
        ? `${report.conflicts.length} English strings have more than one Welsh rendering. Every needs-review row is listed in ${reviewOut}.`
        : "No conflicting renderings.")
  );
  return { service, catalogue: cat.path, ...report, review: reviewOut, conflicts: report.conflicts.length };
}

/** The seeding, run again in a worktree of the home repo with the sources' absolute paths, committed there. */
function legacyInHome(service: string, argv: string[], pr: boolean): unknown {
  // The worktree run starts elsewhere, so every source path is made absolute first.
  const absolute = argv.map((a, i) => (["--xlsx", "--json", "--review-out"].includes(argv[i - 1] ?? "") ? resolve(a) : a));
  const done = inHome<{ added: number; needsReview: number; conflicts: number }>(
    service,
    ["import-legacy", ...absolute],
    { branch: branchName(`${service}-legacy`), pr },
    (r) => ({
      message: `Seed the ${service} Welsh catalogue from its legacy translations\n\n${r.added} rows, ${r.needsReview} needs-review, ${r.conflicts} with conflicting Welsh.`,
      title: `Welsh catalogue: seed ${service} from its legacy translations`,
      body:
        `Seeds \`welsh/catalogue.csv\` from the service's existing Welsh: ${r.added} rows, ${r.needsReview} of them \`needs-review\`, which are not used until a BA approves them. ` +
        (r.conflicts
          ? `${r.conflicts} English strings have more than one Welsh rendering. \`welsh/needs-review.md\` lists every row for the BA to settle with the Welsh Language Unit.`
          : "")
    })
  );
  say(done.pr ? `Draft PR: ${done.pr}` : done.branch ? `Committed on ${done.branch} in ${homeRepo(service)}.` : "Nothing new for the catalogue.");
  return { ...done.result, branch: done.branch, pr: done.pr };
}

const CONFIG_TEMPLATE = (service: string) => `# Welsh translation settings for ${service}. Read by the agent-hub welsh plugin.
# Reference: the agent hub welsh plugin's README (hmcts/dtsse-agent-hub, packages/agent-hub/plugins/welsh)

# Repos to scan, and the adapter for each: "." for this repo, or another of the
# service's repos by its path in cft-workspace.
# Adapters: ts-locale-pair, json-pair (layout: folders | translation-folders | single | combined | step-files)
repos: []
#  - path: .
#    adapter: ts-locale-pair
#    include: ["apps/web/src/**", "libs/**/src/**"]
#    staff_only: ["apps/web/src/pages/(admin)/**"]   # staff-only pages: no Welsh needed, never scanned
#    test: yarn test

# English strings that are correctly identical in Welsh (names, codes, URLs).
identical_allowlist: []

# Extra regexes that mark a Welsh value as a placeholder, on top of the built-in ones.
placeholder_patterns: []

# English the catalogue must never fill automatically because its Welsh depends
# on the question (Yes/No are built in). A BA picks one with --choose REF=ROW-ID.
context_sensitive: []
`;

/** What a service has set up: its repos and its catalogue's counts. For the CFT Workspace's Welsh page. */
export async function infoCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({ args: argv, options: { service: { type: "string" } } });
  const service = requireService(values.service);
  const home = homeRepo(service);
  if (home === null) {
    say(noHome(service));
    return { service, home: null, initialised: false, repos: [], catalogue: { exists: false, rows: 0, approved: 0, needsReview: 0, superseded: 0 } };
  }
  const count = (svc: string) => {
    const cat = loadCatalogue(svc);
    const by = (s: string) => cat.rows.filter((r) => r.status === s).length;
    return { exists: existsSync(cat.path), rows: cat.rows.length, approved: by("approved"), needsReview: by("needs-review"), superseded: by("superseded") };
  };
  const config = loadConfig(service);
  const result = {
    service,
    home,
    initialised: existsSync(join(dirname(cataloguePath(service)), "config.yaml")),
    repos: config.repos.map((r) => ({ path: r.path, adapters: r.adapters ?? null, staffOnly: r.staff_only ?? [] })),
    catalogue: count(service)
  };
  say(`${service}: ${result.catalogue.approved} approved catalogue row(s), ${result.repos.length} repo(s) configured.`);
  return result;
}
