import { stringify } from "yaml";
import type { FormSpec } from "../schema.ts";
import { allFields } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import { formStem } from "./model.ts";

/** Keys the orchestrator matches against a case's surnames: the spec's own list, else every readable key ending in a last-name word. */
export function surnameKeys(spec: FormSpec): string[] {
  if (spec.form.surnameKeys?.length) {
    return spec.form.surnameKeys;
  }
  return allFields(spec).flatMap((f) => (f.role === "field" ? f.keys.filter((k) => /(last_?name|surname)$/i.test(k)) : []));
}

/** The `form-type-to-surname-ocr-field-mappings` entry for bulk-scan-orchestrator's `service-config.services`. */
export function surnameMappingYaml(spec: FormSpec): string {
  return stringify([{ formType: spec.form.formType, ocrFields: surnameKeys(spec) }], { lineWidth: 0 });
}

export function orchestratorFiles(spec: FormSpec): OutputFile[] {
  return [{ path: `orchestrator/form-type-to-surname-ocr-field-mappings.${formStem(spec)}.yaml`, content: surnameMappingYaml(spec) }];
}
