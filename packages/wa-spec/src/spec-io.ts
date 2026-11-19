import { Document, isScalar, parse, visit } from "yaml";
import { Layout } from "./layout.ts";
import { Spec, validateSpec } from "./schema.ts";

/** Parses and checks a spec: the shape first, then the references between its parts. */
export const parseSpec = (yamlText: string): Spec => specFromDocument(parse(yamlText));

/** Checks a spec already parsed from YAML. */
export function specFromDocument(document: unknown): Spec {
  const spec = Spec.parse(document);
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    throw new Error(`Invalid spec:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return spec;
}

const SHORT_LIST = 4;
const SHORT_ITEM = 40;

/** YAML with short scalar lists on one line, so a row reads as a few lines rather than a column of dashes. */
export function toYaml(value: unknown, shortList = SHORT_LIST): string {
  const doc = new Document(value, { aliasDuplicateObjects: false });
  visit(doc, {
    Seq(_key, node) {
      const short = node.items.length <= shortList && node.items.every((item) => isScalar(item) && String(item.value).length < SHORT_ITEM);
      if (short) {
        node.flow = true;
      }
    }
  });
  return doc.toString({ lineWidth: 0, blockQuote: "literal" });
}

export function stringifySpec(spec: Spec): string {
  return toYaml(spec);
}

export function parseLayout(yamlText: string): Layout {
  return Layout.parse(parse(yamlText));
}

export function stringifyLayout(layout: Layout): string {
  return toYaml(layout);
}

/** Where a spec's layout lives: beside it, as `<name>.layout.yaml`. */
export function layoutPathFor(specPath: string): string {
  return `${specPath.replace(/\.ya?ml$/, "")}.layout.yaml`;
}
