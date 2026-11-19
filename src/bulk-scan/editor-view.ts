import { type Data, type FormSpec, TARGETS, type Target, validData } from "@hmcts-cft/bulk-scan-spec";
import { allNotes, checkSpec, envelopeKeys, type FieldNotes, type ScenarioEntry, scenarioEntries } from "./spec.ts";
import type { SpecRecord, VersionEntry } from "./spec-store.ts";

/** Everything the editor page draws for one version of a spec. */
export interface BulkScanEditorView {
  id: string;
  name: string;
  version: number;
  spec: FormSpec;
  /** One per field in the order of the editor's rows. */
  notes: FieldNotes[];
  versions: VersionEntry[];
  scenarios: ScenarioEntry[];
  keys: string[];
  /** The envelope the simulator starts from. */
  sample: Data;
  targets: readonly Target[];
}

/** The stored version as the editor shows it. A stored spec is one that saved, so it reads back unless the schema has moved on since. */
export function bulkScanEditorView(record: SpecRecord): BulkScanEditorView {
  const checked = checkSpec(record.spec);
  if (!checked.ok) {
    throw new Error(`version ${record.version} of ${record.id} no longer reads: ${checked.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  }
  const { spec } = checked;
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    spec,
    notes: allNotes(spec),
    versions: record.versions,
    scenarios: scenarioEntries(spec),
    keys: envelopeKeys(spec),
    sample: validData(spec),
    targets: TARGETS
  };
}
