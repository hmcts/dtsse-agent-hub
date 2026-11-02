/**
 * Find English content without approved Welsh, and say for each string
 * whether the catalogue already has the answer.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { jsonPair } from "./adapters/json-pair.ts";
import { tsLocalePair } from "./adapters/ts-locale-pair.ts";
import type { Adapter, Leaf } from "./adapters/types.ts";
import { type Catalogue, type Lookup, lookup } from "./catalogue.ts";
import type { RepoConfig, ServiceConfig } from "./config.ts";
import { matchKey } from "./normalise.ts";
import { contentRef } from "./requests.ts";
import { isPlaceholder } from "./verify.ts";

export const ADAPTERS: Record<string, Adapter> = {
  [tsLocalePair.name]: tsLocalePair,
  [jsonPair.name]: jsonPair
};

export function scanRepo(service: string, repoAbs: string, repo: RepoConfig, config: ServiceConfig, catalogues: Catalogue[]): Finding[] {
  const files = listFiles(repoAbs).filter(globFilter(repo.include, [...(repo.exclude ?? []), ...(repo.staff_only ?? [])]));
  const extra = config.placeholder_patterns.map((p) => new RegExp(p));
  const allow = new Set(config.identical_allowlist.map(matchKey));
  const findings: Finding[] = [];
  for (const name of repo.adapters ?? Object.keys(ADAPTERS)) {
    const adapter = ADAPTERS[name];
    if (!adapter) {
      throw new Error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
    }
    for (const leaf of adapter.extract(repoAbs, files, repo.options ?? {})) {
      const signal = classify(leaf, extra, allow);
      if (!signal) {
        continue;
      }
      const match = lookup(leaf.english, catalogues, config.context_sensitive);
      // The WLU has confirmed this English stays as it is in Welsh.
      if (signal === "identical" && match.kind === "hit" && match.welsh === leaf.welsh) {
        continue;
      }
      findings.push({ ...leaf, signal, ref: contentRef(service, leaf.english), match });
    }
  }
  return findings;
}

/** Why this leaf needs Welsh, or null when it already has some. */
export function classify(leaf: Leaf, extra: RegExp[], allow: Set<string>): Signal | null {
  const en = leaf.english;
  if (!/\p{L}/u.test(en) || isPlaceholder(en, extra)) {
    return null;
  }
  if (leaf.welsh === null) {
    return leaf.cyMissing ? "missing-file" : "missing-key";
  }
  if (leaf.welsh.trim() === "") {
    return "empty";
  }
  if (/\[WELSH TRANSLATION REQUIRED:|\[TRANSLATE:/i.test(leaf.welsh)) {
    return "marker";
  }
  if (isPlaceholder(leaf.welsh, extra)) {
    return "placeholder";
  }
  if (leaf.welsh === en && !allow.has(matchKey(en)) && !looksUntranslatable(en)) {
    return "identical";
  }
  return null;
}

/** URLs, emails, codes, acronyms and kebab-case ids are legitimately the same in Welsh. */
export function looksUntranslatable(text: string): boolean {
  const t = text.trim();
  return (
    /^(https?:\/\/|www\.|mailto:|tel:|\/)/i.test(t) ||
    /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t) ||
    /^[A-Z0-9][A-Z0-9 &/().-]{0,9}$/.test(t) ||
    /^[a-z0-9]+(-[a-z0-9]+)+$/.test(t) ||
    (!/\s/.test(t) && /[._/\\]|\d/.test(t)) ||
    /^(\{\{[^}]+\}\}|\$\{[^}]+\}|%[sd]|\s)+$/.test(t)
  );
}

function listFiles(repoAbs: string): string[] {
  const git = spawnSync("git", ["-C", repoAbs, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (git.status === 0) {
    return git.stdout.split("\n").filter(Boolean);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (/^(node_modules|\.git|dist|build|target|coverage)$/.test(e.name)) {
        continue;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(relative(repoAbs, p));
      }
    }
  };
  walk(repoAbs);
  return out;
}

function globFilter(include?: string[], exclude?: string[]): (f: string) => boolean {
  const inc = include?.map(globToRegExp);
  const exc = [...(exclude ?? []), "**/node_modules/**", "**/dist/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"].map(globToRegExp);
  return (f) => (!inc || inc.some((re) => re.test(f))) && !exc.some((re) => re.test(f));
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export type Signal = "missing-file" | "missing-key" | "empty" | "marker" | "placeholder" | "identical";

export interface Finding extends Leaf {
  signal: Signal;
  ref: string;
  match: Lookup;
}
