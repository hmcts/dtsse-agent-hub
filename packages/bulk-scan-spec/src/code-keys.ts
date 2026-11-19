import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { byCode } from "./compare.ts";

export const PATTERNS = ["nfdiv", "probate", "sscs", "fis"] as const;
export type Pattern = (typeof PATTERNS)[number];

export interface CodeKey {
  key: string;
  /** Set when the Java field name differs from the key Jackson reads, so the key is an explicit alias. */
  alias?: { field: string };
}

const MODIFIERS = new Set(["private", "protected", "public", "static", "final", "transient", "volatile"]);

/**
 * The OCR keys a Jackson POJO accepts: each non-static, non-transient field of the top-level class, under its @JsonProperty name
 * when it has one. Comments are removed first; the body of a method or nested class is skipped by brace depth.
 */
export function javaPojoKeys(source: string): CodeKey[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  const keys: CodeKey[] = [];
  let depth = 0;
  let statement = "";
  for (const c of text) {
    if (c === "{") {
      depth++;
      statement = "";
    } else if (c === "}") {
      depth--;
      statement = "";
    } else if (depth !== 1) {
    } else if (c !== ";") {
      statement += c;
    } else {
      const alias = /@JsonProperty\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/.exec(statement)?.[1];
      const declaration = statement.replace(/@\w+(?:\s*\([^)]*\))?/g, " ").split("=")[0] ?? "";
      const words = declaration.split(/\s+/).filter(Boolean);
      const rest = words.filter((w) => !MODIFIERS.has(w));
      const field = rest.at(-1);
      if (field && /^\w+$/.test(field) && rest.length >= 2 && !words.includes("static") && !words.includes("transient")) {
        keys.push(alias && alias !== field ? { key: alias, alias: { field } } : { key: field });
      }
      statement = "";
    }
  }
  return keys;
}

/** Property names of a JSON Schema's top-level `properties`. */
export function jsonSchemaKeys(source: string): CodeKey[] {
  const schema = JSON.parse(source) as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {}).map((key) => ({ key }));
}

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walk(value, visit);
    }
  }
}

function strings(node: unknown, into: string[]): void {
  if (typeof node === "string") {
    into.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) {
      strings(item, into);
    }
  } else if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) {
      strings(value, into);
    }
  }
}

/** fis `application-<form>-form.yaml`: mandatory, optional and regex-validated field names. */
export function fisFormKeys(source: string): CodeKey[] {
  const found: string[] = [];
  walk(parse(source), (key, value) => {
    if (key === "mandatoryFields" || key === "optionalFields" || key === "fieldNames") {
      strings(value, found);
    }
  });
  return found.filter((k) => k.trim() !== "").map((key) => ({ key }));
}

/** fis `application-<form>-transform.yaml`: the OCR field names on the right of each `caseDataFields` mapping. */
export function fisTransformKeys(source: string): CodeKey[] {
  const found: string[] = [];
  walk(parse(source), (key, value) => {
    if (key === "caseDataFields") {
      strings(value, found);
    }
  });
  return found.filter((k) => /^[A-Za-z][A-Za-z0-9_]*$/.test(k)).map((key) => ({ key }));
}

/** A key named in both the form and the transform YAML is one key. */
function dedupe(keys: CodeKey[]): CodeKey[] {
  return [...new Map(keys.map((k) => [k.key, k])).values()];
}

function filesIn(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path)
    .filter((f) => /^application-.*-(form|transform)\.ya?ml$/.test(f))
    .sort(byCode)
    .map((f) => join(path, f));
}

/** Reads the keys a service accepts from its code or config; fis accepts a directory of form/transform YAML. */
export function loadCodeKeys(pattern: Pattern, path: string): CodeKey[] {
  switch (pattern) {
    case "nfdiv":
    case "probate":
      return javaPojoKeys(readFileSync(path, "utf8"));
    case "sscs":
      return jsonSchemaKeys(readFileSync(path, "utf8"));
    case "fis":
      return dedupe(
        filesIn(path).flatMap((file) => {
          const source = readFileSync(file, "utf8");
          return /transform\.ya?ml$/.test(file) ? fisTransformKeys(source) : fisFormKeys(source);
        })
      );
  }
}
