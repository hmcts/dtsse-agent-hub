import { XMLParser } from "fast-xml-parser";

export interface DmnInput {
  label?: string;
  inputVariable?: string;
  typeRef?: string;
  expressionLanguage?: string;
  expression: string;
}

export interface DmnOutput {
  label?: string;
  name: string;
  typeRef?: string;
}

export interface DmnRule {
  description?: string;
  inputs: string[];
  outputs: string[];
}

export interface DmnTable {
  hitPolicy: string;
  aggregation?: string;
  inputs: DmnInput[];
  outputs: DmnOutput[];
  rules: DmnRule[];
}

export interface DmnDecision {
  id: string;
  name: string;
  historyTimeToLive?: string;
  variable?: { name: string; typeRef?: string };
  /** Ids of the decisions it requires, in document order. */
  requires: string[];
  table?: DmnTable;
  literal?: { text: string; expressionLanguage?: string };
}

export interface DmnDocument {
  id: string;
  name: string;
  decisions: DmnDecision[];
}

type Node = Record<string, unknown>;

const LIST_TAGS = new Set(["decision", "input", "output", "rule", "inputEntry", "outputEntry", "informationRequirement", "requiredDecision", "description"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => LIST_TAGS.has(name)
});

function asList(value: unknown): Node[] {
  return Array.isArray(value) ? (value as Node[]) : value === undefined ? [] : [value as Node];
}

function attr(node: Node, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

function textOf(node: Node | undefined): string {
  if (node === undefined || typeof node === "string") {
    return (node as string | undefined) ?? "";
  }
  const text = node.text;
  if (typeof text === "string") {
    return text;
  }
  return "";
}

function optional<T extends object>(fields: Record<string, string | undefined>): T {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function parseTable(table: Node): DmnTable {
  const inputs = asList(table.input).map((input) => {
    const expression = (input.inputExpression ?? {}) as Node;
    return {
      ...optional<Omit<DmnInput, "expression">>({
        label: attr(input, "label"),
        inputVariable: attr(input, "camunda:inputVariable"),
        typeRef: attr(expression, "typeRef"),
        expressionLanguage: attr(expression, "expressionLanguage")
      }),
      expression: textOf(expression)
    };
  });
  const outputs = asList(table.output).map((output) => ({
    ...optional<Omit<DmnOutput, "name">>({ label: attr(output, "label"), typeRef: attr(output, "typeRef") }),
    name: attr(output, "name") ?? ""
  }));
  const rules = asList(table.rule).map((rule) => {
    const description = asList(rule.description)
      .map((d) => (typeof d === "string" ? d : ""))
      .join("");
    return {
      ...(description === "" ? {} : { description }),
      inputs: asList(rule.inputEntry).map((entry) => textOf(entry)),
      outputs: asList(rule.outputEntry).map((entry) => textOf(entry))
    };
  });
  return {
    ...optional<{ hitPolicy: string; aggregation?: string }>({ hitPolicy: attr(table, "hitPolicy") ?? "UNIQUE", aggregation: attr(table, "aggregation") }),
    inputs,
    outputs,
    rules
  } as DmnTable;
}

export function parseDmn(xml: string): DmnDocument {
  const root = (parser.parse(xml) as Node).definitions as Node;
  const decisionNodes = asList(root.decision);
  const idToDecision = new Map<string, string>();
  for (const node of decisionNodes) {
    idToDecision.set(attr(node, "id") ?? "", attr(node, "name") ?? "");
  }
  const decisions = decisionNodes.map((node): DmnDecision => {
    const variable = node.variable as Node | undefined;
    const literal = node.literalExpression as Node | undefined;
    const table = node.decisionTable as Node | undefined;
    const requires = asList(node.informationRequirement).flatMap((requirement) =>
      asList(requirement.requiredDecision).map((required) => (attr(required, "href") ?? "").replace(/^#/, ""))
    );
    return {
      id: attr(node, "id") ?? "",
      name: attr(node, "name") ?? "",
      ...optional<{ historyTimeToLive?: string }>({ historyTimeToLive: attr(node, "camunda:historyTimeToLive") }),
      ...(variable ? { variable: { name: attr(variable, "name") ?? "", ...optional<{ typeRef?: string }>({ typeRef: attr(variable, "typeRef") }) } } : {}),
      requires,
      ...(table ? { table: parseTable(table) } : {}),
      ...(literal
        ? { literal: { text: textOf(literal), ...optional<{ expressionLanguage?: string }>({ expressionLanguage: attr(literal, "expressionLanguage") }) } }
        : {})
    };
  });
  return { id: attr(root, "id") ?? "", name: attr(root, "name") ?? "", decisions };
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', "&quot;");
}

function attrs(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

/** Stable ids derived from a seed, so regenerating a file never churns ids. */
function idFactory(prefix: string): (kind: string, ...parts: Array<string | number>) => string {
  return (kind, ...parts) => `${kind}_${[prefix, ...parts].join("_")}`;
}

const NAMESPACES =
  'xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:biodi="http://bpmn.io/schema/dmn/biodi/2.0" xmlns:camunda="http://camunda.org/schema/1.0/dmn" xmlns:di="http://www.omg.org/spec/DMN/20180521/DI/"';

function text(indent: string, value: string): string {
  return `${indent}<text>${escapeText(value)}</text>\n`;
}

function writeTable(table: DmnTable, tableId: string, id: ReturnType<typeof idFactory>, base: string): string {
  const pad = "      ";
  let out = `    <decisionTable${attrs([
    ["id", tableId],
    ["hitPolicy", table.hitPolicy === "UNIQUE" ? undefined : table.hitPolicy],
    ["aggregation", table.aggregation]
  ])}>\n`;
  table.inputs.forEach((input, index) => {
    out += `${pad}<input${attrs([
      ["id", id("Input", base, index)],
      ["label", input.label],
      ["camunda:inputVariable", input.inputVariable]
    ])}>\n`;
    out += `${pad}  <inputExpression${attrs([
      ["id", id("InputExpression", base, index)],
      ["typeRef", input.typeRef],
      ["expressionLanguage", input.expressionLanguage]
    ])}>\n`;
    out += text(`${pad}    `, input.expression);
    out += `${pad}  </inputExpression>\n${pad}</input>\n`;
  });
  table.outputs.forEach((output, index) => {
    out += `${pad}<output${attrs([
      ["id", id("Output", base, index)],
      ["label", output.label],
      ["name", output.name],
      ["typeRef", output.typeRef]
    ])} />\n`;
  });
  table.rules.forEach((rule, ruleIndex) => {
    out += `${pad}<rule id="${id("Rule", base, ruleIndex)}">\n`;
    if (rule.description !== undefined) {
      out += `${pad}  <description>${escapeText(rule.description)}</description>\n`;
    }
    rule.inputs.forEach((entry, index) => {
      out += `${pad}  <inputEntry id="${id("InputEntry", base, ruleIndex, index)}">\n${text(`${pad}    `, entry)}${pad}  </inputEntry>\n`;
    });
    rule.outputs.forEach((entry, index) => {
      out += `${pad}  <outputEntry id="${id("OutputEntry", base, ruleIndex, index)}">\n${text(`${pad}    `, entry)}${pad}  </outputEntry>\n`;
    });
    out += `${pad}</rule>\n`;
  });
  return `${out}    </decisionTable>\n`;
}

/** Serialises the model as a DMN 1.3 file in Camunda Modeler's layout, with a generated, left-to-right DRD. */
export function writeDmn(doc: DmnDocument): string {
  const id = idFactory(doc.id);
  const decisionIds = new Map(doc.decisions.map((d) => [d.name, d.id]));
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<definitions ${NAMESPACES}${attrs([
    ["id", doc.id],
    ["name", doc.name],
    ["namespace", "http://camunda.org/schema/1.0/dmn"],
    ["exporter", "Camunda Modeler"],
    ["exporterVersion", "5.50.1"]
  ])}>\n`;
  const requirementIds: Array<{ from: string; to: string; id: string }> = [];
  for (const decision of doc.decisions) {
    out += `  <decision${attrs([
      ["id", decision.id],
      ["name", decision.name],
      ["camunda:historyTimeToLive", decision.historyTimeToLive]
    ])}>\n`;
    if (decision.variable) {
      out += `    <variable${attrs([
        ["id", id("InformationItem", decision.id)],
        ["name", decision.variable.name],
        ["typeRef", decision.variable.typeRef]
      ])} />\n`;
    }
    decision.requires.forEach((required, index) => {
      const requirementId = id("InformationRequirement", decision.id, index);
      requirementIds.push({ from: decision.id, to: required, id: requirementId });
      out += `    <informationRequirement id="${requirementId}">\n      <requiredDecision href="#${required}" />\n    </informationRequirement>\n`;
    });
    if (decision.table) {
      out += writeTable(decision.table, id("DecisionTable", decision.id), id, decision.id);
    }
    if (decision.literal) {
      out += `    <literalExpression${attrs([
        ["id", id("LiteralExpression", decision.id)],
        ["expressionLanguage", decision.literal.expressionLanguage]
      ])}>\n${text("      ", decision.literal.text)}    </literalExpression>\n`;
    }
    out += "  </decision>\n";
  }
  out += writeDiagram(doc, requirementIds, id, decisionIds);
  return `${out}</definitions>\n`;
}

function writeDiagram(
  doc: DmnDocument,
  requirements: Array<{ from: string; to: string; id: string }>,
  id: ReturnType<typeof idFactory>,
  _decisionIds: Map<string, string>
): string {
  const width = 180;
  const height = 80;
  const position = new Map<string, { x: number; y: number }>();
  const dependents = doc.decisions.filter((d) => d.requires.length === 0 || d.table);
  const main = dependents.find((d) => d.table) ?? doc.decisions[0];
  doc.decisions.forEach((decision, index) => {
    if (decision === main) {
      position.set(decision.id, { x: 160, y: 80 });
    } else {
      position.set(decision.id, { x: 160 + ((index - 1) % 4) * 220, y: 250 + Math.floor((index - 1) / 4) * 170 });
    }
  });
  let out = `  <dmndi:DMNDI>\n    <dmndi:DMNDiagram id="${id("DMNDiagram", "drd")}">\n`;
  for (const decision of doc.decisions) {
    const at = position.get(decision.id) ?? { x: 0, y: 0 };
    out += `      <dmndi:DMNShape id="${id("DMNShape", decision.id)}" dmnElementRef="${decision.id}">\n        <dc:Bounds height="${height}" width="${width}" x="${at.x}" y="${at.y}" />\n      </dmndi:DMNShape>\n`;
  }
  for (const requirement of requirements) {
    const from = position.get(requirement.from) ?? { x: 0, y: 0 };
    const to = position.get(requirement.to) ?? { x: 0, y: 0 };
    out += `      <dmndi:DMNEdge id="${id("DMNEdge", requirement.id)}" dmnElementRef="${requirement.id}">\n`;
    out += `        <di:waypoint x="${to.x + width / 2}" y="${to.y}" />\n        <di:waypoint x="${from.x + width / 2}" y="${from.y + height}" />\n      </dmndi:DMNEdge>\n`;
  }
  return `${out}    </dmndi:DMNDiagram>\n  </dmndi:DMNDI>\n`;
}

const USED_ATTRIBUTES: Record<string, string[]> = {
  definitions: ["id", "name"],
  decision: ["id", "name", "camunda:historyTimeToLive"],
  variable: ["name", "typeRef"],
  requiredDecision: ["href"],
  decisionTable: ["hitPolicy", "aggregation"],
  input: ["label", "camunda:inputVariable"],
  inputExpression: ["typeRef", "expressionLanguage"],
  output: ["label", "name", "typeRef"],
  literalExpression: ["expressionLanguage"]
};

/** Attributes and elements that carry no behaviour: ids, the modeler's own metadata, column widths and the diagram. */
const PRESENTATION_ATTRIBUTES = new Set(["id", "exporter", "exporterVersion", "namespace", "biodi:width", "biodi:annotationsWidth"]);
const KNOWN_ELEMENTS = new Set([
  "definitions",
  "decision",
  "variable",
  "informationRequirement",
  "requiredDecision",
  "decisionTable",
  "input",
  "inputExpression",
  "output",
  "rule",
  "description",
  "inputEntry",
  "outputEntry",
  "literalExpression",
  "text"
]);

export interface Inspection {
  /** Things the model does not carry and the generator recreates or discards, with how many times each occurred. */
  presentation: Map<string, number>;
  /** Anything else the file contains: a semantic construct the spec has no place for. */
  unrepresentable: Map<string, number>;
}

/** Lists, for one DMN file, what `parseDmn` does not carry into the model. */
export function inspectDmn(xml: string): Inspection {
  const presentation = new Map<string, number>();
  const unrepresentable = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const walk = (name: string, value: unknown) => {
    if (name === "dmndi:DMNDI") {
      bump(presentation, "decision requirements diagram layout (regenerated)");
      return;
    }
    if (!KNOWN_ELEMENTS.has(name)) {
      bump(unrepresentable, `element <${name}>`);
      return;
    }
    for (const node of Array.isArray(value) ? value : [value]) {
      if (typeof node !== "object" || node === null) {
        continue;
      }
      for (const [key, child] of Object.entries(node as Node)) {
        if (key.startsWith("@_")) {
          const attribute = key.slice(2);
          if (attribute.startsWith("xmlns")) {
            continue;
          }
          if (USED_ATTRIBUTES[name]?.includes(attribute)) {
            continue;
          }
          if (PRESENTATION_ATTRIBUTES.has(attribute)) {
            bump(presentation, attribute === "id" ? "element ids (regenerated)" : `attribute ${attribute}`);
          } else {
            bump(unrepresentable, `attribute ${attribute} on <${name}>`);
          }
        } else if (key !== "#text") {
          walk(key, child);
        }
      }
    }
  };
  const root = parser.parse(xml) as Node;
  for (const [key, value] of Object.entries(root)) {
    if (key !== "?xml") {
      walk(key, value);
    }
  }
  return { presentation, unrepresentable };
}
