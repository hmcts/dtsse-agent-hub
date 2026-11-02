/**
 * verify: prove every Welsh value a branch changed came from the Welsh
 * Language Unit. Compares the clone's working tree with a base (default: the
 * default branch) and checks each new or changed Welsh value against the
 * approved catalogue and any returns given with --return.
 *
 *   verify --service X --repo <clone> [--base origin/master] [--return f.xlsx]...
 *
 * Exits 1 when anything cannot be traced, so it can gate a PR.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Leaf } from "../adapters/types.ts";
import { loadCatalogue } from "../catalogue.ts";
import { defaultBranch, git } from "../git.ts";
import { requireService, say } from "../io.ts";
import { workspace } from "../paths.ts";
import { readReturn } from "../returns.ts";
import { ADAPTERS } from "../scan.ts";
import { type Pair, verify } from "../verify.ts";
import { resolveRepos } from "./scan.ts";

export async function verifyCmd(argv: string[]): Promise<unknown> {
  const { values } = parseArgs({
    args: argv,
    options: { service: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, return: { type: "string", multiple: true } }
  });
  const service = requireService(values.service);
  const results = [];
  for (const repo of resolveRepos(service, values.repo, undefined)) {
    const abs = resolve(workspace(), repo.path);
    const base = values.base ?? `origin/${defaultBranch(abs)}`;
    const mergeBase = git(abs, ["merge-base", base, "HEAD"]);
    const changed = [
      ...new Set([...git(abs, ["diff", "--name-only", mergeBase]).split("\n"), ...git(abs, ["ls-files", "--others", "--exclude-standard"]).split("\n")])
    ].filter(Boolean);

    // Extract both sides from just the changed files and their counterparts.
    const files = withCounterparts(changed, git(abs, ["ls-files"]).split("\n"));
    const baseTree = snapshot(abs, mergeBase, files);
    const pairs: Pair[] = [];
    for (const [name, adapter] of Object.entries(ADAPTERS)) {
      const opts = repo.options ?? {};
      const before = new Map(
        adapter
          .extract(
            baseTree,
            files.filter((f) => baseTree && existsAt(abs, mergeBase, f)),
            opts
          )
          .map((l) => [id(l), l.welsh])
      );
      for (const leaf of adapter.extract(abs, files, opts)) {
        if (leaf.welsh === null || !changed.includes(leaf.cyFile)) {
          continue;
        }
        if (before.get(id(leaf)) === leaf.welsh) {
          continue;
        }
        pairs.push({ english: leaf.english, welsh: leaf.welsh, where: `${leaf.cyFile}:${leaf.key} (${name})` });
      }
    }
    const returns: Pair[] = [];
    for (const r of values.return ?? []) {
      returns.push(...(await readReturn(service, resolve(r))).valid);
    }
    const check = verify(pairs, loadCatalogue(service), returns);
    results.push({ repo: repo.path, base, ...check });
    say(
      `${repo.path}: ${check.checked} changed Welsh value(s) vs ${base} — ${check.traced} traced to the WLU, ${check.placeholders} placeholder(s), ${check.failures.length} not traceable.` +
        (check.failures.length ? `\n${check.failures.map((f) => `  ${f.where}: "${f.welsh}" — ${f.reason}`).join("\n")}` : "")
    );
  }
  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
  return { service, ok: results.every((r) => r.ok), results };
}

function id(l: Leaf): string {
  return `${l.cyFile}\u0000${l.path.join(".")}`;
}

/** Changed files plus their other-language siblings, so pairs can be read. */
function withCounterparts(changed: string[], tracked: string[]): string[] {
  const all = new Set(tracked);
  const out = new Set<string>();
  for (const f of changed) {
    out.add(f);
    for (const [a, b] of [
      [/(^|\/)((?:[\w.-]+-)?)cy\.ts$/, "$1$2en.ts"],
      [/(^|\/)cy(\/.+\.json)$/, "$1en$2"],
      [/(^|\/)cy\.json$/, "$1en.json"],
      [/\.cy\.json$/, ".en.json"]
    ] as const) {
      const other = f.replace(a, b);
      if (other !== f && all.has(other)) {
        out.add(other);
      }
    }
  }
  return [...out];
}

/** The given files as they were at `rev`, in a scratch directory. */
function snapshot(repo: string, rev: string, files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "welsh-verify-"));
  for (const f of files) {
    if (!existsAt(repo, rev, f)) {
      continue;
    }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), git(repo, ["show", `${rev}:${f}`]));
  }
  return dir;
}

function existsAt(repo: string, rev: string, file: string): boolean {
  return git(repo, ["cat-file", "-e", `${rev}:${file}`], true) === "" && git(repo, ["ls-tree", "--name-only", rev, "--", file], true) !== "";
}
