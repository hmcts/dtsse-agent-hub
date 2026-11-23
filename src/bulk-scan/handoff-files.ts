import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { generateTarget } from "@hmcts-cft/bulk-scan-spec";
import { HttpError } from "../agent-api/http.ts";
import { type HandoffNames, type HandoffTarget, handoffRefusal } from "./handoff.ts";
import { codeDownload, type Download, newFieldsDownload, specJsonDownload, transformDownload } from "./spec.ts";

/**
 * The files a hand-over attaches: the target's code with the generated envelopes and the orchestrator's surname mapping
 * in the one zip, the spec, the transformation sheet, and the new case fields when the form has any. A message carries
 * four files, so the case data snippet stays in the zip rather than beside it.
 */
export async function handoffFiles(spec: FormSpec, target: HandoffTarget, javaPackage: string): Promise<{ files: Download[]; names: HandoffNames }> {
  const mappings: string[] = [];
  const code = codeDownload(spec, target, javaPackage, (made) => {
    const orchestrator = generateTarget("orchestrator", made, { basePackage: javaPackage });
    mappings.push(...orchestrator.map((f) => f.path));
    return [
      ...generateTarget("envelopes", made, { basePackage: javaPackage }).map((f) => ({ path: `envelopes/${f.path}`, content: f.content })),
      ...orchestrator
    ];
  });
  const sheet = await transformDownload(spec);
  const specFile = specJsonDownload(spec);
  const newFields = newFieldsDownload(spec);
  const files = [code, specFile, sheet, ...(newFields ? [newFields] : [])];
  const refusal = handoffRefusal(files);
  if (refusal !== null) {
    throw new HttpError(413, `This cannot be handed over: ${refusal}.`);
  }
  const orchestrator = mappings[0];
  if (orchestrator === undefined) {
    throw new HttpError(422, "the orchestrator's surname mapping could not be generated");
  }
  return {
    files,
    names: {
      code: code.fileName,
      spec: specFile.fileName,
      sheet: sheet.fileName,
      ...(newFields ? { newFields: newFields.fileName } : {}),
      orchestrator
    }
  };
}
