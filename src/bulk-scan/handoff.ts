import type { FormSpec, Target } from "@hmcts-cft/bulk-scan-spec";
import { codePackage, formStemOf } from "@hmcts-cft/bulk-scan-spec/model";
import { describeBytes, MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "../assistant/uploads.ts";
import type { VersionEntry } from "./spec-store.ts";

/**
 * Handing a signed-off form to the Assistant: the files it is given and the message that asks for the service's pull
 * request. Pure, so the builder's browser code and its server action share one answer to which target a form starts on.
 */

/** The targets that write a service's own code; the envelopes and the orchestrator mapping travel in the same zip. */
export const HANDOFF_TARGETS = ["nfdiv", "fis", "sscs", "probate"] as const satisfies readonly Target[];
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

export function isHandoffTarget(value: unknown): value is HandoffTarget {
  return typeof value === "string" && (HANDOFF_TARGETS as readonly string[]).includes(value);
}

/** The targets whose code is Java in a package the person names. */
export const JAVA_TARGETS: readonly string[] = ["nfdiv", "probate"];
export const DEFAULT_JAVA_PACKAGE = "com.example.bulkscan";

/**
 * The CCD case types fis-bulk-scan-api transforms: those its `application-*-transform.yaml` files write as
 * `CASE_TYPE_ID`. PRLAPPS is the orchestrator's `privatelaw` service and is defined by the prl and fis products; A58, A59,
 * A60 and C51 are the adoption and FIS edge cases. Whatever product defines one, its bulk scan is handled there.
 */
export const FIS_BULK_SCAN_CASE_TYPES: readonly string[] = ["PRLAPPS", "A58", "A59", "A60", "C51"];

/** The repository that holds fis-bulk-scan-api's config-driven transformations. */
export const FIS_BULK_SCAN_REPO = "apps/fis/fis-bulk-scan-api";

const servedByFisBulkScan = (header: Pick<FormSpec["form"], "ccdCaseTypeId">): boolean =>
  header.ccdCaseTypeId !== undefined && FIS_BULK_SCAN_CASE_TYPES.includes(header.ccdCaseTypeId);

/** The code pattern a form's case type calls for: fis for those fis-bulk-scan-api transforms, its own for sscs and probate, and the config-generator pattern for every other service. */
export function defaultHandoffTarget(header: Pick<FormSpec["form"], "ccdCaseTypeId" | "ccdProduct">): HandoffTarget {
  if (servedByFisBulkScan(header)) {
    return "fis";
  }
  return header.ccdProduct === "sscs" || header.ccdProduct === "probate" ? header.ccdProduct : "nfdiv";
}

/** Whether version `version` has been signed off. A saved version that has not been is not one. */
export function isSignedOff(versions: readonly Pick<VersionEntry, "version" | "signedOffAt">[], version: number): boolean {
  return versions.some((v) => v.version === version && v.signedOffAt !== null);
}

/** The longest a form's name or type is written into the prompt. */
const MAX_NAMED = 100;
export const clip = (text: string): string => [...text.trim()].slice(0, MAX_NAMED).join("");

export const NO_FORM_TYPE = "Set the form type (document_sub_type) in Form details first.";

/** Why the form type cannot be handed over, in words for the person, or `null`: it is blank, or the generated files cannot be named after it. */
export function formTypeProblem(formType: string): string | null {
  if (formType.trim() === "") {
    return NO_FORM_TYPE;
  }
  try {
    formStemOf(formType);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const NOT_SIGNED_OFF = "Sign off this version first: only a signed-off version can be handed to the Assistant, and a saved one is not enough.";

/** The names the prompt refers to the attached files by. */
export interface HandoffNames {
  code: string;
  spec: string;
  sheet: string;
  /** Absent when the form needs no new case fields. */
  newFields?: string;
  /** Where the orchestrator's surname mapping is in the code zip. */
  orchestrator: string;
}

const LISTED_FIELDS = 8;

/** The ids of `items` as the prompt lists them: the first few with their types, then how many more. */
function listed(items: readonly { id: string; type: string }[]): string {
  const shown = items.slice(0, LISTED_FIELDS).map((f) => `${f.id} (${f.type})`);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Where the PR goes. fis-bulk-scan-api for the case types it transforms. Otherwise `ccdRepo`, the repository that holds the
 * case type's CCD definition: the service itself for a config-generator product, but for a JSON product a
 * definition-only repository, whose service is elsewhere.
 */
function serviceLine(header: FormSpec["form"]): string {
  const caseType = header.ccdCaseTypeId ? `the CCD case type ${header.ccdCaseTypeId}` : "the form's case type";
  const product = header.ccdProduct ? ` (product ${header.ccdProduct})` : "";
  if (servedByFisBulkScan(header)) {
    const definition = header.ccdRepo ? ` The CCD definition is in ${header.ccdRepo}.` : "";
    return `${caseType.charAt(0).toUpperCase()}${caseType.slice(1)}${product} is transformed by ${FIS_BULK_SCAN_REPO}, which holds the config-driven transformations, so that is the service repo.${definition}`;
  }
  if (header.ccdRepo && header.ccdConfig === "config-generator") {
    return `${caseType.charAt(0).toUpperCase()}${caseType.slice(1)}${product} is defined in ${header.ccdRepo}, a config-generator service, so that repo is the service repo.`;
  }
  const find = `Find the service repo that handles this product's bulk-scan callbacks, from the product's repos in apps/${header.ccdProduct ?? "<product>"}/AGENTS.md and the service-config in apps/bulk-scan/bulk-scan-orchestrator, and open the PR there.`;
  if (header.ccdRepo) {
    return `The CCD definition for ${caseType}${product} is in ${header.ccdRepo}, which holds the definition and may not be the service. ${find}`;
  }
  if (header.ccdCaseTypeId) {
    return `The form maps into ${caseType}${product}. Find the repo that defines it in the workspace. ${find}`;
  }
  return "No case type was picked for this form, so find the service it belongs to in the workspace from the form's name and the spec, and ask me if more than one fits.";
}

/** The first message of the hand-over: what the form is, where the PR goes, what it contains and what is left for the Assistant to decide. */
export function handoffPrompt(input: {
  spec: FormSpec;
  version: number;
  target: HandoffTarget;
  javaPackage: string;
  names: HandoffNames;
  newFields: readonly { id: string; type: string }[];
}): string {
  const { spec, version, target, javaPackage, names, newFields: added } = input;
  const header = spec.form;
  const fields = added.filter((f) => !f.id.includes("."));
  const members = added.filter((f) => f.id.includes("."));
  const snippet = header.ccdConfig === "config-generator" && fields.length > 0;
  const newFieldSteps = [
    fields.length > 0
      ? `Adds the ${plural(fields.length, "new CCD case field", "new CCD case fields")} under \`fields\` in ${names.newFields ?? "new-ccd-fields.json"}: ${listed(fields)}.${snippet ? " new-case-data-fields.java.txt in the zip has them as CaseData declarations." : ""}`
      : null,
    members.length > 0
      ? `Adds the ${plural(members.length, "new member", "new members")} of existing complex types under \`complexMembers\` in ${names.newFields ?? "new-ccd-fields.json"}, to the type of the parent field: ${listed(members)}.`
      : null
  ].filter((step) => step !== null);
  const steps = [
    `Registers form type ${clip(header.formType)} with the service's validate-ocr and transformation endpoints, following the repo's existing bulk-scan code. If the repo has none, say so in the PR and add the endpoints new.`,
    `Adds the generated validator and transformer: the ${target} code in ${names.code}${JAVA_TARGETS.includes(target) ? `, written in the Java package ${codePackage(target, javaPackage)}, which moves to the service's own base package` : ""}.`,
    ...(newFieldSteps.length > 0 ? newFieldSteps : ["Adds no case fields: every field the form maps to already exists."]),
    "Crafts the exception-record case type definition for the service. That is not generated: write it to fit the service.",
    "Adds the generated envelopes (envelopes/ in the zip) as test fixtures, after replacing the JURISDICTION placeholder in them with the service's bulk-scan jurisdiction (from the orchestrator's service-config and the bulk-scan processor's container mapping)."
  ];
  return [
    `Hand over the Bulk Scan form "${clip(header.name) || clip(header.formType)}" (form type ${clip(header.formType)}), signed off as version ${version}. Its generated code and its spec are attached.`,
    serviceLine(header),
    "In the service repo, open a draft PR that:",
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    `Then open the orchestrator's surname mapping, ${names.orchestrator} in the zip, as a separate draft PR in apps/bulk-scan/bulk-scan-orchestrator.`,
    `The generated code marks what it could not decide as TODO(sheet …). Resolve each from ${names.spec} and ${names.sheet}, or leave a clear note about it in the PR.`
  ].join("\n");
}

/**
 * Why the files cannot go on one message, or `null`. The limits are the Assistant's own: a message carries a few files,
 * each of a bounded size. A new conversation's allowance for all its files is more than that many files of that size, so
 * it cannot be passed here. Checked before any of them is stored.
 */
export function handoffRefusal(files: readonly { fileName: string; bytes: { byteLength: number } }[]): string | null {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} files, and this hand-over has ${files.length}`;
  }
  const empty = files.find((f) => f.bytes.byteLength === 0);
  if (empty) {
    return `${empty.fileName} is empty`;
  }
  const large = files.find((f) => f.bytes.byteLength > MAX_UPLOAD_BYTES);
  if (large) {
    return `${large.fileName} is ${describeBytes(large.bytes.byteLength)}, over the ${describeBytes(MAX_UPLOAD_BYTES)} a file may be`;
  }
  return null;
}
