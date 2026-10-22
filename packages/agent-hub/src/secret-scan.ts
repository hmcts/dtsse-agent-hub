// Secret-shaped text, caught before this client sends anything to the hub. The patterns are a data file rather
// than code so that cft-workspace's knowledge sweep can read a twin copy of the same list with grep; the file's
// own header names that twin.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// `dist/` is one directory below the package root, so the published `secret-patterns` sits beside it. This is a
// URL rather than a path relative to the working directory: the package is installed under `node_modules` and
// the caller's directory says nothing about where it landed.
export const PATTERNS_FILE = fileURLToPath(new URL("../secret-patterns", import.meta.url));

export function parsePatterns(text: string): RegExp[] {
  return text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => new RegExp(line));
}

let cached: RegExp[] | null = null;

export function loadPatterns(file: string = PATTERNS_FILE): RegExp[] {
  if (file === PATTERNS_FILE && cached) {
    return cached;
  }
  const patterns = parsePatterns(fs.readFileSync(file, "utf8"));
  if (patterns.length === 0) {
    throw new Error(`no secret patterns in ${file}`);
  }
  if (file === PATTERNS_FILE) {
    cached = patterns;
  }
  return patterns;
}

// grep matches line by line; none of the patterns can span a newline, so testing the
// whole text is equivalent. The matched text is never returned, only its pattern.
export function findSecret(text: string | null | undefined, patterns: RegExp[] = loadPatterns()): string | null {
  if (!text) {
    return null;
  }
  for (const re of patterns) {
    if (re.test(text)) {
      return re.source;
    }
  }
  return null;
}

export function containsSecret(text: string | null | undefined, patterns?: RegExp[]): boolean {
  return findSecret(text, patterns) !== null;
}
