import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASE, base, VARIED } from "./__fixtures__/model.ts";
import { importDmns } from "./importer.ts";
import { compileModel } from "./model-compile.ts";
import {
  isModelDocument,
  loadSpecFile,
  loadSpecOnly,
  modelLayoutPath,
  orderPathBeside,
  orderPathFor,
  parseModel,
  stringifyModel,
  stringifyOrdering
} from "./model-io.ts";
import { liftSpec } from "./model-lift.ts";
import { diffSpecs } from "./spec-diff.ts";
import { stringifySpec } from "./spec-io.ts";

describe("loadSpecFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-io-"));

  it("should compile a model with its ordering file and read a spec as it is when loading either", () => {
    const model = parseModel(VARIED);
    const lifted = liftSpec(compileModel(model), { order: "m.order.yaml" });
    writeFileSync(join(dir, "m.yaml"), stringifyModel(lifted.model));
    writeFileSync(join(dir, "m.order.yaml"), stringifyOrdering(lifted.ordering));
    const loaded = loadSpecFile(join(dir, "m.yaml"));
    expect(loaded.isModel).toBe(true);
    expect(loaded.layout).toBeUndefined();
    expect(diffSpecs(loaded.spec, compileModel(model))).toEqual([]);
    expect(orderPathFor(join(dir, "m.yaml"), lifted.model)).toBe(join(dir, "m.order.yaml"));

    writeFileSync(join(dir, "s.yaml"), stringifySpec(loaded.spec));
    const plain = loadSpecFile(join(dir, "s.yaml"));
    expect(plain.isModel).toBe(false);
    expect(isModelDocument({ kind: "wa-model" })).toBe(true);
  });
});

describe("loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-review-"));

  it("should fail when a model names an ordering file that does not exist", () => {
    writeFileSync(join(dir, "m.yaml"), `${BASE}order: gone.order.yaml\n`);
    expect(() => loadSpecFile(join(dir, "m.yaml"))).toThrow("names the ordering file gone.order.yaml, which does not exist");
  });

  it("should compile without ordering when no ordering file is named and none sits beside the model", () => {
    writeFileSync(join(dir, "n.yaml"), BASE);
    expect(loadSpecFile(join(dir, "n.yaml")).spec.decisions.initiation?.rows).toHaveLength(2);
  });

  it("should fail when an explicit layout file does not exist, for a model and for a spec", () => {
    writeFileSync(join(dir, "n.yaml"), BASE);
    expect(() => loadSpecFile(join(dir, "n.yaml"), join(dir, "none.layout.yaml"))).toThrow("does not exist");
    writeFileSync(join(dir, "s.yaml"), stringifySpec(compileModel(parseModel(BASE))));
    expect(() => loadSpecFile(join(dir, "s.yaml"), join(dir, "none.layout.yaml"))).toThrow("does not exist");
    expect(loadSpecFile(join(dir, "s.yaml")).layout).toBeUndefined();
  });

  it("should fail when a model's own layout field names a file that does not exist", () => {
    writeFileSync(join(dir, "l.yaml"), `${BASE}layout: missing.layout.yaml\n`);
    expect(() => loadSpecFile(join(dir, "l.yaml"))).toThrow("missing.layout.yaml does not exist");
  });
});

describe("writing models and diffing without their layout", () => {
  const files = readdirSync(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)))
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fileURLToPath(new URL("../test-fixtures/et", import.meta.url)), name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const _model = parseModel(stringifyModel(lifted.model));

  it("should write the model without anchors and aliases when two values are equal", () => {
    expect(stringifyModel(lifted.model)).not.toMatch(/&a\d|\*a\d/);
    expect(stringifyOrdering(lifted.ordering)).not.toMatch(/&a\d|\*a\d/);
  });

  it("should compare models without reading their layout when diffing", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-diff-"));
    writeFileSync(join(dir, "m.yaml"), `${BASE}layout: missing.layout.yaml\n`);
    expect(loadSpecOnly(join(dir, "m.yaml")).decisions.configuration?.rows.length).toBeGreaterThan(0);
  });
});

describe("the ordering file's path", () => {
  it("should name the ordering file beside a model by the one rule when building its path", () => {
    expect(orderPathBeside("out/model.yaml")).toBe("out/model.order.yaml");
    expect(orderPathBeside("out/model.yml")).toBe("out/model.order.yaml");
  });
});

describe("readable errors", () => {
  it("should name the file and the field when a model fails its schema when loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-err-"));
    writeFileSync(join(dir, "bad.yaml"), "kind: wa-model\nversion: 1\nservice: {}\ncaseTypes: []\ntasks: []\n");
    expect(() => loadSpecFile(join(dir, "bad.yaml"))).toThrow(/bad\.yaml is not valid:[\s\S]*service\.slug/);
  });
});

describe("ordering file errors", () => {
  const fixtures = fileURLToPath(new URL("../test-fixtures/et", import.meta.url));
  const files = readdirSync(fixtures)
    .filter((n) => n.startsWith("wa-task-") && n.endsWith(".dmn"))
    .map((name) => ({ name, xml: readFileSync(join(fixtures, name), "utf8") }));
  const { spec } = importDmns(files, { jurisdiction: "EMPLOYMENT" });
  const lifted = liftSpec(spec);
  const _model = parseModel(stringifyModel(lifted.model));

  it("should name the ordering file once in the error when a model's ordering file is missing, and when it is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-order-"));
    writeFileSync(join(dir, "m.yaml"), `${BASE}order: gone.order.yaml\n`);
    let message = "";
    try {
      loadSpecFile(join(dir, "m.yaml"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split(join(dir, "m.yaml")).length - 1).toBe(1);
    writeFileSync(join(dir, "bad.order.yaml"), "version: 2\n");
    writeFileSync(join(dir, "n.yaml"), `${BASE}order: bad.order.yaml\n`);
    expect(() => loadSpecFile(join(dir, "n.yaml"))).toThrow(/bad\.order\.yaml is not valid/);
  });
});

describe("loading a model with a layout of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-spec-model-io-"));

  it("should read the layout the model names and the one given on the command line when loading", () => {
    const lifted = liftSpec(base(), { layout: "named.layout.yaml", order: "m.order.yaml" });
    writeFileSync(join(dir, "m.yaml"), stringifyModel(lifted.model));
    writeFileSync(join(dir, "m.order.yaml"), stringifyOrdering(lifted.ordering));
    writeFileSync(join(dir, "named.layout.yaml"), "version: 1\nfiles: {}\n");
    writeFileSync(join(dir, "other.layout.yaml"), "version: 1\nfiles: {}\n");
    const model = parseModel(stringifyModel(lifted.model));
    expect(modelLayoutPath(join(dir, "m.yaml"), model)).toBe(join(dir, "named.layout.yaml"));
    expect(orderPathFor(join(dir, "missing.yaml"), { ...model, order: undefined })).toBeUndefined();
    expect(loadSpecFile(join(dir, "m.yaml")).layoutPath).toBe(join(dir, "named.layout.yaml"));
    expect(loadSpecFile(join(dir, "m.yaml"), join(dir, "other.layout.yaml")).layoutPath).toBe(join(dir, "other.layout.yaml"));
  });

  it("should read the layout beside a spec when loading it, and none when there is none", () => {
    writeFileSync(join(dir, "s.yaml"), stringifySpec(base()));
    expect(loadSpecFile(join(dir, "s.yaml")).layout).toBeUndefined();
    writeFileSync(join(dir, "s.layout.yaml"), "version: 1\nfiles: {}\n");
    expect(loadSpecFile(join(dir, "s.yaml")).layoutPath).toBe(join(dir, "s.layout.yaml"));
  });
});
