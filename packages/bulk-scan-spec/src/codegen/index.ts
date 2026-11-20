import type { FormSpec } from "../schema.ts";
import type { OutputFile } from "./envelopes.ts";
import { envelopeFiles } from "./envelopes.ts";
import { fisFiles } from "./fis.ts";
import type { JavaOptions } from "./java.ts";
import { nfdivFiles, probateFiles } from "./java.ts";
import { orchestratorFiles } from "./orchestrator.ts";
import { sscsFiles } from "./sscs.ts";

export const TARGETS = ["fis", "sscs", "nfdiv", "probate", "envelopes", "orchestrator"] as const;
export type Target = (typeof TARGETS)[number];

export function generateTarget(target: Target, spec: FormSpec, java: JavaOptions, jurisdiction?: string): OutputFile[] {
  switch (target) {
    case "fis":
      return fisFiles(spec);
    case "sscs":
      return sscsFiles(spec);
    case "nfdiv":
      return nfdivFiles(spec, java);
    case "probate":
      return probateFiles(spec, { ...java, basePackage: java.basePackage.replace(/\.bulkscan$/, "") });
    case "envelopes":
      return envelopeFiles(spec, { jurisdiction });
    case "orchestrator":
      return orchestratorFiles(spec);
  }
}
