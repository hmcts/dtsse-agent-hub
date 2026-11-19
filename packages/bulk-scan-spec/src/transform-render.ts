import { byCode } from "./compare.ts";
import { emitsOf, renderEmits } from "./emits.ts";
import { renderCasePath, renderLogic } from "./logic.ts";
import type { Compose, Field, TransformColumn } from "./schema.ts";
import { TRANSFORM_COLUMNS } from "./schema.ts";

const LABEL_NA = "NA";

function descriptionFor(field: Field): string {
  if (field.role !== "field" || field.mandatory === "not-read") {
    return LABEL_NA;
  }
  return renderEmits(emitsOf(field));
}

function dataTypeFor(field: Field): string {
  if (field.group) {
    return `XoR (${field.group.size})`;
  }
  switch (field.inputType) {
    case "date":
      return "date";
    case "qr":
      return "QR code";
    case "none":
      return "NA";
    default:
      return "text";
  }
}

function mandatoryFor(field: Field): string {
  switch (field.mandatory) {
    case "mandatory":
      return "Mandatory";
    case "optional":
      return "Optional";
    case "conditional":
      return field.required ? `Optional/Mandatory if ${field.required.label}` : "Optional/Mandatory";
    default:
      return "Do not read";
  }
}

function logicFor(field: Field, composes: Compose[]): string {
  if (field.rules.length > 0 || field.logicPreamble) {
    return renderLogic(field.rules, field.logicPreamble);
  }
  if (field.logicText) {
    return field.logicText;
  }
  const compose = composes.find((c) => c.type === "AddressUK" && field.ccd.includes(c.ccd));
  if (compose) {
    return `Populate these separate address fields (from the metadata json file) into the one address field (${compose.ccd}) that we have on CCD`;
  }
  return "";
}

function casePathFor(field: Field): string {
  return [renderCasePath(field.rules, field.neverExceeds), field.casePathNote].filter(Boolean).join("\n\n");
}

/** What the generator writes for a column when the spec holds no verbatim text for it. */
export function renderColumn(field: Field, column: TransformColumn, composes: Compose[]): string {
  if (field.role === "blank") {
    return "";
  }
  const label = field.role === "label" || field.mandatory === "not-read";
  switch (column) {
    case "id":
      return field.id ?? "";
    case "label":
      return field.label;
    case "dataType":
      return dataTypeFor(field);
    case "mandatory":
      return mandatoryFor(field);
    case "validationRule":
      return field.validationRule ?? (label ? LABEL_NA : "");
    case "defaultValue":
      return field.defaultValue ?? "";
    case "description":
      return descriptionFor(field);
    case "tagName":
      return field.keys.join("\n");
    case "businessRules":
      return field.businessRules ?? "";
    case "ccd":
      return [...field.ccd, ...(field.ccdNote ? [field.ccdNote] : [])].join("\n");
    case "logic":
      return logicFor(field, composes);
    case "casePath":
      return casePathFor(field);
  }
}

export function rowFor(field: Field, composes: Compose[]): string[] {
  return TRANSFORM_COLUMNS.map((column) => renderColumn(field, column, composes));
}

/**
 * What two renderings of a cell must share to differ only cosmetically: its words, ignoring case, spacing, dashes, "NA" and, in the
 * logic, the word "if", quotes, "raise", "case path =", branch labels and the side an assignment is written from. In the CCD and case path columns the order of the lines is cosmetic too.
 */
export function cosmeticKey(column: TransformColumn, text: string): string {
  const words = (s: string) => {
    let t = column === "tagName" ? s.replace(/(^|\n)\s*[a-z]\)\s*/g, "$1") : s;
    t = t.toLowerCase();
    if (column === "description") {
      t = t.replace(/"/g, "");
    }
    if (column === "logic") {
      t = t
        .replace(/\(i\.e[^)]*\)|\((?:success|warning|exception)\)/g, "")
        .replace(/\braise\b|\b(?:validation\s+status|case path)\s*=/g, "")
        .replace(/['"’[\]]/g, "")
        .replace(/!\s*=\s*|=\s*!\s*/g, "!")
        .replace(/\bif\b/g, "")
        // The labels are the case path's, and an assignment reads the same from either side.
        .replace(/^\s*\d+[a-z]?\)/gm, "")
        .replace(/(\w+)\s*=\s*(\w+)/g, (_m, l: string, r: string) => [l, r].sort(byCode).join("="));
    }
    if (column === "casePath") {
      t = t.replace(/[=)]/g, "");
    }
    return t.replace(/[\s\-↓,:]+/g, "");
  };
  const key = column === "ccd" || column === "casePath" ? text.split("\n").map(words).filter(Boolean).sort(byCode).join("|") : words(text);
  return key === "na" ? "" : key;
}

/** Whether two cell texts differ only cosmetically; a blank Data Type says nothing, so any type renders without conflict. */
export function cosmeticallyEqual(column: TransformColumn, original: string, rendered: string): boolean {
  if (column === "dataType" && original.trim() === "") {
    return true;
  }
  return cosmeticKey(column, original) === cosmeticKey(column, rendered);
}
