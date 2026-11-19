import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { type DmnDocument, inspectDmn, ncName, parseDmn, readDmn, writeDmn } from "./dmn-model.ts";

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
  it("should give the same document and inspection as parsing and inspecting separately when the file has both", () => {
    const xml = sampleDmn("ct_a").replace("<rule ", '<rule extra="1" ');
    const { document, inspection } = readDmn(xml);
    expect(document).toEqual(parseDmn(xml));
    expect(inspection).toEqual(inspectDmn(xml));
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
