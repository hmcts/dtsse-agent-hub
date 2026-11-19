import { basename, extname } from "node:path";
import { proposeCcd } from "./ccd-propose.ts";
import { proposeKeys } from "./key-proposal.ts";
import { draftFields } from "./pdf-draft.ts";
import type { PdfContent } from "./pdf-extract.ts";
import { extractPdf } from "./pdf-extract.ts";
import type { Bundle, Field, Section } from "./schema.ts";
import { bundleSchema } from "./schema.ts";

export interface FromPdfInput {
  /** The PDF's path, which also names the form. */
  pdf: string;
  /** The PDF's content when it is not on disk; `pdf` then only names the form. */
  bytes?: Uint8Array;
  /** Keys the service already uses, to reuse and imitate. */
  houseKeys?: string[];
  /** CCD case field ids of the service's definition. */
  ccdIds?: string[];
}

export interface FromPdfResult {
  bundle: Bundle;
  /** One line per guess in the draft, lowest confidence first. */
  checklist: string[];
  /** Set when the PDF has no form fields, so a person or the Claude session running the tool has to read the pages. */
  needsReview?: { reason: string; promptText: string };
}

const RANK = { low: 0, medium: 1, high: 2 } as const;

function pageText(content: PdfContent): string {
  return Array.from({ length: content.pageCount }, (_, i) => {
    const text = content.lines.filter((l) => l.page === i + 1).map((l) => l.text);
    return `## Page ${i + 1}\n\n${text.join("\n") || "(no text layer: read the page image)"}`;
  }).join("\n\n");
}

function promptFor(pdf: string, content: PdfContent): string {
  return `# Fill in the draft spec for ${basename(pdf)}

The PDF has no fillable form fields, so no field could be read from it. Open the PDF page by page (the Read tool takes a \`pages\` range) and fill in the draft spec JSON next to this file:

- one section per heading on the form, with a field for every box the applicant fills in: its label, \`inputType\` (text, checkbox or date), \`maxLength\` where the boxes show one, and the question id as \`id\`
- checkboxes of one question are one field with a \`group\` of kind \`xor\`; the field's \`keys\` are the group's option keys
- a camelCase \`keys\` entry for each box, in the style of the service's existing keys
- \`pageOrder\`: for each page, the keys on it
- every guess gets an entry in the field's \`review\` list: \`{ "about": "key" | "type" | "group" | "ccd", "reason": "...", "confidence": "low" | "medium" | "high" }\`
- remove \`needsReview\` from the draft once it is filled in, and check it with \`generate\` or any other command that reads a spec

The text layer of each page follows; it may miss text drawn as images.

${pageText(content)}
`;
}

/** Reads a PDF and drafts its field spec, proposing keys, groups and CCD ids and flagging each as a guess. */
export async function fromPdf(input: FromPdfInput): Promise<FromPdfResult> {
  const content = await extractPdf(input.bytes ?? input.pdf);
  const form = { name: basename(input.pdf, extname(input.pdf)), formType: "" };
  if (content.widgets.length === 0) {
    const reason = "the PDF has no AcroForm fields";
    return { bundle: bundleSchema.parse({ forms: [{ form }] }), checklist: [], needsReview: { reason, promptText: promptFor(input.pdf, content) } };
  }
  const drafts = draftFields(content);
  const slots = drafts.flatMap((d) => d.slotLabels.map((label) => ({ label, context: `${d.sectionTitle} ${d.question}` })));
  const tags = drafts.flatMap((d) => d.slotLabels.map(() => `Q${(d.field.id ?? `p${d.page}`).replace(/\./g, "_")}`));
  const keys = proposeKeys(slots, input.houseKeys ?? [], tags);
  let next = 0;
  const withKeys = drafts.map((d) => {
    const mine = keys.slice(next, next + d.slotLabels.length);
    next += d.slotLabels.length;
    return { d, mine };
  });
  const ccd = proposeCcd(
    withKeys.map(({ d, mine }) => `${mine.map((k) => k.key).join(" ")} ${d.field.label} ${d.question}`),
    input.ccdIds ?? []
  );
  const checklist: { confidence: keyof typeof RANK; line: string }[] = [];
  const sections = new Map<string, Section>();
  const pages = new Map<number, string[]>();
  withKeys.forEach(({ d, mine }, i) => {
    const review: NonNullable<Field["review"]> = [];
    const where = `${d.field.id ?? ""} ${d.field.label}`.trim();
    for (const k of mine) {
      review.push({ about: "key", reason: `${k.key}: ${k.reason}`, confidence: k.confidence });
    }
    for (const r of d.reasons) {
      review.push(r);
    }
    const proposed = ccd[i];
    if (input.ccdIds) {
      review.push(
        proposed
          ? { about: "ccd", reason: `${proposed.id}: ${proposed.reason}`, confidence: proposed.confidence }
          : { about: "ccd", reason: "no CCD field close enough", confidence: "low" }
      );
    }
    const field: Field = {
      ...d.field,
      keys: mine.map((k) => k.key),
      ccd: proposed ? [proposed.id] : [],
      ...(d.groupSize && d.groupSize > 1
        ? { group: { kind: "xor" as const, size: d.groupSize, options: mine.map((k, n) => ({ key: k.key, label: d.slotLabels[n] ?? "" })) } }
        : {}),
      review
    };
    for (const r of review) {
      checklist.push({ confidence: r.confidence, line: `[${r.confidence}] ${where} (page ${d.page}): ${r.about}, ${r.reason}` });
    }
    const section = sections.get(d.sectionId) ?? { id: d.sectionId, title: d.sectionTitle, fields: [] };
    section.fields.push(field);
    sections.set(d.sectionId, section);
    pages.set(d.page, [...(pages.get(d.page) ?? []), ...field.keys]);
  });
  const pageOrder = [...pages].map(([page, pageKeys]) => ({ page, keys: pageKeys })).sort((a, b) => a.page - b.page);
  const bundle = bundleSchema.parse({ forms: [{ form, sections: [...sections.values()], pageOrder }] });
  checklist.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
  return { bundle, checklist: checklist.map((c) => c.line) };
}
