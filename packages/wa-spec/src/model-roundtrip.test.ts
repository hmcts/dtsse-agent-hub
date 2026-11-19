import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffDocuments } from "./diff.ts";
import { parseDmn } from "./dmn-model.ts";
import { generateAll } from "./generator.ts";
import { importDmns } from "./importer.ts";
import { compileModel } from "./model-compile.ts";
import { parseModel, parseOrdering, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";
import { diffSpecs } from "./spec-diff.ts";
import { parseLayout, stringifyLayout } from "./spec-io.ts";

const resources = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));

describe("ET model round trip", () => {
  const files = readdirSync(resources)
    .filter((name) => name.startsWith("wa-task-") && name.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(resources, name), "utf8") }));
  const { spec, layout } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const model = parseModel(stringifyModel(lifted.model));
  const ordering = parseOrdering(stringifyOrdering(lifted.ordering));

  it("should compile the lifted model back to the imported spec when both files are written and read again", () => {
    expect(diffSpecs(spec, compileModel(model, ordering))).toEqual([]);
  });

  it("should regenerate all 24 ET DMNs with no difference when the DMNs go through spec, model, spec and back", () => {
    const regenerated = generateAll(compileModel(model, ordering), parseLayout(stringifyLayout(layout)));
    expect(regenerated).toHaveLength(24);
    const differences = regenerated.flatMap((generated) => {
      const original = files.find((f) => f.name === generated.fileName);
      return diffDocuments(generated.fileName, parseDmn(original?.xml ?? ""), parseDmn(generated.xml));
    });
    expect(differences).toEqual([]);
  });

  it("should regenerate every file with its ids and layout when the layout is applied to the compiled model", () => {
    for (const generated of generateAll(compileModel(model, ordering), parseLayout(stringifyLayout(layout)))) {
      const original = files.find((f) => f.name === generated.fileName);
      expect(parseDmn(generated.xml), generated.fileName).toEqual(parseDmn(original?.xml ?? ""));
    }
  });

  it("should keep only the rows that complete no task out of the model when lifting ET", () => {
    const residue = Object.values(lifted.report.counts).reduce((n, c) => n + c.residue, 0);
    expect(residue).toBe(2);
    expect(lifted.report.counts.initiation).toEqual({ rows: 70, lifted: 70, residue: 0 });
  });
});
