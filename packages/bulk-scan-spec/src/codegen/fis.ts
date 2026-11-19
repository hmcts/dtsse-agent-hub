import { stringify } from "yaml";
import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import { anchoredPattern, DATE_PARTS, directMappings, FORMAT_REGEXES, formatPattern, formStem, keyModels, keysByCcd } from "./model.ts";

const FORMAT_FIELDS: Record<string, string> = {
  [FORMAT_REGEXES.email]: "emailFields",
  [FORMAT_REGEXES.postcode]: "postcodeFields",
  [FORMAT_REGEXES.phone]: "phoneNumberFields",
  [FORMAT_REGEXES.numeric]: "numericFields",
  [DATE_PARTS.day]: "dayFields",
  [DATE_PARTS.month]: "monthFields",
  [DATE_PARTS.year]: "yearFields"
};

function yamlFor(root: Record<string, unknown>): string {
  return stringify(root, { lineWidth: 0 });
}

/** `application-<form>-form.yaml`: mandatory and optional keys, and the format checks the shared `formatPattern` gives each key. */
export function fisFormYaml(spec: FormSpec): string {
  const models = keyModels(spec);
  const regexFields: Record<string, { fieldNames: string[]; regex: string }> = {};
  const sharedNames = new Set(Object.values(FORMAT_FIELDS));
  for (const m of models) {
    const pattern = formatPattern(m);
    if (!pattern) {
      continue;
    }
    const regex = anchoredPattern(pattern);
    let name = FORMAT_FIELDS[pattern];
    if (!name) {
      // A custom regex gets a bucket of its own, never one of the shared names, and keys with the same regex share it.
      name = Object.entries(regexFields).find(([n, b]) => !sharedNames.has(n) && b.regex === regex)?.[0];
      for (let n = 1; !name; n++) {
        const candidate = `${m.key}Custom${n === 1 ? "" : n}Fields`;
        if (!(candidate in regexFields) && !sharedNames.has(candidate)) {
          name = candidate;
        }
      }
    }
    const bucket = regexFields[name] ?? { fieldNames: [], regex };
    regexFields[name] = bucket;
    if (bucket.regex !== regex) {
      throw new Error(`regex bucket ${name} would hold two different regexes`);
    }
    bucket.fieldNames.push(m.key);
  }
  return yamlFor({
    uk: {
      gov: {
        hmcts: {
          "form-validation": {
            caseTypeofApplication: {
              [spec.form.formType.toUpperCase()]: {
                mandatoryFields: models.filter((m) => m.mandatory).map((m) => m.key),
                optionalFields: models.filter((m) => !m.mandatory).map((m) => m.key),
                regexValidationFields: regexFields
              }
            }
          }
        }
      }
    }
  });
}

export interface FisTransform {
  yaml: string;
  /** CCD fields the flat OCR-to-CCD mapping cannot express: several keys feed one field, or the logic is not a pass-through. */
  unmapped: { ccd: string; keys: string[]; reason: string }[];
}

export function fisTransformYaml(spec: FormSpec): FisTransform {
  const direct = directMappings(spec);
  const caseDataFields: Record<string, string> = Object.fromEntries(direct);
  const unmapped: FisTransform["unmapped"] = [];
  const byCcd = keysByCcd(spec);
  for (const [ccd, keys] of byCcd) {
    if (direct.has(ccd)) {
      continue;
    }
    unmapped.push({
      ccd,
      keys: [...keys],
      reason: keys.size === 0 ? "no OCR key" : keys.size > 1 ? "several keys feed one CCD field" : "a rule or free-text logic transforms the value"
    });
  }
  const yaml = yamlFor({
    uk: {
      gov: {
        hmcts: {
          transform: {
            caseTypeofApplication: {
              [spec.form.formType.toUpperCase()]: {
                caseFields: { CASE_TYPE_ID: spec.form.ccdCaseTypeId ?? "TODO_CASE_TYPE", EVENT_ID: spec.form.ccdEventId ?? "TODO_EVENT" },
                caseDataFields
              }
            }
          }
        }
      }
    }
  });
  return { yaml, unmapped };
}

export function fisFiles(spec: FormSpec): OutputFile[] {
  const name = formStem(spec);
  const transform = fisTransformYaml(spec);
  return [
    { path: `fis/application-${name}-form.yaml`, content: fisFormYaml(spec) },
    { path: `fis/application-${name}-transform.yaml`, content: transform.yaml },
    { path: `fis/unmapped-ccd-fields.json`, content: `${JSON.stringify(transform.unmapped, null, 2)}\n` }
  ];
}
