import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffDocuments } from "./diff.ts";
import { parseDmn } from "./dmn-model.ts";
import { generateAll } from "./generator.ts";
import { importDmns } from "./importer.ts";
import { byCodePoint } from "./merge.ts";
import { parseLayout, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";
import { taskRows } from "./task-view.ts";

const resources = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));

describe("ET round trip", () => {
  const files = readdirSync(resources)
    .filter((name) => name.startsWith("wa-task-") && name.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(resources, name), "utf8") }));
  const { spec, layout, report } = importDmns(files, { jurisdiction: "EMPLOYMENT" });

  it("should import all 24 DMNs into one spec of four case types when the files are ET's", () => {
    expect(files).toHaveLength(24);
    expect(spec.caseTypes.map((c) => c.id)).toEqual(["et_englandwales", "et_englandwales_multiple", "et_scotland", "et_scotland_multiple"]);
    expect(Object.keys(spec.decisions).sort(byCodePoint)).toEqual(["cancellation", "completion", "configuration", "initiation", "permissions", "task-types"]);
    expect(report.unrepresentable).toEqual([]);
  });

  it("should collapse the four case types so each rule is stored once when they share it", () => {
    const stored = Object.values(spec.decisions).reduce((n, d) => n + (d?.rows.length ?? 0), 0);
    const original = report.files.reduce((n, f) => n + f.rules, 0);
    expect(stored).toBeLessThan(original * 0.6);
  });

  it("should regenerate DMNs with no semantic difference from the originals when generated from the spec", () => {
    const regenerated = generateAll(parseSpec(stringifySpec(spec)), parseLayout(stringifyLayout(layout)));
    expect(regenerated.map((f) => f.fileName).sort(byCodePoint)).toEqual(files.map((f) => f.name).sort(byCodePoint));
    const differences = regenerated.flatMap((generated) => {
      const original = files.find((f) => f.name === generated.fileName);
      return diffDocuments(generated.fileName, parseDmn(original?.xml ?? ""), parseDmn(generated.xml));
    });
    expect(differences).toEqual([]);
  });

  it("should regenerate every original file with its ids, widths and diagram when the layout is applied", () => {
    const regenerated = generateAll(parseSpec(stringifySpec(spec)), parseLayout(stringifyLayout(layout)));
    for (const generated of regenerated) {
      const original = files.find((f) => f.name === generated.fileName);
      expect(parseDmn(generated.xml), generated.fileName).toEqual(parseDmn(original?.xml ?? ""));
    }
  });

  it("should keep every column the tests read by variable and name in order when regenerating", () => {
    const permissions = generateAll(spec).find((f) => f.fileName === "wa-task-permissions-employment-et_englandwales.dmn");
    const table = parseDmn(permissions?.xml ?? "").decisions[0]?.table;
    expect(table?.hitPolicy).toBe("RULE ORDER");
    expect(table?.inputs.map((i) => i.inputVariable)).toEqual(["taskType", "case"]);
    expect(table?.outputs.map((o) => o.name)).toEqual([
      "caseAccessCategory",
      "name",
      "value",
      "roleCategory",
      "authorisations",
      "assignmentPriority",
      "autoAssignable"
    ]);
    expect(table?.rules).toHaveLength(21);
  });

  it("should give the same spec when the regenerated DMNs are imported again", () => {
    const again = importDmns(
      generateAll(spec).map((f) => ({ name: f.fileName, xml: f.xml })),
      { jurisdiction: "EMPLOYMENT" }
    );
    expect(again.spec).toEqual(spec);
  });

  it("should gather the rows about one task across every kind when asked for ET1 Vetting", () => {
    const found = taskRows(spec, "Et1Vetting");
    expect(found.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["initiation", "configuration", "permissions", "completion", "task-types", "cancellation"])
    );
  });
});

describe("ET with columns added", () => {
  it("should give every generated DMN unique ids when an input and an output column are added to every kind", () => {
    const files = readdirSync(resources)
      .filter((name) => name.startsWith("wa-task-") && name.endsWith(".dmn"))
      .map((name) => ({ name, xml: readFileSync(join(resources, name), "utf8") }));
    const { spec, layout } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
    for (const decision of Object.values(spec.decisions)) {
      decision?.inputs.push({ key: "addedIn", expression: { field: "x" } });
      decision?.outputs.push({ name: "addedOut" });
    }
    const generated = generateAll(parseSpec(stringifySpec(spec)), layout);
    expect(generated).toHaveLength(24);
    for (const file of generated) {
      const ids = [...file.xml.matchAll(/ id="([^"]*)"/g)].map((m) => m[1] as string);
      const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(repeated, file.fileName).toEqual([]);
    }
  });
});
