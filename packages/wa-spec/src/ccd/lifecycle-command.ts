import { stringify } from "yaml";
import { loadSpecOnly } from "../model-io.ts";
import { readDefinitionDir } from "./definition-files.ts";
import { readCcdDefinition } from "./lifecycle.ts";
import { type Overlay, overlayTasks } from "./overlay.ts";

export interface LifecycleOptions {
  definitionDir: string;
  specPath: string;
  caseType?: string | undefined;
  environment?: "prod" | "nonprod" | undefined;
  format?: "yaml" | "json" | undefined;
}

/**
 * The overlay of a spec's tasks on each case type of a definition that the spec lists, or on the one named, as YAML or JSON.
 * The case types of the definition that the spec does not list are left out.
 */
export function lifecycleReport(options: LifecycleOptions): string {
  const spec = loadSpecOnly(options.specPath);
  const wanted = options.caseType?.toLowerCase();
  const lifecycles = readCcdDefinition(readDefinitionDir(options.definitionDir, options.environment)).filter((l) => {
    const id = l.caseType.toLowerCase();
    return wanted ? id === wanted : spec.caseTypes.some((c) => c.id.toLowerCase() === id);
  });
  if (lifecycles.length === 0) {
    throw new Error(
      wanted
        ? `${options.definitionDir} has no case type ${options.caseType} that the spec lists`
        : `${options.definitionDir} has none of the spec's case types`
    );
  }
  const report: Record<string, Overlay & { states: number; events: Overlay["events"] }> = {};
  for (const lifecycle of lifecycles) {
    const overlay = overlayTasks(lifecycle, spec);
    report[lifecycle.caseType] = { states: lifecycle.states.length, ...overlay };
  }
  return options.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : stringify(report, { lineWidth: 0 });
}
