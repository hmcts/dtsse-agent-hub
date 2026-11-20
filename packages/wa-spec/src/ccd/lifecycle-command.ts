import { stringify } from "yaml";
import { loadSpecOnly } from "../model-io.ts";
import { readDefinitionDir } from "./definition-files.ts";
import { readCcdDefinition } from "./lifecycle.ts";
import { type Overlay, overlayTasks } from "./overlay.ts";

export interface LifecycleOptions {
  definitionDir: string;
  specPath: string;
  caseType?: string | undefined;
  /** The processor's `-e` patterns; none exclude nothing. */
  exclude?: readonly string[] | undefined;
  /** Values for the `${NAME}` placeholders the definition leaves to the processor. */
  variables?: Record<string, string> | undefined;
  format?: "yaml" | "json" | undefined;
}

/**
 * The overlay of a spec's tasks on each case type of a definition that the spec lists, or on the one named, as YAML or JSON.
 * The case types of the definition that the spec does not list are left out.
 */
export function lifecycleReport(options: LifecycleOptions): string {
  const spec = loadSpecOnly(options.specPath);
  const wanted = options.caseType?.toLowerCase();
  if (wanted && !spec.caseTypes.some((c) => c.id.toLowerCase() === wanted)) {
    throw new Error(`the spec does not list the case type ${options.caseType}`);
  }
  const sources: Record<string, string[]> = {};
  const sheets = readDefinitionDir(options.definitionDir, { exclude: options.exclude ?? [], variables: options.variables ?? {}, sources });
  const lifecycles = readCcdDefinition(
    sheets,
    wanted ? [wanted] : spec.caseTypes.map((c) => c.id),
    (sheet, index) => sources[sheet]?.[index] ?? `${sheet} row ${index + 1}`
  );
  if (lifecycles.length === 0) {
    throw new Error(
      wanted
        ? `${options.definitionDir} has no case type ${options.caseType} that the spec lists`
        : `${options.definitionDir} has none of the spec's case types`
    );
  }
  const report: Record<string, Overlay & { states: number }> = {};
  for (const lifecycle of lifecycles) {
    const overlay = overlayTasks(lifecycle, spec);
    report[lifecycle.caseType] = { states: lifecycle.states.length, ...overlay };
  }
  return options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : stringify(report, { lineWidth: 0 });
}
