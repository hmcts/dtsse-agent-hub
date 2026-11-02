/**
 * JSON locale files in en/cy pairs. One engine for every JSON layout seen
 * across the services; the pairing rule is the only difference:
 *
 *   locales/en/common.json        ↔ locales/cy/common.json        (i18next folders: pcs, pt, et, probate, cui-ra)
 *   i18n/locales/en.json          ↔ i18n/locales/cy.json          (single pair: civil-citizen-ui)
 *   steps/x/content.en.json       ↔ steps/x/content.cy.json       (one-per-page: sscs-submit-your-appeal)
 *   content.json { en: …, cy: … }                                 (combined: sscs-cor-frontend, via `combined:`)
 *
 * Writes re-serialise the file with its own indentation, keeping key order and
 * inserting a missing key after its English predecessor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, Edit, Leaf, TokenSyntax } from "./types.ts";

const RULES: [RegExp, string][] = [
  [/(^|\/)en(\/.+\.json)$/, "$1cy$2"],
  [/(^|\/)en\.json$/, "$1cy.json"],
  [/\.en\.json$/, ".cy.json"]
];

export const jsonPair: Adapter = {
  name: "json-pair",

  extract(repo, files, options) {
    const combined = new Set((options.combined as string[] | undefined) ?? []);
    const tokens = ((options.tokens as TokenSyntax | undefined) ?? "i18next") as TokenSyntax;
    const leaves: Leaf[] = [];

    for (const file of combined) {
      const doc = readJson(join(repo, file));
      if (!isObject(doc.en)) {
        continue;
      }
      const cy = isObject(doc.cy) ? doc.cy : {};
      for (const [path, english] of strings(doc.en)) {
        leaves.push(leaf(file, file, ["cy", ...path], path, english, get(cy, path), tokens));
      }
    }

    const set = new Set(files);
    for (const enFile of files) {
      if (combined.has(enFile) || /(^|\/)(node_modules|dist|build|coverage)\//.test(enFile) || /package(-lock)?\.json$/.test(enFile)) {
        continue;
      }
      const rule = RULES.find(([re]) => re.test(enFile));
      if (!rule) {
        continue;
      }
      const cyFile = enFile.replace(rule[0], rule[1]);
      const en = readJson(join(repo, enFile));
      if (!isObject(en)) {
        continue;
      }
      const cy = set.has(cyFile) ? readJson(join(repo, cyFile)) : null;
      for (const [path, english] of strings(en)) {
        leaves.push({ ...leaf(enFile, cyFile, path, path, english, cy === null ? null : get(cy, path), tokens), cyMissing: cy === null });
      }
    }
    return leaves;
  },

  write(repo, edits) {
    const byFile = new Map<string, Edit[]>();
    for (const e of edits) {
      byFile.set(e.leaf.cyFile, [...(byFile.get(e.leaf.cyFile) ?? []), e]);
    }
    const changed: string[] = [];
    for (const [file, list] of byFile) {
      const abs = join(repo, file);
      const exists = existsSync(abs);
      const raw = exists ? readFileSync(abs, "utf8") : "";
      const doc = exists ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {};
      const enFile = list[0].leaf.enFile;
      // The English side, shaped like the Welsh path, so new keys follow its order.
      const en = enFile === file ? { cy: doc.en } : readJson(join(repo, enFile));
      for (const e of list) {
        set(doc, e.leaf.path, e.welsh, en);
      }
      const indent = (exists ? raw : readFileSync(join(repo, enFile), "utf8")).match(/^[{[]\s*\n([ \t]+)/)?.[1] ?? "  ";
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const out = JSON.stringify(doc, null, indent).replace(/\n/g, eol) + (exists && !/\r?\n$/.test(raw) ? "" : eol);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, out);
      changed.push(file);
    }
    return changed;
  }
};

function leaf(
  enFile: string,
  cyFile: string,
  cyPath: (string | number)[],
  path: (string | number)[],
  english: string,
  welsh: unknown,
  tokens: TokenSyntax
): Leaf {
  return {
    adapter: "json-pair",
    enFile,
    cyFile,
    key: path.join("."),
    path: cyPath,
    english,
    welsh: typeof welsh === "string" ? welsh : null,
    tokens,
    readOnly: welsh !== undefined && welsh !== null && typeof welsh !== "string" ? "Welsh value is not a string" : undefined
  };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function* strings(v: unknown, path: (string | number)[] = []): Generator<[(string | number)[], string]> {
  if (typeof v === "string") {
    yield [path, v];
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      yield* strings(v[i], [...path, i]);
    }
  } else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      yield* strings(x, [...path, k]);
    }
  }
}

function get(v: any, path: (string | number)[]): unknown {
  for (const p of path) {
    if (v === null || typeof v !== "object") {
      return undefined;
    }
    v = v[p];
  }
  return v;
}

/**
 * Set a value, creating parents. A new key is placed after the nearest key
 * that precedes it in the English file, so the two files stay in the same order.
 */
function set(doc: any, path: (string | number)[], value: string, en: any): void {
  let node = doc;
  let enNode = en;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const last = i === path.length - 1;
    const enChild = enNode && typeof enNode === "object" ? enNode[p] : undefined;
    if (!last && (node[p] === undefined || node[p] === null)) {
      insertOrdered(node, p, Array.isArray(enChild) ? [] : {}, enNode);
    }
    if (last) {
      if (node[p] === undefined) {
        insertOrdered(node, p, value, enNode);
      } else {
        node[p] = value;
      }
    }
    node = node[p];
    enNode = enChild;
  }
}

function insertOrdered(node: any, key: string | number, value: unknown, enNode: any): void {
  if (Array.isArray(node) || typeof key === "number" || !enNode || typeof enNode !== "object" || Array.isArray(enNode)) {
    node[key] = value;
    return;
  }
  const order = Object.keys(enNode);
  const entries = Object.entries(node);
  const pos = order.indexOf(key);
  let at = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const p = order.indexOf(entries[i][0]);
    if (p > pos && pos >= 0) {
      at = i;
      break;
    }
  }
  entries.splice(at, 0, [key, value]);
  for (const k of Object.keys(node)) {
    delete node[k];
  }
  for (const [k, v] of entries) {
    node[k] = v;
  }
}
