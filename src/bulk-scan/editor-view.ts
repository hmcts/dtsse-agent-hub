import { type Data, type FormSpec, formSpecSchema, TARGETS, type Target, validData } from "@hmcts-cft/bulk-scan-spec";
import { envelopeKeys, type ScenarioEntry, scenarioEntries } from "./spec.ts";
import type { SpecRecord, VersionEntry } from "./spec-store.ts";

/** Everything the editor page draws for one version of a spec. */
export interface BulkScanEditorView {
  id: string;
  name: string;
  version: number;
  spec: FormSpec;
  versions: VersionEntry[];
  scenarios: ScenarioEntry[];
  keys: string[];
  /** The envelope the simulator starts from. */
  sample: Data;
  targets: readonly Target[];
  /** Why the simulator is off for this version, when the engine could not build its scenarios; the rest of the page still works. */
  simulatorProblem: string | null;
}

/** The stored version as the editor shows it. A stored spec is one that saved, so it reads back unless the schema has moved on since. */
export function bulkScanEditorView(record: SpecRecord): BulkScanEditorView {
  const parsed = formSpecSchema.safeParse(record.spec);
  if (!parsed.success) {
    throw new Error(`version ${record.version} of ${record.id} no longer reads: ${parsed.error.message}`);
  }
  const spec = parsed.data;
  let simulator: Pick<BulkScanEditorView, "scenarios" | "keys" | "sample" | "simulatorProblem">;
  try {
    simulator = { scenarios: scenarioEntries(spec), keys: envelopeKeys(spec), sample: validData(spec), simulatorProblem: null };
  } catch (error) {
    simulator = { scenarios: [], keys: [], sample: {}, simulatorProblem: error instanceof Error ? error.message : String(error) };
  }
  return { id: record.id, name: record.name, version: record.version, spec, versions: record.versions, targets: TARGETS, ...simulator };
}
