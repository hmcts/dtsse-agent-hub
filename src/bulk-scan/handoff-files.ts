import { type FormSpec, generateTarget, newCcdFieldFiles } from "@hmcts-cft/bulk-scan-spec";
import { newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { HttpError } from "../agent-api/http.ts";
import { type HandoffNames, type HandoffTarget, handoffRefusal } from "./handoff.ts";
import { codeDownload, type Download, newFieldsDownload, specJsonDownload, transformDownload } from "./spec.ts";

/**
 * The files a hand-over attaches: the target's code with the generated envelopes and the orchestrator's surname mapping
 * in the one zip, the spec, the transformation sheet, and the new case fields when the form has any. A message carries
 * four files, so the case data snippet stays in the zip rather than beside it. The new case fields are worked out once
 * and given back for the prompt.
 */
export async function handoffFiles(
  spec: FormSpec,
  target: HandoffTarget,
  javaPackage: string
): Promise<{ files: Download[]; names: HandoffNames; newFields: { id: string; type: string }[] }> {
  const options = { basePackage: javaPackage };
  const orchestrator = generateTarget("orchestrator", spec, options);
  const mapping = orchestrator[0];
  if (mapping === undefined) {
    throw new HttpError(422, "the orchestrator's surname mapping could not be generated");
  }
  const envelopes = generateTarget("envelopes", spec, options).map((f) => ({ path: `envelopes/${f.path}`, content: f.content }));
  const fieldFiles = newCcdFieldFiles(spec);
  const code = codeDownload(spec, target, javaPackage, [...envelopes, ...orchestrator], fieldFiles);
  const sheet = await transformDownload(spec);
  const specFile = specJsonDownload(spec);
  const newFields = newFieldsDownload(fieldFiles);
  const files = [code, specFile, sheet, ...(newFields ? [newFields] : [])];
  const refusal = handoffRefusal(files);
  if (refusal !== null) {
    throw new HttpError(413, `This cannot be handed over: ${refusal}.`);
  }
  return {
    files,
    names: {
      code: code.fileName,
      spec: specFile.fileName,
      sheet: sheet.fileName,
      ...(newFields ? { newFields: newFields.fileName } : {}),
      orchestrator: mapping.path
    },
    newFields: newCcdFields(spec)
  };
}
