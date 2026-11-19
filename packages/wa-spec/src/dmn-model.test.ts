import { describe, expect, it } from "vitest";
import { sampleDmn } from "./__fixtures__/dmn.ts";
import { inspectDmn, parseDmn, writeDmn } from "./dmn-model.ts";

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
    expect(parseDmn(xml).decisions[0]?.table?.rules[0]).toEqual({ inputs: ["< 3"], outputs: ['if a < b & c > d then "q"\nelse "r"'] });
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
  it("should report ids and the diagram as presentation when the file is ordinary", () => {
    const { presentation, unrepresentable } = inspectDmn(sampleDmn("ct_a"));
    expect(unrepresentable.size).toBe(0);
    expect(presentation.get("element ids (regenerated)")).toBeGreaterThan(0);
    expect(presentation.get("decision requirements diagram layout (regenerated)")).toBe(1);
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
