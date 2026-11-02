/**
 * TypeScript locale modules in en/cy pairs — `en.ts` + `cy.ts`, or
 * `<name>-en.ts` + `<name>-cy.ts` — each exporting an object literal
 * (cath-service, dtsse templates).
 *
 * Read and written through the TypeScript AST, so only the string literal
 * being changed is touched and the rest of the file keeps its formatting.
 * Leaves are string literals, template literals, and arrow functions whose
 * body is one of those. Anything else (spreads, imported values, calls) is
 * skipped: it is not content this file owns.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Adapter, Edit, Leaf } from "./types.ts";

const PAIR = /(^|\/)((?:[\w.-]+-)?)en\.ts$/;

export const tsLocalePair: Adapter = {
  name: "ts-locale-pair",

  extract(repo, files) {
    const leaves: Leaf[] = [];
    const set = new Set(files);
    for (const enFile of files) {
      const m = enFile.match(PAIR);
      if (!m || /\.(test|spec)\.ts$/.test(enFile)) {
        continue;
      }
      const cyFile = enFile.replace(PAIR, `$1$2cy.ts`);
      const en = parse(join(repo, enFile));
      const cy = set.has(cyFile) ? parse(join(repo, cyFile)) : null;
      const enExports = exportedObjects(en);
      const cyExports = cy ? exportedObjects(cy) : new Map<string, ts.ObjectLiteralExpression>();
      for (const [name, enObj] of enExports) {
        const cyName = counterpart(name, enExports, cyExports);
        const cyObj = cyName ? cyExports.get(cyName) : undefined;
        const cyLeaves = cyObj ? flatten(cyObj, cy!) : new Map<string, LeafNode>();
        for (const [k, node] of flatten(enObj, en)) {
          const theirs = cyLeaves.get(k);
          leaves.push({
            adapter: "ts-locale-pair",
            enFile,
            cyFile,
            key: `${name}.${k}`,
            path: [cyName ?? name, ...node.path],
            english: node.text,
            welsh: theirs ? theirs.text : null,
            tokens: "js-template",
            line: theirs?.line ?? node.line,
            cyMissing: !cy,
            readOnly: !cy ? "Welsh file does not exist; create it with the same exports first" : !cyObj ? `no matching export in ${cyFile}` : undefined
          });
        }
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
      if (!existsSync(abs)) {
        throw new Error(`${file} does not exist; create it with the same exports as its en file first`);
      }
      let text = readFileSync(abs, "utf8");
      // Replacements first, from the end of the file, so earlier offsets stay valid.
      const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
      const objects = exportedObjects(sf);
      const splices: { start: number; end: number; text: string }[] = [];
      const inserts: Edit[] = [];
      for (const e of list) {
        const [exportName, ...path] = e.leaf.path;
        const obj = objects.get(String(exportName));
        if (!obj) {
          throw new Error(`${file}: no export ${exportName}`);
        }
        const node = flatten(obj, sf).get(path.join("."));
        if (node) {
          splices.push({ start: node.node.getStart(sf), end: node.node.getEnd(), text: literal(e.welsh, node.node) });
        } else {
          inserts.push(e);
        }
      }
      for (const s of splices.sort((a, b) => b.start - a.start)) {
        text = text.slice(0, s.start) + s.text + text.slice(s.end);
      }
      // Missing keys go in one at a time, re-parsing so each sees the last.
      for (const e of inserts) {
        text = insertKey(abs, text, e);
      }
      writeFileSync(abs, text);
      changed.push(file);
    }
    return changed;
  }
};

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

/** `export const x = {...}` (also `as const` / `satisfies`) and `export default {...}`. */
function exportedObjects(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of stmt.declarationList.declarations) {
        const obj = d.initializer && unwrap(d.initializer);
        if (obj && ts.isObjectLiteralExpression(obj) && ts.isIdentifier(d.name)) {
          out.set(d.name.text, obj);
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      const obj = unwrap(stmt.expression);
      if (ts.isObjectLiteralExpression(obj)) {
        out.set("default", obj);
      }
    }
  }
  return out;
}

/** en ↔ cy export names: same name, en→cy swap, a Cy suffix, or the only export on each side. */
function counterpart(name: string, en: Map<string, unknown>, cy: Map<string, unknown>): string | undefined {
  if (cy.has(name)) {
    return name;
  }
  const swapped = name === "en" ? "cy" : name.replace(/En$/, "Cy");
  if (cy.has(swapped)) {
    return swapped;
  }
  if (cy.has(`${name}Cy`)) {
    return `${name}Cy`;
  }
  if (en.size === 1 && cy.size === 1) {
    return [...cy.keys()][0];
  }
  return undefined;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  return e;
}

interface LeafNode {
  path: (string | number)[];
  text: string;
  line: number;
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
}

function flatten(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  prefix: (string | number)[] = [],
  out = new Map<string, LeafNode>()
): Map<string, LeafNode> {
  const visit = (value: ts.Expression, path: (string | number)[]) => {
    const v = unwrap(value);
    const body = ts.isArrowFunction(v) && !ts.isBlock(v.body) ? unwrap(v.body) : v;
    if (ts.isStringLiteral(body) || ts.isNoSubstitutionTemplateLiteral(body) || ts.isTemplateExpression(body)) {
      const text = ts.isTemplateExpression(body) ? body.getText(sf).slice(1, -1) : body.text;
      out.set(path.join("."), { path, text, line: sf.getLineAndCharacterOfPosition(body.getStart(sf)).line + 1, node: body });
    } else if (ts.isObjectLiteralExpression(v)) {
      flatten(v, sf, path, out);
    } else if (ts.isArrayLiteralExpression(v)) {
      for (const [i, el] of v.elements.entries()) {
        visit(el, [...path, i]);
      }
    }
  };
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = propName(prop.name);
      if (name !== null) {
        visit(prop.initializer, [...prefix, name]);
      }
    }
  }
  return out;
}

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * A literal in the same style as the one it replaces; templates stay templates,
 * and Welsh carrying `${…}` always becomes one, or the token would print as-is.
 */
function literal(welsh: string, original: ts.Node): string {
  if (ts.isTemplateExpression(original) || ts.isNoSubstitutionTemplateLiteral(original) || /\$\{/.test(welsh)) {
    return `\`${welsh.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
  }
  const quote = original.getText().startsWith("'") ? "'" : '"';
  const escaped = welsh.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(new RegExp(quote, "g"), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** Add a missing key to the deepest existing object on its path. */
function insertKey(abs: string, text: string, e: Edit): string {
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const [exportName, ...path] = e.leaf.path;
  let obj = exportedObjects(sf).get(String(exportName));
  if (!obj) {
    throw new Error(`${abs}: no export ${exportName}`);
  }
  let depth = 0;
  while (depth < path.length - 1) {
    const prop: ts.PropertyAssignment | undefined = obj.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === String(path[depth])
    );
    const next: ts.Expression | undefined = prop && unwrap(prop.initializer);
    if (!next || !ts.isObjectLiteralExpression(next)) {
      break;
    }
    obj = next;
    depth++;
  }
  if (path.slice(depth).some((p) => typeof p === "number")) {
    throw new Error(`${abs}: cannot add an array element at ${path.join(".")}; edit by hand`);
  }
  const rest = path.slice(depth).map(String);
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  const value = rest.slice(1).reduceRight((acc, k) => `{ ${key(k)}: ${acc} }`, JSON.stringify(e.welsh));
  const indent = guessIndent(text, obj);
  const entry = `${indent}${key(rest[0])}: ${value}`;
  const last = obj.properties[obj.properties.length - 1];
  if (!last) {
    const open = obj.getStart(sf) + 1;
    return `${text.slice(0, open)}\n${entry}\n${text.slice(open)}`;
  }
  const after = last.getEnd();
  const hasComma = text.slice(after).trimStart().startsWith(",");
  const at = hasComma ? text.indexOf(",", after) + 1 : after;
  return `${text.slice(0, at)}${hasComma ? "" : ","}\n${entry}${hasComma ? "," : ""}${text.slice(at)}`;
}

function guessIndent(text: string, obj: ts.ObjectLiteralExpression): string {
  const first = obj.properties[0];
  if (!first) {
    return "  ";
  }
  const lineStart = text.lastIndexOf("\n", first.getStart()) + 1;
  return text.slice(lineStart, first.getStart()).match(/^\s*/)?.[0] ?? "  ";
}
