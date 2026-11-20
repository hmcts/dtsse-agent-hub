import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import { anchoredPattern, formatPattern, formStem, keyModels } from "./model.ts";

/** Each letter becomes a two-letter class; only the characters that are special outside a class are escaped, so the pattern also compiles under the u flag. */
function caseInsensitive(value: string): string {
  return [...value].map((c) => (/[A-Za-z]/.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : c.replace(/[.*+?^${}()|[\]\\/]/g, (m) => `\\${m}`))).join("");
}

/** A JSON Schema (draft 7) for the form's OCR keys in the layout of sscs-bulk-scan-schema.json: string properties, no extras. */
export function sscsSchema(spec: FormSpec): unknown {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const m of keyModels(spec)) {
    const property: Record<string, unknown> = { type: "string" };
    const patterns: string[] = [];
    if (m.allowed.length > 0) {
      // JSON Schema has no case-insensitive flag, and the Java validator and the TS expectations compare listed values without regard
      // to case. A blank is never a wrong value here: whether one is required is the mandatory checks' business, as in the Java validator.
      patterns.push(`^(?:${[...m.allowed.map(caseInsensitive), ""].join("|")})$`);
    }
    const format = formatPattern(m);
    if (format) {
      patterns.push(`^$|${anchoredPattern(format)}`);
    }
    // A key with both listed values and a format must satisfy both, as in the Java validator.
    if (patterns.length === 1) {
      property.pattern = patterns[0];
    } else if (patterns.length > 1) {
      property.allOf = patterns.map((pattern) => ({ pattern }));
    }
    if (m.maxLength) {
      property.maxLength = m.maxLength;
    }
    properties[m.key] = property;
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema",
    title: spec.form.formType || spec.form.name,
    type: "object",
    properties,
    additionalProperties: false
  };
}

export function sscsFiles(spec: FormSpec): OutputFile[] {
  return [{ path: `sscs/${formStem(spec)}-bulk-scan-schema.json`, content: `${JSON.stringify(sscsSchema(spec), null, 2)}\n` }];
}
