import { XMLParser } from "fast-xml-parser";

export interface DmnInput {
  id?: string;
  /** The text of the column's allowed values, and the id of its `<inputValues>`. */
  allowedValues?: string;
  allowedValuesId?: string;
  expressionId?: string;
  width?: string;
  label?: string;
  inputVariable?: string;
  typeRef?: string;
  expressionLanguage?: string;
  expression: string;
}

export interface DmnOutput {
  id?: string;
  width?: string;
  label?: string;
  name: string;
  typeRef?: string;
}

export interface DmnRule {
  id?: string;
  /** Ids of the entries, parallel to `inputs` and `outputs`. */
  inputIds?: string[];
  outputIds?: string[];
  /** The `expressionLanguage` of each entry, parallel to `inputs` and `outputs`, empty for none. Present only when some entry has one. */
  inputLanguages?: string[];
  outputLanguages?: string[];
  description?: string;
  inputs: string[];
  outputs: string[];
}

export interface DmnTable {
  id?: string;
  annotationsWidth?: string;
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
  variable?: { id?: string; name: string; typeRef?: string };
  /** Ids of the decisions it requires, in document order. */
  requires: string[];
  /** Ids of the information requirements, parallel to `requires`. */
  requirementIds?: string[];
  table?: DmnTable;
  literal?: { id?: string; text: string; expressionLanguage?: string };
}

/** A shape or edge of the decision requirements diagram. An empty `id` means the element has no id attribute. */
export type DmnDiagramItem =
  | { type: "shape"; id: string; ref: string; bounds: { x: string; y: string; width: string; height: string } }
  | { type: "edge"; id: string; ref: string; waypoints: Array<{ x: string; y: string }> };

export interface DmnDiagram {
  id: string;
  items: DmnDiagramItem[];
}

export interface DmnDocument {
  id: string;
  name: string;
  /** The namespace declarations of the root element, as `[attribute, uri]`, in file order. */
  namespaces?: Array<[string, string]>;
  exporter?: string;
  exporterVersion?: string;
  /** Other attributes of the root element the modeler adds, such as `modeler:executionPlatform`, in file order. */
  attributes?: Array<[string, string]>;
  decisions: DmnDecision[];
  diagram?: DmnDiagram;
}

type Node = Record<string, unknown>;

const LIST_TAGS = new Set(["decision", "input", "output", "rule", "inputEntry", "outputEntry", "informationRequirement", "requiredDecision", "description"]);

/** One order-preserving read serves the model, the inspection and the diagram, whose shapes and edges interleave. */
const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  htmlEntities: true,
  trimValues: false,
  preserveOrder: true
});

type Ordered = Array<Record<string, unknown>>;

const childrenOf = (nodes: Ordered, name: string): Ordered => nodes.filter((n) => name in n);

const orderedAttrs = (node: Record<string, unknown>): Node => (node[":@"] ?? {}) as Node;

function parseDiagram(root: Ordered): DmnDiagram | undefined {
  const diagram = childrenOf(
    childrenOf(root, "definitions").flatMap((d) => (d.definitions as Ordered) ?? []),
    "dmndi:DMNDI"
  )
    .flatMap((d) => (d["dmndi:DMNDI"] as Ordered) ?? [])
    .find((n) => "dmndi:DMNDiagram" in n);
  if (!diagram) {
    return undefined;
  }
  const items: DmnDiagramItem[] = [];
  for (const node of (diagram["dmndi:DMNDiagram"] as Ordered) ?? []) {
    const nodeAttrs = orderedAttrs(node);
    if ("dmndi:DMNShape" in node) {
      const bounds = orderedAttrs(childrenOf((node["dmndi:DMNShape"] as Ordered) ?? [], "dc:Bounds")[0] ?? {});
      items.push({
        type: "shape",
        id: attr(nodeAttrs, "id") ?? "",
        ref: attr(nodeAttrs, "dmnElementRef") ?? "",
        bounds: { x: attr(bounds, "x") ?? "0", y: attr(bounds, "y") ?? "0", width: attr(bounds, "width") ?? "0", height: attr(bounds, "height") ?? "0" }
      });
    } else if ("dmndi:DMNEdge" in node) {
      items.push({
        type: "edge",
        id: attr(nodeAttrs, "id") ?? "",
        ref: attr(nodeAttrs, "dmnElementRef") ?? "",
        waypoints: childrenOf((node["dmndi:DMNEdge"] as Ordered) ?? [], "di:waypoint").map((w) => ({
          x: attr(orderedAttrs(w), "x") ?? "0",
          y: attr(orderedAttrs(w), "y") ?? "0"
        }))
      });
    }
  }
  return { id: attr(orderedAttrs(diagram), "id") ?? "", items };
}

/**
 * The ordered tree as an object per element: attributes as `@_name`, children by tag name (a list where a tag repeats or is in
 * `LIST_TAGS`), and an element with text and nothing else as that text.
 */
function groupTree(nodes: Ordered, attrs?: Node): Node | string {
  const out: Node = { ...attrs };
  let text = "";
  let hasChildren = false;
  for (const node of nodes) {
    const tag = Object.keys(node).find((key) => key !== ":@");
    if (tag === undefined || tag.startsWith("?")) {
      continue;
    }
    if (tag === "#text") {
      text += String(node[tag]);
      continue;
    }
    hasChildren = true;
    const value = groupTree(node[tag] as Ordered, node[":@"] as Node | undefined);
    const existing = out[tag];
    if (existing === undefined) {
      out[tag] = LIST_TAGS.has(tag) ? [value] : value;
    } else {
      out[tag] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
  }
  if (!hasChildren && attrs === undefined) {
    return text;
  }
  if (text.trim() !== "") {
    out["#text"] = text;
  }
  return out;
}

/**
 * XML turns a tab or line break written in an attribute value into a space before anything reads it, but a character reference
 * for one survives; the parser decodes both alike, so the literal ones are replaced first.
 */
function normaliseAttributes(xml: string): string {
  return xml.replace(/<[^<>]*>/g, (tag) => tag.replace(/="[^"]*"|='[^']*'/g, (value) => value.replace(/\r\n|[\t\r\n]/g, " ")));
}

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

function entryLanguages(inputs: Node[], outputs: Node[]): { inputLanguages?: string[]; outputLanguages?: string[] } {
  const inputLanguages = inputs.map((entry) => attr(entry, "expressionLanguage") ?? "");
  const outputLanguages = outputs.map((entry) => attr(entry, "expressionLanguage") ?? "");
  return {
    ...(inputLanguages.some(Boolean) ? { inputLanguages } : {}),
    ...(outputLanguages.some(Boolean) ? { outputLanguages } : {})
  };
}

function parseTable(table: Node): DmnTable {
  const inputs = asList(table.input).map((input) => {
    const expression = (input.inputExpression ?? {}) as Node;
    return {
      ...optional<Omit<DmnInput, "expression">>({
        id: attr(input, "id"),
        expressionId: attr(expression, "id"),
        ...(input.inputValues ? { allowedValues: textOf(input.inputValues as Node), allowedValuesId: attr(input.inputValues as Node, "id") } : {}),
        width: attr(input, "biodi:width"),
        label: attr(input, "label"),
        inputVariable: attr(input, "camunda:inputVariable"),
        typeRef: attr(expression, "typeRef"),
        expressionLanguage: attr(expression, "expressionLanguage")
      }),
      expression: textOf(expression)
    };
  });
  const outputs = asList(table.output).map((output) => ({
    ...optional<Omit<DmnOutput, "name">>({
      id: attr(output, "id"),
      width: attr(output, "biodi:width"),
      label: attr(output, "label"),
      typeRef: attr(output, "typeRef")
    }),
    name: attr(output, "name") ?? ""
  }));
  const rules = asList(table.rule).map((rule) => {
    const descriptions = asList(rule.description);
    const description = descriptions.map((d) => (typeof d === "string" ? d : "")).join("");
    const inputEntries = asList(rule.inputEntry);
    const outputEntries = asList(rule.outputEntry);
    return {
      ...optional<{ id?: string }>({ id: attr(rule, "id") }),
      ...(descriptions.length === 0 ? {} : { description }),
      ...entryLanguages(inputEntries, outputEntries),
      inputIds: inputEntries.map((entry) => attr(entry, "id") ?? ""),
      outputIds: outputEntries.map((entry) => attr(entry, "id") ?? ""),
      inputs: inputEntries.map((entry) => textOf(entry)),
      outputs: outputEntries.map((entry) => textOf(entry))
    };
  });
  return {
    ...optional<{ id?: string; annotationsWidth?: string; hitPolicy: string; aggregation?: string }>({
      id: attr(table, "id"),
      annotationsWidth: attr(table, "biodi:annotationsWidth"),
      hitPolicy: attr(table, "hitPolicy") ?? "UNIQUE",
      aggregation: attr(table, "aggregation")
    }),
    inputs,
    outputs,
    rules
  } as DmnTable;
}

/** A DMN file's document, and what the model leaves out of it, from one read of the XML. */
export function readDmn(xml: string): { document: DmnDocument; inspection: Inspection } {
  const ordered = orderedParser.parse(normaliseAttributes(xml)) as Ordered;
  const tree = groupTree(ordered) as Node;
  return { document: documentOf(tree, parseDiagram(ordered)), inspection: inspectTree(tree) };
}

function documentOf(tree: Node, diagram: DmnDiagram | undefined): DmnDocument {
  const root = tree.definitions as Node;
  const decisionNodes = asList(root.decision);
  const decisions = decisionNodes.map((node): DmnDecision => {
    const variable = node.variable as Node | undefined;
    const literal = node.literalExpression as Node | undefined;
    const table = node.decisionTable as Node | undefined;
    const requirements = asList(node.informationRequirement);
    const requires = requirements.flatMap((requirement) =>
      asList(requirement.requiredDecision).map((required) => (attr(required, "href") ?? "").replace(/^#/, ""))
    );
    return {
      id: attr(node, "id") ?? "",
      name: attr(node, "name") ?? "",
      ...optional<{ historyTimeToLive?: string }>({ historyTimeToLive: attr(node, "camunda:historyTimeToLive") }),
      ...(variable
        ? {
            variable: {
              ...optional<{ id?: string; typeRef?: string }>({ id: attr(variable, "id"), typeRef: attr(variable, "typeRef") }),
              name: attr(variable, "name") ?? ""
            }
          }
        : {}),
      requires,
      requirementIds: requirements.map((requirement) => attr(requirement, "id") ?? ""),
      ...(table ? { table: parseTable(table) } : {}),
      ...(literal
        ? {
            literal: {
              ...optional<{ id?: string; expressionLanguage?: string }>({ id: attr(literal, "id"), expressionLanguage: attr(literal, "expressionLanguage") }),
              text: textOf(literal)
            }
          }
        : {})
    };
  });
  const namespaces = Object.entries(root)
    .filter(([key, value]) => key.startsWith("@_xmlns") && typeof value === "string")
    .map(([key, value]): [string, string] => [key.slice(2), value as string]);
  const modeler = Object.entries(root)
    .filter(([key, value]) => key.startsWith("@_modeler:") && typeof value === "string")
    .map(([key, value]): [string, string] => [key.slice(2), value as string]);
  return {
    id: attr(root, "id") ?? "",
    name: attr(root, "name") ?? "",
    ...(namespaces.length > 0 ? { namespaces } : {}),
    ...optional<{ exporter?: string; exporterVersion?: string }>({ exporter: attr(root, "exporter"), exporterVersion: attr(root, "exporterVersion") }),
    ...(modeler.length > 0 ? { attributes: modeler } : {}),
    decisions,
    ...(diagram ? { diagram } : {})
  };
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}

/** A line break or tab in an attribute is written as a character reference, as a parser would otherwise read it as a space. */
function escapeAttr(text: string): string {
  return escapeText(text).replaceAll('"', "&quot;").replaceAll("\n", "&#10;").replaceAll("\t", "&#9;");
}

function attrs(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

/** An XML NCName from arbitrary text, for ids the writer has to invent: anything outside the name characters becomes `_`. */
export function ncName(text: string): string {
  const cleaned = text.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Every id the document already carries. */
function storedIds(doc: DmnDocument): Set<string> {
  const ids = [doc.diagram?.id, ...(doc.diagram?.items.map((item) => item.id) ?? [])];
  for (const decision of doc.decisions) {
    ids.push(decision.id, decision.variable?.id, decision.literal?.id, decision.table?.id, ...(decision.requirementIds ?? []));
    for (const input of decision.table?.inputs ?? []) {
      ids.push(input.id, input.expressionId, input.allowedValuesId);
    }
    for (const output of decision.table?.outputs ?? []) {
      ids.push(output.id);
    }
    for (const rule of decision.table?.rules ?? []) {
      ids.push(rule.id, ...(rule.inputIds ?? []), ...(rule.outputIds ?? []));
    }
  }
  return new Set(ids.filter((id): id is string => Boolean(id)));
}

/**
 * Ids derived from the document's id and the element's position, so regenerating a file never churns them. One that would
 * repeat an id the document already has, stored or generated, gets a number added.
 */
function idFactory(prefix: string, taken: Set<string>): (kind: string, ...parts: Array<string | number>) => string {
  return (kind, ...parts) => uniqueId(ncName(`${kind}_${[prefix, ...parts].join("_")}`), taken);
}

/** `base`, or `base` with the first number added that makes it new to `taken`, which it joins. */
export function uniqueId(base: string, taken: Set<string>): string {
  let candidate = base;
  let n = 0;
  while (taken.has(candidate)) {
    n++;
    candidate = `${base}_${n}`;
  }
  taken.add(candidate);
  return candidate;
}

const NAMESPACES: Array<[string, string]> = [
  ["xmlns", "https://www.omg.org/spec/DMN/20191111/MODEL/"],
  ["xmlns:camunda", "http://camunda.org/schema/1.0/dmn"], // NOSONAR: XML namespace identifiers, never fetched
  ["xmlns:biodi", "http://bpmn.io/schema/dmn/biodi/2.0"], // NOSONAR: XML namespace identifiers, never fetched
  ["xmlns:dmndi", "https://www.omg.org/spec/DMN/20191111/DMNDI/"],
  ["xmlns:dc", "http://www.omg.org/spec/DMN/20180521/DC/"], // NOSONAR: XML namespace identifiers, never fetched
  ["xmlns:di", "http://www.omg.org/spec/DMN/20180521/DI/"] // NOSONAR: XML namespace identifiers, never fetched
];

function text(indent: string, value: string): string {
  return `${indent}<text>${escapeText(value)}</text>\n`;
}

function writeTable(table: DmnTable, id: ReturnType<typeof idFactory>, base: string): string {
  const pad = "      ";
  let out = `    <decisionTable${attrs([
    ["id", table.id ?? id("DecisionTable", base)],
    ["hitPolicy", table.hitPolicy === "UNIQUE" ? undefined : table.hitPolicy],
    ["aggregation", table.aggregation],
    ["biodi:annotationsWidth", table.annotationsWidth]
  ])}>\n`;
  table.inputs.forEach((input, index) => {
    out += `${pad}<input${attrs([
      ["id", input.id ?? id("Input", base, index)],
      ["label", input.label],
      ["biodi:width", input.width],
      ["camunda:inputVariable", input.inputVariable]
    ])}>\n`;
    out += `${pad}  <inputExpression${attrs([
      ["id", input.expressionId ?? id("InputExpression", base, index)],
      ["typeRef", input.typeRef],
      ["expressionLanguage", input.expressionLanguage]
    ])}>\n`;
    out += text(`${pad}    `, input.expression);
    out += `${pad}  </inputExpression>\n`;
    if (input.allowedValues !== undefined) {
      out += `${pad}  <inputValues${attrs([["id", input.allowedValuesId ?? id("InputValues", base, index)]])}>\n${text(`${pad}    `, input.allowedValues)}${pad}  </inputValues>\n`;
    }
    out += `${pad}</input>\n`;
  });
  table.outputs.forEach((output, index) => {
    out += `${pad}<output${attrs([
      ["id", output.id ?? id("Output", base, index)],
      ["label", output.label],
      ["name", output.name],
      ["typeRef", output.typeRef],
      ["biodi:width", output.width]
    ])} />\n`;
  });
  table.rules.forEach((rule, ruleIndex) => {
    out += `${pad}<rule${attrs([["id", rule.id ?? id("Rule", base, ruleIndex)]])}>\n`;
    if (rule.description !== undefined) {
      out += `${pad}  <description>${escapeText(rule.description)}</description>\n`;
    }
    rule.inputs.forEach((entry, index) => {
      out += `${pad}  <inputEntry${attrs([
        ["id", rule.inputIds?.[index] || id("InputEntry", base, ruleIndex, index)],
        ["expressionLanguage", rule.inputLanguages?.[index] || undefined]
      ])}>\n${text(`${pad}    `, entry)}${pad}  </inputEntry>\n`;
    });
    rule.outputs.forEach((entry, index) => {
      out += `${pad}  <outputEntry${attrs([
        ["id", rule.outputIds?.[index] || id("OutputEntry", base, ruleIndex, index)],
        ["expressionLanguage", rule.outputLanguages?.[index] || undefined]
      ])}>\n${text(`${pad}    `, entry)}${pad}  </outputEntry>\n`;
    });
    out += `${pad}</rule>\n`;
  });
  return `${out}    </decisionTable>\n`;
}

/** Serialises the model as a DMN 1.3 file in Camunda Modeler's layout. Ids and diagram items the model lacks are generated. */
export function writeDmn(doc: DmnDocument): string {
  const id = idFactory(doc.id, storedIds(doc));
  let out = "";
  const requirements: Array<{ from: string; to: string; id: string }> = [];
  for (const decision of doc.decisions) {
    out += `  <decision${attrs([
      ["id", decision.id],
      ["name", decision.name],
      ["camunda:historyTimeToLive", decision.historyTimeToLive]
    ])}>\n`;
    if (decision.variable) {
      out += `    <variable${attrs([
        ["id", decision.variable.id ?? id("InformationItem", decision.id)],
        ["name", decision.variable.name],
        ["typeRef", decision.variable.typeRef]
      ])} />\n`;
    }
    decision.requires.forEach((required, index) => {
      const requirementId = decision.requirementIds?.[index] || id("InformationRequirement", decision.id, index);
      requirements.push({ from: decision.id, to: required, id: requirementId });
      out += `    <informationRequirement${attrs([["id", requirementId]])}>\n      <requiredDecision${attrs([["href", `#${required}`]])} />\n    </informationRequirement>\n`;
    });
    if (decision.table) {
      out += writeTable(decision.table, id, decision.id);
    }
    if (decision.literal) {
      out += `    <literalExpression${attrs([
        ["id", decision.literal.id ?? id("LiteralExpression", decision.id)],
        ["expressionLanguage", decision.literal.expressionLanguage]
      ])}>\n${text("      ", decision.literal.text)}    </literalExpression>\n`;
    }
    out += "  </decision>\n";
  }
  out += writeDiagram(doc, requirements, id);
  const declared = doc.namespaces ?? NAMESPACES;
  const missing = NAMESPACES.filter(
    ([name]) => !declared.some(([have]) => have === name) && (name === "xmlns" || new RegExp(`[<\\s]${name.slice(6)}:`).test(out))
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions${attrs([...declared, ...missing])}${attrs([
    ["id", doc.id],
    ["name", doc.name],
    ["namespace", "http://camunda.org/schema/1.0/dmn"], // NOSONAR: the DMN namespace the Camunda engine expects
    ["exporter", doc.exporter ?? "Camunda Modeler"],
    ["exporterVersion", doc.exporterVersion ?? "5.50.1"],
    ...(doc.attributes ?? [])
  ])}>
${out}</definitions>
`;
}

const SHAPE_WIDTH = 180;
const SHAPE_HEIGHT = 80;

/**
 * The model's diagram where it has one, kept to the decisions and requirements that still exist; a decision or
 * requirement without a shape or edge gets one in a left-to-right grid, the first decision at the top left.
 */
function writeDiagram(doc: DmnDocument, requirements: Array<{ from: string; to: string; id: string }>, id: ReturnType<typeof idFactory>): string {
  const decisionIds = new Set(doc.decisions.map((d) => d.id));
  const requirementIds = new Set(requirements.map((r) => r.id));
  const items = (doc.diagram?.items ?? []).filter((item) => (item.type === "shape" ? decisionIds.has(item.ref) : requirementIds.has(item.ref)));
  const shaped = new Set(items.filter((item) => item.type === "shape").map((item) => item.ref));
  const edged = new Set(items.filter((item) => item.type === "edge").map((item) => item.ref));
  const main = doc.decisions.find((d) => d.table) ?? doc.decisions[0];
  const others = doc.decisions.filter((d) => d !== main);
  for (const decision of doc.decisions) {
    if (!shaped.has(decision.id)) {
      const slot = others.indexOf(decision);
      const at = decision === main ? { x: 160, y: 80 } : { x: 160 + (slot % 4) * 220, y: 250 + Math.floor(slot / 4) * 170 };
      items.push({
        type: "shape",
        id: id("DMNShape", decision.id),
        ref: decision.id,
        bounds: { x: String(at.x), y: String(at.y), width: String(SHAPE_WIDTH), height: String(SHAPE_HEIGHT) }
      });
    }
  }
  const boundsOf = new Map(items.flatMap((item) => (item.type === "shape" ? [[item.ref, item.bounds] as const] : [])));
  for (const requirement of requirements) {
    if (!edged.has(requirement.id)) {
      const from = boundsOf.get(requirement.from);
      const to = boundsOf.get(requirement.to);
      const at = (bounds: typeof from, dx: number, dy: number) => ({
        x: String(Number(bounds?.x ?? 0) + dx),
        y: String(Number(bounds?.y ?? 0) + dy)
      });
      items.push({
        type: "edge",
        id: id("DMNEdge", requirement.id),
        ref: requirement.id,
        waypoints: [at(to, SHAPE_WIDTH / 2, 0), at(from, SHAPE_WIDTH / 2, SHAPE_HEIGHT)]
      });
    }
  }
  let out = `  <dmndi:DMNDI>\n    <dmndi:DMNDiagram${attrs([["id", (doc.diagram ? doc.diagram.id : id("DMNDiagram", "drd")) || undefined]])}>\n`;
  for (const item of items) {
    if (item.type === "shape") {
      out += `      <dmndi:DMNShape${attrs([
        ["id", item.id || undefined],
        ["dmnElementRef", item.ref]
      ])}>\n        <dc:Bounds${attrs([
        ["height", item.bounds.height],
        ["width", item.bounds.width],
        ["x", item.bounds.x],
        ["y", item.bounds.y]
      ])} />\n      </dmndi:DMNShape>\n`;
    } else {
      out += `      <dmndi:DMNEdge${attrs([
        ["id", item.id || undefined],
        ["dmnElementRef", item.ref]
      ])}>\n`;
      for (const point of item.waypoints) {
        out += `        <di:waypoint${attrs([
          ["x", point.x],
          ["y", point.y]
        ])} />\n`;
      }
      out += "      </dmndi:DMNEdge>\n";
    }
  }
  return `${out}    </dmndi:DMNDiagram>\n  </dmndi:DMNDI>\n`;
}

/** The attributes of each element the model carries. */
const USED_ATTRIBUTES: Record<string, string[]> = {
  definitions: ["id", "name", "exporter", "exporterVersion"],
  decision: ["id", "name", "camunda:historyTimeToLive"],
  variable: ["id", "name", "typeRef"],
  informationRequirement: ["id"],
  requiredDecision: ["href"],
  decisionTable: ["id", "hitPolicy", "aggregation", "biodi:annotationsWidth"],
  input: ["id", "label", "biodi:width", "camunda:inputVariable"],
  inputExpression: ["id", "typeRef", "expressionLanguage"],
  inputValues: ["id"],
  output: ["id", "label", "name", "typeRef", "biodi:width"],
  rule: ["id"],
  inputEntry: ["id", "expressionLanguage"],
  outputEntry: ["id", "expressionLanguage"],
  literalExpression: ["id", "expressionLanguage"]
};

/** Attributes that carry no behaviour and that the writer states afresh. */
const PRESENTATION_ATTRIBUTES = new Set(["namespace"]);

/** Where the model has a place for each element: its parents. A known element under any other parent is dropped by a round trip. */
const KNOWN_ELEMENTS: Record<string, string[]> = {
  definitions: [""],
  decision: ["definitions"],
  variable: ["decision"],
  informationRequirement: ["decision"],
  requiredDecision: ["informationRequirement"],
  decisionTable: ["decision"],
  input: ["decisionTable"],
  inputExpression: ["input"],
  inputValues: ["input"],
  output: ["decisionTable"],
  rule: ["decisionTable"],
  description: ["rule"],
  inputEntry: ["rule"],
  outputEntry: ["rule"],
  literalExpression: ["decision"],
  text: ["inputExpression", "inputValues", "inputEntry", "outputEntry", "literalExpression"]
};

export interface Inspection {
  /** Things the model does not carry and the generator recreates or discards, with how many times each occurred. */
  presentation: Map<string, number>;
  /** Anything else the file contains: a semantic construct the spec has no place for. */
  unrepresentable: Map<string, number>;
  /** What each unrepresentable construct holds, one canonical text per occurrence, so a change of value can be told. */
  values: Map<string, string[]>;
}

/** An unmodelled element as text, without its ids. */
const canonicalNode = (value: unknown): string => JSON.stringify(value, (key, v) => (key === "@_id" ? undefined : v));

/** Lists, for one DMN file, what the model does not carry. */
function inspectTree(root: Node): Inspection {
  const presentation = new Map<string, number>();
  const unrepresentable = new Map<string, number>();
  const values = new Map<string, string[]>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const flagged = (key: string, value: string) => {
    bump(unrepresentable, key);
    values.set(key, [...(values.get(key) ?? []), value]);
  };
  const walk = (name: string, parent: string, value: unknown) => {
    if (name === "dmndi:DMNDI") {
      return;
    }
    if (!KNOWN_ELEMENTS[name]) {
      flagged(`element <${name}>`, canonicalNode(value));
      return;
    }
    if (!KNOWN_ELEMENTS[name]?.includes(parent)) {
      flagged(`element <${name}> in <${parent}>`, canonicalNode(value));
      return;
    }
    for (const node of Array.isArray(value) ? value : [value]) {
      if (typeof node !== "object" || node === null) {
        continue;
      }
      for (const [key, child] of Object.entries(node as Node)) {
        if (key.startsWith("@_")) {
          const attribute = key.slice(2);
          if (attribute.startsWith("xmlns") || (name === "definitions" && attribute.startsWith("modeler:")) || USED_ATTRIBUTES[name]?.includes(attribute)) {
            continue;
          }
          if (PRESENTATION_ATTRIBUTES.has(attribute)) {
            bump(presentation, `attribute ${attribute}`);
          } else {
            flagged(`attribute ${attribute} on <${name}>`, String(child));
          }
        } else if (key !== "#text") {
          walk(key, name, child);
        }
      }
    }
  };
  for (const [key, value] of Object.entries(root)) {
    if (key !== "?xml") {
      walk(key, "", value);
    }
  }
  return { presentation, unrepresentable, values };
}
