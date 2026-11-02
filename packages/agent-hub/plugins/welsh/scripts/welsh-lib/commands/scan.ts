/**
 * scan: find English content without Welsh in a service's repos.
 *
 *   scan --service X                         every repo in config.yaml
 *   scan --service X --repo apps/X/<repo>    one clone (adapters auto-detected)
 *   scan ... --request                       also write the WLU request xlsx
 *
 * Each string is either already in the catalogue (apply it, no WLU needed),
 * ambiguous (a BA picks), or new (goes in the request).
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCatalogue } from "../catalogue.ts";
import { ensureClone, latestTree } from "../clones.ts";
import { loadConfig, type RepoConfig } from "../config.ts";
import { fail, requireService, say } from "../io.ts";
import { matchKey } from "../normalise.ts";
import { WORKSPACE } from "../paths.ts";
import { saveRequest, workDir } from "../requests.ts";
import { type Finding, scanRepo } from "../scan.ts";

export async function scanCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: {
      service: { type: "string" },
      repo: { type: "string" },
      adapter: { type: "string", multiple: true },
      request: { type: "boolean" },
      out: { type: "string" },
      limit: { type: "string" }
    }
  });
  const service = requireService(values.service);
  const repos = resolveRepos(service, values.repo, values.adapter);
  const config = loadConfig(service);
  const catalogue = loadCatalogue(service);

  const all: Finding[] = [];
  const perRepo: Record<string, unknown> = {};
  for (const repo of repos) {
    const abs = isAbsolute(repo.path) || repo.path.startsWith("..") ? resolve(WORKSPACE, repo.path) : ensureClone(repo.path);
    if (!existsSync(abs)) {
      fail(`${repo.path} does not exist`);
    }
    const tree = latestTree(abs);
    let findings: Finding[];
    try {
      findings = scanRepo(service, tree.dir, repo, config, catalogue);
    } finally {
      tree.remove();
    }
    writeFileSync(
      join(workDir(service, "scans"), `${basename(abs)}.json`),
      JSON.stringify({ repo: repo.path, scanned: new Date().toISOString(), findings }, null, 2)
    );
    perRepo[repo.path] = summarise(findings);
    all.push(...findings);
  }

  const groups = groupByEnglish(all);
  const toWlu = groups.filter((g) => g.findings[0].match.kind === "miss");
  const ambiguous = groups.filter((g) => g.findings[0].match.kind === "ambiguous");
  const fromCatalogue = groups.filter((g) => g.findings[0].match.kind === "hit");

  let request: string | null = null;
  // Strings needing a choice go to the WLU too, with what the catalogue offers: one a BA does not choose for must
  // still reach somebody who can say which Welsh is right for this screen.
  if ((values.request || values.out) && toWlu.length + ambiguous.length) {
    request = await saveRequest(
      service,
      `scan-${repos.map((r) => basename(r.path)).join("+")}`,
      [
        ...toWlu.map((g) => ({ ref: g.ref, english: g.english, context: where(g.findings), notes: tokenNote(g.english) })),
        ...ambiguous.map((g) => ({ ref: g.ref, english: g.english, context: where(g.findings), notes: checkNote(g) }))
      ],
      values.out ? resolve(values.out) : undefined
    );
  }

  const s = summarise(all);
  say(
    `${s.total} place(s) need Welsh across ${repos.length} repo(s) — ${Object.entries(s.bySignal)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}.\n` +
      `By unique English string: ${fromCatalogue.length} already in the catalogue (can be applied now), ` +
      `${ambiguous.length} needing a BA choice between catalogue options or for context (also in the WLU spreadsheet, to confirm), ${toWlu.length} new for the WLU.\n` +
      (request ? `Request for the WLU: ${request}` : toWlu.length ? "Run again with --request to write the WLU spreadsheet." : "")
  );
  const limit = Number(values.limit ?? 50);
  return {
    service,
    repos: perRepo,
    summary: { ...s, unique: groups.length, fromCatalogue: fromCatalogue.length, ambiguous: ambiguous.length, toWlu: toWlu.length },
    request,
    ambiguous: ambiguous.slice(0, limit).map((g) => ({
      ref: g.ref,
      english: g.english,
      where: where(g.findings),
      options:
        g.findings[0].match.kind === "ambiguous"
          ? g.findings[0].match.options.map((o) => ({ id: o.id, welsh: o.welsh, context: o.context, source: o.source }))
          : []
    })),
    toWlu: toWlu.slice(0, limit).map((g) => ({ ref: g.ref, english: g.english, where: where(g.findings) })),
    fromCatalogue: fromCatalogue
      .slice(0, limit)
      .map((g) => ({ ref: g.ref, english: g.english, welsh: g.findings[0].match.kind === "hit" ? g.findings[0].match.welsh : "", where: where(g.findings) }))
  };
}

export function resolveRepos(service: string, repoArg: string | undefined, adapters: string[] | undefined): RepoConfig[] {
  const config = loadConfig(service);
  if (repoArg) {
    const rel = relative(WORKSPACE, resolve(repoArg));
    const known = config.repos.find((r) => r.path === rel);
    return [{ ...(known ?? { path: rel }), ...(adapters?.length ? { adapters } : {}) }];
  }
  if (!config.repos.length) {
    fail(`no repos in apps/${service}/welsh/config.yaml — add them, or pass --repo`);
  }
  return config.repos;
}

export function groupByEnglish(findings: Finding[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of findings) {
    const k = matchKey(f.english);
    const g = map.get(k) ?? { ref: f.ref, english: f.english, findings: [] };
    g.findings.push(f);
    map.set(k, g);
  }
  return [...map.values()];
}

function summarise(findings: Finding[]) {
  const bySignal: Record<string, number> = {};
  const byMatch: Record<string, number> = {};
  for (const f of findings) {
    bySignal[f.signal] = (bySignal[f.signal] ?? 0) + 1;
    byMatch[f.match.kind] = (byMatch[f.match.kind] ?? 0) + 1;
  }
  return { total: findings.length, bySignal, byMatch };
}

function where(findings: Finding[]): string {
  const shown = findings.slice(0, 4).map((f) => `${f.cyFile}${f.line ? `:${f.line}` : ""} (${f.key})`);
  return shown.join("; ") + (findings.length > 4 ? `; and ${findings.length - 4} more` : "");
}

/** For a string the catalogue answers more than one way, or only for another screen: what it has, for the WLU to confirm. */
function checkNote(g: Group): string {
  const match = g.findings[0].match;
  const offered = match.kind === "ambiguous" ? [...new Set(match.options.map((o) => o.welsh))] : [];
  const why = offered.length > 1 ? "The catalogue has more than one translation" : "The catalogue's translation may not fit this question";
  return [`${why}: ${offered.join(" / ")}. Please confirm the right Welsh for where it is used.`, tokenNote(g.english)].filter(Boolean).join(" ");
}

/** A reminder for the translator when the English carries placeholders. */
function tokenNote(english: string): string {
  const tokens = english.match(/\{\{[^}]+\}\}|\$\{[^}]+\}|%\{[^}]+\}|\{[\w.]+\}|%[sd]|\(\([^)]+\)\)/g);
  return tokens ? `Keep ${[...new Set(tokens)].join(", ")} exactly as written` : "";
}

export interface Group {
  ref: string;
  english: string;
  findings: Finding[];
}
