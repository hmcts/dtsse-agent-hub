/** Catalogue commands: init, search, import-legacy. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cataloguePath, loadCatalogue, loadCatalogues, type SearchMode, search } from "../catalogue.ts";
import { loadConfig } from "../config.ts";
import { fail, requireService, say } from "../io.ts";
import { importLegacy, type LegacySource } from "../legacy.ts";

export async function init(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({ args: argv, options: { service: { type: "string" } } });
  const service = requireService(values.service);
  const created: string[] = [];
  const cat = loadCatalogue(service);
  if (!existsSync(cat.path)) {
    mkdirSync(dirname(cat.path), { recursive: true });
    cat.save();
    created.push(cat.path);
  }
  if (service !== "shared") {
    const dir = dirname(cat.path);
    for (const sub of ["requests", "returns"]) {
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
  }
  say(created.length ? `Created:\n  ${created.join("\n  ")}` : `apps/${service}/welsh is already set up.`);
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
  const hits = search(query, loadCatalogues(service), mode, Boolean(values.all));
  say(`${hits.length} match(es) for "${query}" (${mode}) in ${service}${service === "shared" ? "" : " + shared"}`);
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
      "conflicts-out": { type: "string" }
    }
  });
  const service = requireService(values.service);
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

  const conflictsOut = values["conflicts-out"] ?? join(dirname(cataloguePath(service)), "legacy-conflicts.md");
  if (report.conflicts.length) {
    writeFileSync(conflictsOut, conflictsMarkdown(service, report.conflicts));
  }
  say(
    `Read ${report.read} legacy entries → ${report.added} catalogue rows added, ${report.unchanged} already present` +
      ` (${report.overriddenCopies} JSON copies dropped in favour of the spreadsheet).\n` +
      `${report.needsReview} rows are needs-review and will not be used to fill anything until a BA approves them.\n` +
      (report.conflicts.length
        ? `${report.conflicts.length} English strings have more than one Welsh rendering — listed in ${conflictsOut}.`
        : "No conflicting renderings.")
  );
  return { service, catalogue: cat.path, ...report, conflictsReport: report.conflicts.length ? conflictsOut : null, conflicts: report.conflicts.length };
}

function conflictsMarkdown(service: string, conflicts: Awaited<ReturnType<typeof importLegacy>>["conflicts"]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  const lines = [
    `# Legacy catalogue conflicts — ${service}`,
    "",
    "Each English string below has more than one Welsh rendering across the legacy catalogues.",
    "All renderings are in `catalogue.csv` with status `needs-review`, so none is used to fill anything.",
    "Confirm the correct one with the Welsh Language Unit, set that row to `approved` and the others to `superseded`.",
    "",
    "| English | Context | Welsh options (source) |",
    "|---|---|---|"
  ];
  for (const c of conflicts) {
    lines.push(`| ${cell(c.english)} | ${cell(c.context)} | ${c.options.map((o) => `${cell(o.welsh)} _(${cell(o.where)})_`).join("<br><br>")} |`);
  }
  return `${lines.join("\n")}\n`;
}

const CONFIG_TEMPLATE = (service: string) => `# Welsh translation settings for ${service}. Read by the agent-hub welsh plugin.
# Reference: docs/reference/welsh-catalogue-format.md

# Repos to scan, relative to the workspace root, and the adapter for each.
# Adapters: ts-locale-pair, json-pair (layout: folders | translation-folders | single | combined | step-files)
repos: []
#  - path: apps/${service}/<repo>
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
  const count = (svc: string) => {
    const cat = loadCatalogue(svc);
    const by = (s: string) => cat.rows.filter((r) => r.status === s).length;
    return { exists: existsSync(cat.path), rows: cat.rows.length, approved: by("approved"), needsReview: by("needs-review"), superseded: by("superseded") };
  };
  const config = loadConfig(service);
  const result = {
    service,
    initialised: existsSync(join(dirname(cataloguePath(service)), "config.yaml")),
    repos: config.repos.map((r) => ({ path: r.path, adapters: r.adapters ?? null, staffOnly: r.staff_only ?? [] })),
    catalogue: count(service),
    shared: count("shared")
  };
  say(`${service}: ${result.catalogue.approved} approved catalogue row(s), ${result.repos.length} repo(s) configured.`);
  return result;
}
