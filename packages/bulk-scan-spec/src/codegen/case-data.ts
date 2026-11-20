import type { FormSpec } from "../schema.ts";
import { allFields } from "../schema.ts";
import type { Data } from "./model.ts";
import { appliedRules, directMappings } from "./model.ts";

/**
 * The CCD case data a submission yields where the spec decides it: keys copied straight across, the assignments of the rules that
 * apply, and composed addresses. English logic the parser could not turn into rules is not run, so a field that depends on it is absent.
 */
export function caseDataFor(spec: FormSpec, data: Data): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  for (const [ccd, key] of directMappings(spec)) {
    const value = data[key];
    if (value) {
      out[ccd] = value;
    }
  }
  for (const field of allFields(spec)) {
    for (const rule of appliedRules(spec, field, data) ?? []) {
      for (const [ccd, assigned] of Object.entries(rule.set ?? {})) {
        const value = assigned !== null && typeof assigned === "object" ? data[assigned.from] : assigned;
        if (value !== undefined && value !== null && value !== "") {
          out[ccd] = String(value);
        }
      }
    }
  }
  for (const compose of spec.composes) {
    const parts = Object.entries(compose.from).flatMap(([part, key]) => (data[key] ? [[part, data[key]] as [string, string]] : []));
    if (parts.length > 0) {
      out[compose.ccd] = Object.fromEntries(parts);
    }
  }
  return out;
}
