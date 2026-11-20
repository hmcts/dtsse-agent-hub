import { describe, expect, it } from "vitest";
import { inspectDmn, parseDmn, sampleDmn } from "./__fixtures__/dmn.ts";
import { type DmnDocument, ncName, readDmn, writeDmn } from "./dmn-model.ts";

describe("parseDmn and writeDmn", () => {
  it("should read back what was written when the document is written and parsed again", () => {
    const first = parseDmn(sampleDmn("ct_a"));
    const second = parseDmn(writeDmn(first));
    expect(second).toEqual(first);
    expect(first.decisions[0]?.table?.rules).toHaveLength(2);
    expect(first.decisions[0]?.requires).toEqual(["Decision_LATEST"]);
  });

  it("should keep entry text exactly when it holds markup characters, quotes and line breaks", () => {
    const xml = writeDmn({
      id: "d",
      name: "DRD",
      decisions: [
        {
          id: "x",
          name: "x",
          requires: [],
          table: {
            hitPolicy: "UNIQUE",
            inputs: [{ expression: "" }],
            outputs: [{ name: "o" }],
            rules: [{ inputs: ["< 3"], outputs: ['if a < b & c > d then "q"\nelse "r"'] }]
          }
        }
      ]
    });
    expect(xml).toContain("&lt; 3");
    expect(parseDmn(xml).decisions[0]?.table?.rules[0]).toMatchObject({ inputs: ["< 3"], outputs: ['if a < b & c > d then "q"\nelse "r"'] });
  });

  it("should omit the hit policy attribute when it is the default UNIQUE", () => {
    const xml = writeDmn({
      id: "d",
      name: "DRD",
      decisions: [{ id: "x", name: "x", requires: [], table: { hitPolicy: "UNIQUE", inputs: [], outputs: [{ name: "o" }], rules: [] } }]
    });
    expect(xml).not.toContain("hitPolicy");
    expect(parseDmn(xml).decisions[0]?.table?.hitPolicy).toBe("UNIQUE");
  });
});

describe("inspectDmn", () => {
  it("should find nothing unrepresentable and only the namespace as presentation when the file is ordinary", () => {
    const { presentation, unrepresentable } = inspectDmn(sampleDmn("ct_a"));
    expect(unrepresentable.size).toBe(0);
    expect([...presentation.keys()]).toEqual(["attribute namespace"]);
  });

  it("should report a description on a decision, input or output when the file has one", () => {
    const xml = sampleDmn("ct_a")
      .replace("<variable", "<description>about</description><variable")
      .replace('<inputExpression id="InputExpression', '<description>in</description><inputExpression id="InputExpression')
      .replace("<rule ", "<description>x</description><rule ");
    const { unrepresentable } = inspectDmn(xml);
    expect([...unrepresentable.keys()]).toEqual(
      expect.arrayContaining(["element <description> in <decision>", "element <description> in <input>", "element <description> in <decisionTable>"])
    );
  });

  it("should report a known element under a parent that has no place for it when the file nests it oddly", () => {
    const xml = sampleDmn("ct_a").replace("<rule ", '<input id="stray"><inputExpression><text/></inputExpression></input><rule ');
    expect([...inspectDmn(xml).unrepresentable.keys()]).not.toContain("element <input> in <rule>");
    const odd = sampleDmn("ct_a").replace("<inputEntry ", '<variable name="v" /><inputEntry ');
    expect(inspectDmn(odd).unrepresentable.get("element <variable> in <rule>")).toBe(1);
  });

  it("should report an element or attribute the model has no place for when the file has one", () => {
    const xml = sampleDmn("ct_a")
      .replace(
        '<output id="Output_wa-completion-definition-ct_a_',
        '<outputValues><text>"A"</text></outputValues><output id="Output_wa-completion-definition-ct_a_'
      )
      .replace("<rule ", '<rule extra="1" ');
    const { unrepresentable } = inspectDmn(xml);
    expect(unrepresentable.get("element <outputValues>")).toBe(1);
    expect([...unrepresentable.keys()]).toContain("attribute extra on <rule>");
  });
});

describe("ids and diagram", () => {
  it("should keep every id, width and diagram item in order when a file is parsed and written again", () => {
    const xml = sampleDmn("ct_a")
      .replace(
        '<input id="Input_wa-completion-definition-ct_a_wa-task-completion-demo-ct_a_0"',
        '<input biodi:width="321" id="Input_wa-completion-definition-ct_a_wa-task-completion-demo-ct_a_0"'
      )
      .replace(/<dmndi:DMNShape id="[^"]*"/, '<dmndi:DMNShape id="Shape_mine"');
    const doc = parseDmn(xml);
    expect(doc.decisions[0]?.table?.inputs[0]?.width).toBe("321");
    expect(doc.diagram?.items[0]).toMatchObject({ type: "shape", id: "Shape_mine" });
    expect(parseDmn(writeDmn(doc))).toEqual(doc);
  });

  it("should keep an edge before the shape that follows it when the diagram interleaves them", () => {
    const xml = writeDmn({
      id: "d",
      name: "DRD",
      decisions: [
        { id: "m", name: "m", requires: ["h"], table: { hitPolicy: "UNIQUE", inputs: [], outputs: [{ name: "o" }], rules: [] } },
        { id: "h", name: "h", requires: [], literal: { text: "1" } }
      ],
      diagram: {
        id: "",
        items: [
          { type: "edge", id: "", ref: "InformationRequirement_d_m_0", waypoints: [{ x: "1", y: "2" }] },
          { type: "shape", id: "", ref: "m", bounds: { x: "5", y: "6", width: "7", height: "8" } },
          { type: "shape", id: "S", ref: "h", bounds: { x: "9", y: "9", width: "7", height: "8" } }
        ]
      }
    });
    const items = parseDmn(xml).diagram?.items ?? [];
    expect(items.map((i) => i.type)).toEqual(["edge", "shape", "shape"]);
    expect(xml).toContain("<dmndi:DMNDiagram>");
    expect(xml).toContain('<dmndi:DMNShape dmnElementRef="m">');
  });

  it("should invent valid, escaped ids when names hold spaces, quotes and markup", () => {
    const xml = writeDmn({
      id: "d x",
      name: "DRD",
      decisions: [{ id: 'a"b', name: "n", requires: [], literal: { text: "1" } }]
    });
    const ids = [...xml.matchAll(/ id="([^"]*)"/g)].map((m) => m[1] as string);
    expect(ids).toContain("a&quot;b");
    for (const id of ids.filter((i) => i !== "a&quot;b" && i !== "d x")) {
      expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    }
  });
});

describe("ncName", () => {
  it.each([
    ["Decision_ok-1.2", "Decision_ok-1.2"],
    ["a b/c", "a_b_c"],
    ["1abc", "_1abc"],
    ["", "_"]
  ])("should turn %j into %j when making an id", (text, expected) => {
    expect(ncName(text)).toBe(expected);
  });
});

describe("entities and namespaces", () => {
  it("should decode character references in attributes and text when a Modeler-style file has them", () => {
    const xml = sampleDmn("ct_a")
      .replace('label="Event ID"', 'label="a &#34;b&#34; &amp;#34;"')
      .replace("<rule ", "<rule ")
      .replace(/(<rule[^>]*>)/, "$1<description>line&#10;two</description>");
    const doc = parseDmn(xml);
    expect(doc.decisions[0]?.table?.inputs[0]?.label).toBe('a "b" &#34;');
    expect(doc.decisions[0]?.table?.rules[0]?.description).toBe("line\ntwo");
    const again = parseDmn(writeDmn(doc));
    expect(again.decisions[0]?.table?.inputs[0]?.label).toBe('a "b" &#34;');
    expect(again.decisions[0]?.table?.rules[0]?.description).toBe("line\ntwo");
    expect(writeDmn(doc)).not.toContain("&amp;#34;&amp;");
  });

  it("should write a line break in an attribute as a character reference when the label has one", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    const input = doc.decisions[0]?.table?.inputs[0];
    if (input) {
      input.label = "two\nlines";
    }
    const xml = writeDmn(doc);
    expect(xml).toContain('label="two&#10;lines"');
    expect(parseDmn(xml).decisions[0]?.table?.inputs[0]?.label).toBe("two\nlines");
  });

  it("should declare every prefix the output uses when the stored declarations lack some", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    doc.namespaces = [["xmlns", "https://www.omg.org/spec/DMN/20191111/MODEL/"]];
    const root = /<definitions[^>]*>/.exec(writeDmn(doc))?.[0] ?? "";
    for (const prefix of ["camunda", "dmndi", "dc", "di"]) {
      expect(root).toContain(`xmlns:${prefix}=`);
    }
    expect(root).not.toContain("xmlns:biodi");
  });

  it("should keep the stored declarations first and in order when it adds the missing ones", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    doc.namespaces = [
      ["xmlns:dc", "http://www.omg.org/spec/DMN/20180521/DC/"],
      ["xmlns", "https://www.omg.org/spec/DMN/20191111/MODEL/"]
    ];
    const root = /<definitions[^>]*>/.exec(writeDmn(doc))?.[0] ?? "";
    expect(root.indexOf("xmlns:dc=")).toBeLessThan(root.indexOf('xmlns="'));
    expect(root.indexOf('xmlns="')).toBeLessThan(root.indexOf("xmlns:camunda="));
  });
});

describe("readDmn", () => {
  it("should give the document and what the model leaves out when the file has an extra attribute", () => {
    const { document, inspection } = readDmn(sampleDmn("ct_a").replace("<rule ", '<rule extra="1" '));
    expect(document.decisions[0]?.table?.rules).toHaveLength(2);
    expect(inspection.unrepresentable.get("attribute extra on <rule>")).toBe(1);
  });
});

describe("fallback diagram", () => {
  it("should lay helpers out from the first grid slot when the table decision is not first", () => {
    const doc = parseDmn(sampleDmn("ct_a"));
    const [table, helper] = doc.decisions as [DmnDocument["decisions"][number], DmnDocument["decisions"][number]];
    const xml = writeDmn({ id: "d", name: "DRD", decisions: [helper, table] });
    const shapes = parseDmn(xml).diagram?.items.filter((i) => i.type === "shape") ?? [];
    const at = (ref: string) => (shapes.find((s) => s.ref === ref) as { bounds: { x: string; y: string } }).bounds;
    expect(at(table.id)).toMatchObject({ x: "160", y: "80" });
    expect(at(helper.id)).toMatchObject({ x: "160", y: "250" });
  });
});

describe("attribute value normalisation", () => {
  it("should read a tab or line break written in an attribute as a space and keep one written as a character reference when a file has both", () => {
    const xml = sampleDmn("ct_a")
      .replace('label="Event ID"', 'label="a\t\tb\nc&#10;d"')
      .replace('camunda:inputVariable="eventId"', 'camunda:inputVariable="eventId\t\t"');
    const input = readDmn(xml).document.decisions[0]?.table?.inputs[0];
    expect(input?.label).toBe("a  b c\nd");
    expect(input?.inputVariable).toBe("eventId  ");
  });

  it("should leave tabs and line breaks in element text alone when the file has them", () => {
    const xml = sampleDmn("ct_a").replace('"submit", "update"', '"submit",\n\t"update"');
    expect(readDmn(xml).document.decisions[0]?.table?.rules[0]?.inputs[0]).toBe('"submit",\n\t"update"');
  });
});

describe("roots and empty values", () => {
  const prefixed = (xml: string) =>
    xml
      .replace(
        /<(\/?)(definitions|decision|variable|informationRequirement|requiredDecision|decisionTable|input|inputExpression|output|rule|description|inputEntry|outputEntry|literalExpression|text)\b/g,
        "<$1dmn:$2"
      )
      .replace("<dmn:definitions ", '<dmn:definitions xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/" ');

  it("should read elements written with the DMN namespace prefix like unprefixed ones when the root is prefixed", () => {
    const xml = sampleDmn("ct_a");
    expect(readDmn(prefixed(xml)).document.decisions).toEqual(readDmn(xml).document.decisions);
    expect(readDmn(prefixed(xml)).inspection.unrepresentable.size).toBe(0);
  });

  it("should write a default DMN namespace when the stored declarations lack one", () => {
    const doc = readDmn(prefixed(sampleDmn("ct_a"))).document;
    expect(/<definitions[^>]*>/.exec(writeDmn(doc))?.[0]).toContain(' xmlns="');
  });

  it("should refuse content that is not a DMN file when the root is something else", () => {
    expect(() => readDmn("<html/>")).toThrow(/not a DMN file: its root element is <html>/);
    expect(() => readDmn("")).toThrow(/root element is missing/);
    expect(() => readDmn('<x:definitions xmlns:x="urn:other"/>')).toThrow(/not bound to a DMN namespace/);
  });

  it("should keep an empty allowed-values element as empty text when the input has one", () => {
    const empty = (element: string) => sampleDmn("ct_a").replace("</inputExpression>", `</inputExpression>${element}`);
    expect(readDmn(empty('<inputValues id="v"><text></text></inputValues>')).document.decisions[0]?.table?.inputs[0]?.allowedValues).toBe("");
    expect(readDmn(empty('<inputValues id="v"/>')).document.decisions[0]?.table?.inputs[0]).toMatchObject({ allowedValues: "", allowedValuesId: "v" });
  });
});

describe("attribute scanning", () => {
  it("should normalise a tab in an attribute value that holds a greater-than sign when the tag has one", () => {
    const xml = sampleDmn("ct_a").replace('label="Event ID"', 'label="a > b\tc"');
    expect(readDmn(xml).document.decisions[0]?.table?.inputs[0]?.label).toBe("a > b c");
  });

  it("should leave tabs in comments and CDATA alone when the file has them", () => {
    const xml = sampleDmn("ct_a").replace("<decision ", "<!-- a\t> b --><decision ");
    expect(readDmn(xml).document.decisions).toHaveLength(2);
  });
});
