import type { FormSpec, Target } from "@hmcts-cft/bulk-scan-spec";
import { newCcdFields } from "@hmcts-cft/bulk-scan-spec/ccd-match";
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
 * The products whose bulk scan goes through fis-bulk-scan-api: the orchestrator's `privatelaw` service
 * (case type PRLAPPS, the prl product) transforms there, and its form transformations also write the FIS edge-case
 * case types A58, A59, A60 and C51, which the fis product defines. The adoption product's own case type, ADOPTION, is
 * not served by it.
 */
const FIS_BULK_SCAN_PRODUCTS: readonly string[] = ["fis", "prl"];

/** The code pattern a form's product calls for: fis for those served by fis-bulk-scan-api, its own for sscs and probate, and the config-generator pattern for every other service. */
export function defaultHandoffTarget(header: Pick<FormSpec["form"], "ccdProduct">): HandoffTarget {
  const { ccdProduct } = header;
  if (ccdProduct !== undefined && FIS_BULK_SCAN_PRODUCTS.includes(ccdProduct)) {
    return "fis";
  }
  return ccdProduct === "sscs" || ccdProduct === "probate" ? ccdProduct : "nfdiv";
}

/** Whether version `version` has been signed off. A saved version that has not been is not one. */
export function isSignedOff(versions: readonly Pick<VersionEntry, "version" | "signedOffAt">[], version: number): boolean {
  return versions.some((v) => v.version === version && v.signedOffAt !== null);
}

/** The longest a form's name or type is written into the prompt. */
const MAX_NAMED = 100;
export const clip = (text: string): string => [...text.trim()].slice(0, MAX_NAMED).join("");

export const NO_FORM_TYPE = "Set the form type (document_sub_type) in Form details first.";

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
 * Where the PR goes. `ccdRepo` is the repository that holds the case type's CCD definition: the service itself for a
 * config-generator product, but for a JSON product a definition-only repository, whose service is elsewhere.
 */
function serviceLine(header: FormSpec["form"]): string {
  const caseType = header.ccdCaseTypeId ? `the CCD case type ${header.ccdCaseTypeId}` : "the form's case type";
  const product = header.ccdProduct ? ` (product ${header.ccdProduct})` : "";
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
export function handoffPrompt(input: { spec: FormSpec; version: number; target: HandoffTarget; javaPackage: string; names: HandoffNames }): string {
  const { spec, version, target, javaPackage, names } = input;
  const header = spec.form;
  const added = newCcdFields(spec);
  const fields = added.filter((f) => !f.id.includes("."));
  const members = added.filter((f) => f.id.includes("."));
  const snippet = header.ccdConfig === "config-generator" && fields.length > 0;
  const newFields = [
    fields.length > 0
      ? `Adds the ${plural(fields.length, "new CCD case field", "new CCD case fields")} under \`fields\` in ${names.newFields ?? "new-ccd-fields.json"}: ${listed(fields)}.${snippet ? " new-case-data-fields.java.txt in the zip has them as CaseData declarations." : ""}`
      : null,
    members.length > 0
      ? `Adds the ${plural(members.length, "new member", "new members")} of existing complex types under \`complexMembers\` in ${names.newFields ?? "new-ccd-fields.json"}, to the type of the parent field: ${listed(members)}.`
      : null
  ].filter((step) => step !== null);
  const steps = [
    `Registers form type ${clip(header.formType)} with the service's validate-ocr and transformation endpoints, following the repo's existing bulk-scan code. If the repo has none, say so in the PR and add the endpoints new.`,
    `Adds the generated validator and transformer: the ${target} code in ${names.code}${JAVA_TARGETS.includes(target) ? `, written in the Java package ${javaPackage}, which moves to the service's own base package` : ""}.`,
    ...(newFields.length > 0 ? newFields : ["Adds no case fields: every field the form maps to already exists."]),
    "Crafts the exception-record case type definition for the service. That is not generated: write it to fit the service.",
    "Adds the generated envelopes (envelopes/ in the zip) as test fixtures."
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
