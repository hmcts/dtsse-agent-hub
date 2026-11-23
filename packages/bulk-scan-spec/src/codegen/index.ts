import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import { envelopeFiles } from "./envelopes.ts";
import { fisFiles } from "./fis.ts";
import type { JavaOptions } from "./java.ts";
import { nfdivFiles, probateFiles } from "./java.ts";
import { codePackage } from "./model.ts";
import { orchestratorFiles } from "./orchestrator.ts";
import { sscsFiles } from "./sscs.ts";

export const TARGETS = ["fis", "sscs", "nfdiv", "probate", "envelopes", "orchestrator"] as const;
export type Target = (typeof TARGETS)[number];

/** What one target writes. The files every target shares, the form's new case fields, are `newCcdFieldFiles`: written once by whoever writes several targets. */
export function generateTarget(target: Target, spec: FormSpec, java: JavaOptions, jurisdiction?: string): OutputFile[] {
  switch (target) {
    case "fis":
      return fisFiles(spec);
    case "sscs":
      return sscsFiles(spec);
    case "nfdiv":
      return nfdivFiles(spec, java);
    case "probate":
      return probateFiles(spec, { ...java, basePackage: codePackage("probate", java.basePackage) });
    case "envelopes":
      return envelopeFiles(spec, { jurisdiction });
    case "orchestrator":
      return orchestratorFiles(spec);
  }
}

export { newCcdFieldFiles } from "./new-ccd-fields.ts";
