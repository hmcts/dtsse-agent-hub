import { z } from "zod";

/** How a service configures CCD, as the workspace's case type list says. */
export const CCD_CONFIGS = ["config-generator", "json", "hybrid"] as const;
export type CcdConfig = (typeof CCD_CONFIGS)[number];

export const OUTCOMES = ["success", "warning", "exception"] as const;
export const outcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof outcomeSchema>;

const scalarSchema = z.union([z.string(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalarSchema>;

/** A value a key is compared with: a literal, its negation, or whether it counts as ticked in the key's own value set. */
const operandSchema = z.union([scalarSchema, z.object({ not: scalarSchema }), z.object({ ticked: z.boolean() })]);
export type Operand = z.infer<typeof operandSchema>;

export function isNegation(o: Operand): o is { not: Scalar } {
  return o !== null && typeof o === "object" && "not" in o;
}

export function isTickedTest(o: Operand): o is { ticked: boolean } {
  return o !== null && typeof o === "object" && "ticked" in o;
}

/** A value written to a CCD field: a literal, or the value of an OCR key passed through. */
const assignmentSchema = z.union([scalarSchema, z.object({ from: z.string() })]);
export type Assignment = z.infer<typeof assignmentSchema>;

export const ruleSchema = z
  .object({
    /** The label the sheet gives this branch, e.g. "1" or "2a", which its case path is keyed by. */
    ref: z.string().optional(),
    /** Every entry must hold. Absent on the catch-all branch. A key is an OCR key, a sheet id such as "2.4" that could not be resolved, or "ccd:<id>" for a value the row itself writes. */
    when: z.record(z.string(), operandSchema).optional(),
    /** Alternatives joined by OR; each is a conjunction like `when`. */
    whenAny: z.array(z.record(z.string(), operandSchema)).optional(),
    otherwise: z.boolean().optional(),
    set: z.record(z.string(), assignmentSchema).optional(),
    outcome: outcomeSchema.optional(),
    /** Sheet wording attached to the branch, such as "(WITH WARNING)" or "(just pass it through)". */
    note: z.string().optional(),
    /** English the parser could not turn into conditions or assignments, kept verbatim; the rule's field carries a TODO for it. */
    action: z.string().optional(),
    /** The branch follows the previous one directly, without an ELSE, so it starts a chain of its own. */
    independent: z.boolean().optional()
  })
  // A rule with an empty condition would test nothing; a branch that tests nothing has no `when`.
  .refine((r) => !r.when || Object.keys(r.when).length > 0, { message: "when must name at least one key" })
  .refine((r) => !r.whenAny || (r.whenAny.length > 0 && r.whenAny.every((g) => Object.keys(g).length > 0)), {
    message: "whenAny must list non-empty alternatives"
  });
export type Rule = z.infer<typeof ruleSchema>;

export const INPUT_TYPES = ["text", "checkbox", "date", "qr", "none"] as const;
export const MANDATORY = ["mandatory", "optional", "conditional", "not-read"] as const;

export const groupSchema = z.object({
  kind: z.literal("xor"),
  /** The `n` of the sheet's `XoR (n)`. */
  size: z.number().int().nonnegative(),
  options: z.array(z.object({ key: z.string(), label: z.string().optional() }))
});
export type Group = z.infer<typeof groupSchema>;

export const TRANSFORM_COLUMNS = [
  "id",
  "label",
  "dataType",
  "mandatory",
  "validationRule",
  "defaultValue",
  "description",
  "tagName",
  "businessRules",
  "ccd",
  "logic",
  "casePath"
] as const;
export type TransformColumn = (typeof TRANSFORM_COLUMNS)[number];

export const emitSchema = z.object({
  /** The sheet's words introducing this value, e.g. "if ticked", "if both". */
  when: z.string().optional(),
  key: z.string(),
  /** The exact OCR string. Empty means the capture left the value blank. */
  value: z.string()
});
export type Emit = z.infer<typeof emitSchema>;

export const reviewSchema = z.object({
  /** What was guessed. */
  about: z.enum(["key", "type", "group", "ccd", "mandatory", "regex"]),
  reason: z.string(),
  confidence: z.enum(["low", "medium", "high"])
});
export type Review = z.infer<typeof reviewSchema>;

export const CCD_STATUSES = ["existing", "new", "unsure"] as const;

/**
 * How a field's CCD id stands against the form's case type: `existing` is a field the case type already has, `new` one
 * to add (its proposed id and CCD FieldType are `newField`, and the id is also the field's `ccd`), and `unsure` a
 * field with no id yet and `candidates` the person picks from, or `newField` to add instead.
 */
export const ccdMatchSchema = z.object({
  status: z.enum(CCD_STATUSES),
  candidates: z.array(z.object({ id: z.string(), type: z.string(), label: z.string().optional() })).optional(),
  newField: z.object({ id: z.string(), type: z.string() }).optional(),
  /** The other ids of a row with several that the case type lacks, beside `newField`, which is the first. */
  extraNewFields: z.array(z.object({ id: z.string(), type: z.string() })).optional(),
  /** Set when the id is not the matcher's: a person chose or typed it, or it came with the form. A later match against another case type keeps it. */
  chosenBy: z.enum(["person", "form"]).optional(),
  /** Shared by the rows the matcher decided together, such as the lines of an address. */
  group: z.string().optional(),
  /** Why the matcher decided as it did, for the person to check. */
  reason: z.string().optional()
});
export type CcdMatch = z.infer<typeof ccdMatchSchema>;

export const fieldSchema = z
  .object({
    /** The sheet's ID column: "1.1", or a label such as "QR code" on non-question rows. Blank on continuation rows. */
    id: z.string().optional(),
    role: z.enum(["field", "label", "qr", "blank"]).default("field"),
    label: z.string().default(""),
    inputType: z.enum(INPUT_TYPES).default("text"),
    mandatory: z.enum(MANDATORY).default("optional"),
    group: groupSchema.optional(),
    /** Every key/value pair the capture can emit for this field, in the sheet's order; the source of each key's allowed values. */
    emits: z.array(emitSchema).optional(),
    /** Mandatory only when this holds; `label` is the sheet's wording after "Optional/Mandatory if". */
    required: z.object({ label: z.string(), when: z.record(z.string(), operandSchema).optional() }).optional(),
    /** Documentation the sheet puts before a field's branches, kept verbatim. */
    logicPreamble: z.string().optional(),
    /** Data file key names the field's values arrive under. */
    keys: z.array(z.string()).default([]),
    /** CCD case field ids the keys feed. */
    ccd: z.array(z.string()).default([]),
    /** Whether the ids in `ccd` exist in the form's case type; absent when no case type was matched against. */
    ccdMatch: ccdMatchSchema.optional(),
    /** Anything in the CCD column that is not a field id, e.g. "No corresponding field on CCD". */
    ccdNote: z.string().optional(),
    validationRule: z.string().optional(),
    defaultValue: z.string().optional(),
    businessRules: z.string().optional(),
    maxLength: z.number().int().positive().optional(),
    minLength: z.number().int().positive().optional(),
    /** The SIP's "Input Pattern / Validation" column. */
    pattern: z.string().optional(),
    regex: z.string().optional(),
    handwriting: z.enum(["handwritten", "printed", "both"]).optional(),
    rules: z.array(ruleSchema).default([]),
    /** The most severe outcome the sheet allows this field to produce, from "cannot go into exception". */
    neverExceeds: outcomeSchema.optional(),
    /** English logic that no rule captures, kept so nothing is lost. Always paired with `todo`. */
    logicText: z.string().optional(),
    /** Paragraphs of the case path column that are not a branch's outcome, e.g. a reminder about confidential addresses, or the whole cell of a row whose logic is not parsed. */
    casePathNote: z.string().optional(),
    todo: z.array(z.string()).default([]),
    /** Guesses a generator proposed for this field, each for a person to confirm; absent on fields read from a sheet. */
    review: z.array(reviewSchema).optional(),
    sip: z
      .object({
        tagName: z.string().optional(),
        percentPopulated: z.string().optional(),
        classification: z.string().optional()
      })
      .optional()
  })
  .refine((f) => !f.group || f.group.options.every((o) => f.keys.includes(o.key)), { message: "every option of a group must be one of the field's keys" });
export type Field = z.infer<typeof fieldSchema>;

export const sectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  heading: fieldSchema.optional(),
  fields: z.array(fieldSchema)
});
export type Section = z.infer<typeof sectionSchema>;

export const composeSchema = z.object({
  ccd: z.string(),
  type: z.string().optional(),
  from: z.record(z.string(), z.string())
});
export type Compose = z.infer<typeof composeSchema>;

export const formHeaderSchema = z.object({
  name: z.string().default(""),
  formType: z.string().default(""),
  documentType: z.string().optional(),
  poBox: z.string().optional(),
  supplier: z.string().optional(),
  serviceName: z.string().optional(),
  description: z.string().optional(),
  volumes: z.string().optional(),
  paymentHandling: z.string().optional(),
  identifyingFeatures: z.string().optional(),
  specialHandling: z.string().optional(),
  /** CCD case type and create event the transformation targets. */
  ccdCaseTypeId: z.string().optional(),
  ccdEventId: z.string().optional(),
  /** The workspace product that defines the case type, and how it configures CCD; the picker sets both. */
  ccdProduct: z.string().optional(),
  ccdConfig: z.enum(CCD_CONFIGS).optional(),
  /** The workspace path of the repository that holds the picked case type, such as `apps/sptribs/sptribs-case-api`. */
  ccdRepo: z.string().optional(),
  /** The ids of the picked case type's fields, to check a typed id against. */
  ccdFieldIds: z.array(z.string()).optional(),
  /** What the form was started from, which decides whether a case type's match may propose fields for rows with no id: a sheet's unmapped rows are deliberate. */
  source: z.enum(["pdf", "sip", "sheet"]).optional(),
  /** OCR keys holding party surnames, which the orchestrator matches against existing cases. */
  surnameKeys: z.array(z.string()).optional()
});
export type FormHeader = z.infer<typeof formHeaderSchema>;

export const pageOrderSchema = z.object({ page: z.number().int().positive(), keys: z.array(z.string()) });
export const expectedDocumentSchema = z.object({
  order: z.number().int().positive(),
  name: z.string(),
  identifier: z.string().optional(),
  requirements: z.string().optional(),
  notes: z.string().optional()
});

export const formSpecSchema = z.object({
  form: formHeaderSchema,
  sections: z.array(sectionSchema).default([]),
  composes: z.array(composeSchema).default([]),
  pageOrder: z.array(pageOrderSchema).default([]),
  expectedDocuments: z.array(expectedDocumentSchema).default([])
});
export type FormSpec = z.infer<typeof formSpecSchema>;

export const contactSchema = z.object({
  name: z.string().optional(),
  telephone: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional()
});

export const overviewSchema = z.object({
  serviceName: z.string().optional(),
  completedBy: z.string().optional(),
  verifiedBy: z.string().optional(),
  signOffDate: z.string().optional(),
  contacts: z.array(contactSchema).default([])
});
export type Overview = z.infer<typeof overviewSchema>;

export const bundleSchema = z.object({
  overview: overviewSchema.optional(),
  /** Set on a draft from a PDF with no form fields: the fields still have to be read from the page images. */
  needsReview: z.object({ reason: z.string(), prompt: z.string() }).optional(),
  forms: z.array(formSpecSchema)
});
export type Bundle = z.infer<typeof bundleSchema>;

export function allFields(spec: FormSpec): Field[] {
  return spec.sections.flatMap((s) => s.fields);
}
