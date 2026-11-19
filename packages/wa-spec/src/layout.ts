import { createHash } from "node:crypto";
import { z } from "zod";
import type { DmnDecision, DmnDiagramItem, DmnDocument, DmnRule } from "./dmn-model.ts";
import { normaliseFeel, parseCell, parseExpr, renderCell, renderExpr } from "./feel.ts";
import type { Kind } from "./schema.ts";

/*
 * What a DMN file carries that the spec does not: element ids, column widths and the decision requirements diagram.
 * It sits in a file beside the spec, so the spec stays the readable part, and lets a spec imported from DMNs generate
 * the same ids and layout again. Anything it lacks, such as a row added to the spec, gets a generated id.
 * Each id, width and shape is one space-separated string; `-` is an absent value.
 */

const Words = z.string().min(1);

const DecisionLayout = z.strictObject({
  /** The id of a helper decision. The main decision's id is its decision key, which the spec fixes. */
  id: Words.optional(),
  variable: Words.optional(),
  literal: Words.optional(),
  table: Words.optional(),
  annotationsWidth: Words.optional(),
  /** Information requirement ids by the name of the helper required. */
  requirements: z.record(z.string(), Words).optional(),
  /** `<id> <expression id> <width> <allowed values id>` by input key. */
  inputs: z.record(z.string(), Words).optional(),
  /** `<id> <width>` by output name. */
  outputs: z.record(z.string(), Words).optional(),
  /** `<content hash> <rule id> <input entry ids…> <output entry ids…>`, in rule order. */
  rules: z.array(Words).optional(),
  /**
   * The original text of an entry, input expression or helper expression, by the id of its element, where it differs from how the
   * spec renders it (spacing, line breaks). It is used only while the spec still renders to the same thing. `<rule id>#description`
   * holds a rule's empty description element.
   */
  texts: z.record(z.string(), z.string()).optional()
});
type DecisionLayout = z.infer<typeof DecisionLayout>;

const FileLayout = z.strictObject({
  id: Words,
  /** The root element's namespace declarations in file order, each `<attribute> <uri>`. */
  namespaces: z.array(Words).optional(),
  exporter: z.string().optional(),
  exporterVersion: z.string().optional(),
  /** The root element's other attributes in file order, each `<name> <value>`. */
  attributes: z.array(Words).optional(),
  /** Keyed by `table` for the main decision, or by a helper's name. */
  decisions: z.record(z.string(), DecisionLayout),
  diagram: z
    .strictObject({
      id: z.string(),
      /** `shape <decision id> <shape id> <x> <y> <width> <height>` or `edge <requirement id> <edge id> <x,y>…`, in file order. */
      items: z.array(Words)
    })
    .optional()
});
export type FileLayout = z.infer<typeof FileLayout>;

export const Layout = z.strictObject({ version: z.literal(1), files: z.record(z.string(), FileLayout) });
export type Layout = z.infer<typeof Layout>;

export const layoutKey = (kind: Kind, caseType: string): string => `${kind}/${caseType}`;

const ABSENT = "-";
const out = (value: string | undefined): string => (value === undefined || value === "" ? ABSENT : value);
const back = (value: string | undefined): string | undefined => (value === undefined || value === ABSENT ? undefined : value);

/** Identifies a rule by what it says, so a stored id follows the rule when the spec's rows are reordered or edited around it. */
export function ruleHash(rule: Pick<DmnRule, "description" | "inputs" | "outputs">): string {
  return createHash("sha1")
    .update(JSON.stringify([rule.description || null, rule.inputs.map(normaliseFeel), rule.outputs.map(normaliseFeel)]))
    .digest("hex")
    .slice(0, 12);
}

/** The original text of every entry and expression that the spec does not render the same way, by the id of its element. */
function textOverrides(original: DmnDecision, generated: DmnDecision | undefined): Record<string, string> {
  const texts: Record<string, string> = {};
  const keep = (id: string | undefined, was: string, now: string | undefined) => {
    if (id && now !== undefined && was !== now) {
      texts[id] = was;
    }
  };
  for (const [i, input] of (original.table?.inputs ?? []).entries()) {
    keep(input.expressionId, input.expression, generated?.table?.inputs[i]?.expression);
  }
  for (const [r, rule] of (original.table?.rules ?? []).entries()) {
    const now = generated?.table?.rules[r];
    for (const [i, entry] of rule.inputs.entries()) {
      keep(rule.inputIds?.[i], entry, now?.inputs[i]);
    }
    for (const [i, entry] of rule.outputs.entries()) {
      keep(rule.outputIds?.[i], entry, now?.outputs[i]);
    }
    if (rule.id && rule.description === "") {
      texts[`${rule.id}#description`] = "";
    }
  }
  keep(original.literal?.id, original.literal?.text ?? "", generated?.literal?.text);
  return texts;
}

function decisionLayout(
  decision: DmnDecision,
  generated: DmnDecision | undefined,
  isMain: boolean,
  inputKeys: string[],
  names: Map<string, string>
): DecisionLayout {
  const table = decision.table;
  const texts = textOverrides(decision, generated);
  const rules = generated?.table?.rules ?? [];
  const requirements = Object.fromEntries(
    decision.requires.flatMap((required, index) => {
      const id = decision.requirementIds?.[index];
      return id ? [[names.get(required) ?? required, id] as const] : [];
    })
  );
  return {
    ...(isMain || !decision.id ? {} : { id: decision.id }),
    ...(decision.variable?.id ? { variable: decision.variable.id } : {}),
    ...(decision.literal?.id ? { literal: decision.literal.id } : {}),
    ...(table?.id ? { table: table.id } : {}),
    ...(table?.annotationsWidth ? { annotationsWidth: table.annotationsWidth } : {}),
    ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    ...(Object.keys(texts).length > 0 ? { texts } : {}),
    ...(table
      ? {
          inputs: Object.fromEntries(
            table.inputs.map((input, i) => [
              inputKeys[i] as string,
              [out(input.id), out(input.expressionId), out(input.width), out(input.allowedValuesId)].join(" ")
            ])
          ),
          outputs: Object.fromEntries(table.outputs.map((output) => [output.name, [out(output.id), out(output.width)].join(" ")])),
          rules: table.rules.map((rule, i) =>
            [ruleHash(rules[i] ?? rule), out(rule.id), ...(rule.inputIds ?? []).map(out), ...(rule.outputIds ?? []).map(out)].join(" ")
          )
        }
      : {})
  };
}

const shapeText = (item: DmnDiagramItem): string =>
  item.type === "shape"
    ? ["shape", item.ref, out(item.id), item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height].join(" ")
    : ["edge", item.ref, out(item.id), ...item.waypoints.map((w) => `${w.x},${w.y}`)].join(" ");

function parseItem(text: string): DmnDiagramItem | undefined {
  const [type, ref, id, ...rest] = text.split(" ");
  if (type === "shape" && ref && rest.length === 4) {
    const [x, y, width, height] = rest as [string, string, string, string];
    return { type, ref, id: back(id) ?? "", bounds: { x, y, width, height } };
  }
  if (type === "edge" && ref) {
    return {
      type,
      ref,
      id: back(id) ?? "",
      waypoints: rest.map((point) => {
        const [x = "0", y = "0"] = point.split(",");
        return { x, y };
      })
    };
  }
  return undefined;
}

/**
 * Reads the layout out of a parsed DMN. `generated` is the document the generator makes for the same file from the spec without a
 * layout: rules are identified by what it renders, which is what `applyLayout` will match against, and any text it renders
 * differently is kept. `inputKeys` names the main decision's input columns.
 */
export function layoutOf(doc: DmnDocument, main: DmnDecision, inputKeys: string[], generated: DmnDocument | undefined): FileLayout {
  const names = new Map(doc.decisions.map((d) => [d.id, d.name]));
  const decisions: Record<string, DecisionLayout> = {};
  for (const decision of doc.decisions) {
    const isMain = decision === main;
    const made = isMain ? generated?.decisions[0] : generated?.decisions.find((d, i) => i > 0 && d.name === decision.name);
    decisions[isMain ? "table" : decision.name] = decisionLayout(decision, made, isMain, isMain ? inputKeys : [], names);
  }
  return {
    id: doc.id,
    ...(doc.namespaces ? { namespaces: doc.namespaces.map(([name, uri]) => `${name} ${uri}`) } : {}),
    ...(doc.attributes ? { attributes: doc.attributes.map(([name, value]) => `${name} ${value}`) } : {}),
    ...(doc.exporter === undefined ? {} : { exporter: doc.exporter }),
    ...(doc.exporterVersion === undefined ? {} : { exporterVersion: doc.exporterVersion }),
    decisions,
    ...(doc.diagram ? { diagram: { id: doc.diagram.id, items: doc.diagram.items.map(shapeText) } } : {})
  };
}

const exprText = (text: string): string => renderExpr(parseExpr(text));
const cellText = (text: string): string => renderCell(parseCell(text));

/** The stored original of a text while it still renders to `current`. */
function original(texts: Record<string, string> | undefined, id: string | undefined, current: string, render: (text: string) => string): string {
  const stored = id ? texts?.[id] : undefined;
  return stored !== undefined && normaliseFeel(render(stored)) === normaliseFeel(current) ? stored : current;
}

/**
 * The stored line for each generated rule. A rule keeps the line with the same content hash; when the spec has as many rules as
 * were stored, the rules whose hash found nothing, such as every rule after a column was added, take the unused lines in order.
 */
function matchRules(rules: DmnRule[], lines: string[]): Array<string[] | undefined> {
  const byHash = new Map<string, number[]>();
  for (const [i, line] of lines.entries()) {
    const hash = line.split(" ")[0] ?? "";
    byHash.set(hash, [...(byHash.get(hash) ?? []), i]);
  }
  const taken = new Set<number>();
  const found = rules.map((rule) => {
    const at = byHash.get(ruleHash(rule))?.shift();
    if (at !== undefined) {
      taken.add(at);
    }
    return at;
  });
  const spare = lines.map((_, i) => i).filter((i) => !taken.has(i));
  return found.map((at) => {
    const line = at ?? (rules.length === lines.length ? spare.shift() : undefined);
    return line === undefined ? undefined : (lines[line] as string).split(" ").slice(1);
  });
}

/** Fills in the ids, widths and diagram a generated document lacks from what the file's layout stored. */
export function applyLayout(doc: DmnDocument, layout: FileLayout | undefined, inputKeys: string[]): DmnDocument {
  if (!layout) {
    return doc;
  }
  const keyOf = (decision: DmnDecision, index: number): string => (index === 0 ? "table" : decision.name);
  const names = new Map(doc.decisions.map((d, i) => [d.id, keyOf(d, i)]));
  const decisions = doc.decisions.map((decision, index): DmnDecision => {
    const own = layout.decisions[keyOf(decision, index)];
    if (!own) {
      return decision;
    }
    const table = decision.table;
    const split = (text: string | undefined) => (text ?? "").split(" ").map(back);
    const stored = matchRules(table?.rules ?? [], own.rules ?? []);
    const storedInputs = Object.keys(own.inputs ?? {});
    const storedOutputs = Object.keys(own.outputs ?? {});
    const order = Object.keys(own.requirements ?? {});
    const rank = (required: string): number => {
      const at = order.indexOf(names.get(required) ?? "");
      return at < 0 ? order.length : at;
    };
    const requires = [...decision.requires].sort((x, y) => rank(x) - rank(y));
    return {
      ...decision,
      requires,
      requirementIds: requires.map((required) => own.requirements?.[names.get(required) ?? ""] ?? ""),
      ...(decision.variable && own.variable ? { variable: { ...decision.variable, id: own.variable } } : {}),
      ...(decision.literal
        ? {
            literal: {
              ...decision.literal,
              ...(own.literal ? { id: own.literal } : {}),
              text: original(own.texts, own.literal, decision.literal.text, exprText)
            }
          }
        : {}),
      ...(table
        ? {
            table: {
              ...table,
              ...(own.table ? { id: own.table } : {}),
              ...(own.annotationsWidth ? { annotationsWidth: own.annotationsWidth } : {}),
              inputs: table.inputs.map((input, i) => {
                const [id, expressionId, width, allowedValuesId] = split(own.inputs?.[inputKeys[i] as string]);
                return {
                  ...input,
                  ...(id ? { id } : {}),
                  ...(expressionId ? { expressionId } : {}),
                  ...(width ? { width } : {}),
                  ...(allowedValuesId ? { allowedValuesId } : {}),
                  expression: original(own.texts, expressionId, input.expression, exprText)
                };
              }),
              outputs: table.outputs.map((output) => {
                const [id, width] = split(own.outputs?.[output.name]);
                return { ...output, ...(id ? { id } : {}), ...(width ? { width } : {}) };
              }),
              rules: table.rules.map((rule, r): DmnRule => {
                const ids = stored[r];
                if (!ids) {
                  return rule;
                }
                const [id, ...entries] = ids.map(back);
                const inputIds = inputKeys.map((key) => entries[storedInputs.indexOf(key)] ?? "");
                const outputIds = table.outputs.map((o) => entries[storedInputs.length + storedOutputs.indexOf(o.name)] ?? "");
                return {
                  ...rule,
                  ...(id ? { id } : {}),
                  ...(!rule.description && id && own.texts?.[`${id}#description`] === "" ? { description: "" } : {}),
                  inputIds,
                  outputIds,
                  inputs: rule.inputs.map((text, i) => original(own.texts, inputIds[i], text, cellText)),
                  outputs: rule.outputs.map((text, i) => original(own.texts, outputIds[i], text, exprText))
                };
              })
            }
          }
        : {})
    };
  });
  const items = (layout.diagram?.items ?? []).flatMap((text) => parseItem(text) ?? []);
  const namespaces = layout.namespaces?.map((line): [string, string] => [line.split(" ")[0] as string, line.split(" ").slice(1).join(" ")]);
  return {
    ...doc,
    ...(namespaces ? { namespaces } : {}),
    ...(layout.attributes
      ? { attributes: layout.attributes.map((line): [string, string] => [line.split(" ")[0] as string, line.split(" ").slice(1).join(" ")]) }
      : {}),
    ...(layout.exporter === undefined ? {} : { exporter: layout.exporter }),
    ...(layout.exporterVersion === undefined ? {} : { exporterVersion: layout.exporterVersion }),
    decisions,
    ...(layout.diagram ? { diagram: { id: layout.diagram.id, items } } : {})
  };
}
