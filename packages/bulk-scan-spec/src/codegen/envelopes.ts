import type { FormSpec } from "../schema.ts";
import type { Data } from "./model.ts";
import type { Scenario } from "./scenarios.ts";
import { scenarios } from "./scenarios.ts";

export interface OutputFile {
  path: string;
  content: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function ocrFields(data: Data): { name: string; value: string }[] {
  return Object.entries(data).map(([name, value]) => ({ name, value }));
}

export function metadataFile(data: Data): { Metadata_file: { metadata_field_name: string; metadata_field_value: string }[] } {
  return { Metadata_file: Object.entries(data).map(([metadata_field_name, metadata_field_value]) => ({ metadata_field_name, metadata_field_value })) };
}

/** An Exela envelope's metadata.json, in the shape of the Private Law C100 samples, carrying the form's OCR as base64 `ocr_data`. */
export function exelaEnvelope(spec: FormSpec, s: Scenario, poBox = "PO-BOX", jurisdiction = "JURISDICTION"): unknown {
  const stamp = "2025-01-28T14:20:22.123Z";
  return {
    envelope_classification: "new_application",
    po_box: spec.form.poBox ?? poBox,
    jurisdiction,
    delivery_date: stamp,
    opening_date: stamp,
    zip_file_createddate: stamp,
    zip_file_name: `${s.name}.test.zip`,
    scannable_items: [
      {
        document_control_number: "257931235453134",
        document_type: spec.form.documentType ?? "Form",
        document_sub_type: spec.form.formType,
        scanning_date: stamp,
        ocr_accuracy: null,
        manual_intervention: null,
        next_action: "Destroy",
        next_action_date: stamp,
        ocr_data: Buffer.from(JSON.stringify(metadataFile(s.data))).toString("base64"),
        file_name: `${s.name}.pdf`,
        notes: null
      }
    ],
    payments: []
  };
}

export function envelopeFiles(spec: FormSpec, options: { jurisdiction?: string } = {}): OutputFile[] {
  const list = scenarios(spec);
  const files: OutputFile[] = [];
  for (const s of list) {
    files.push({ path: `validate-ocr/${s.name}.json`, content: json({ ocr_data_fields: ocrFields(s.data) }) });
    files.push({ path: `metadata-file/${s.name}.json`, content: json(metadataFile(s.data)) });
    files.push({ path: `exela/${s.name}/metadata.json`, content: json(exelaEnvelope(spec, s, undefined, options.jurisdiction)) });
  }
  files.push({
    path: "manifest.json",
    content: json(list.map((s) => ({ name: s.name, kind: s.kind, description: s.description, expected: s.expected, formType: spec.form.formType })))
  });
  return files;
}
