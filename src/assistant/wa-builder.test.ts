import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLayout, parseModel, parseOrdering } from "@hmcts-cft/wa-spec";
import { describe, expect, it } from "vitest";
import { MAX_WA_DOCUMENT_BYTES, readWaDocuments, WA_SERVICE_PATTERN, waDocuments, waSpecProblems } from "./wa-builder.ts";

const example = (name: string) => readFileSync(fileURLToPath(new URL(`../../packages/wa-spec/examples/et/${name}`, import.meta.url)), "utf8");
const model = parseModel(example("model.yaml"));
const ordering = parseOrdering(example("model.order.yaml"));
const layout = parseLayout(example("spec.layout.yaml"));

describe("waSpecProblems", () => {
  it("should find nothing wrong when the spec is ET's example", () => {
    expect(waSpecProblems({ service: "employment", model, ordering })).toEqual([]);
  });

  it("should refuse when the service is not a slug", () => {
    expect(waSpecProblems({ service: "Employment", model, ordering })).toHaveLength(1);
  });

  it("should refuse when the model is for another service", () => {
    expect(waSpecProblems({ service: "civil", model, ordering })).toEqual(['the model is for "employment", not "civil"']);
  });

  it("should report the broken references when a task is limited to a case type the model lacks", () => {
    const first = model.tasks[0];
    if (first === undefined) {
      throw new Error("the example has no tasks");
    }
    const broken = { ...model, tasks: [{ ...first, only: ["no_such_case_type"] }, ...model.tasks.slice(1)] };
    expect(waSpecProblems({ service: "employment", model: broken, ordering }).join("\n")).toContain("no_such_case_type");
  });
});

describe("waDocuments", () => {
  it("should read back what it stored when the spec is ET's example with its ordering and layout", () => {
    const stored = waDocuments({ service: "employment", model, ordering, layout });
    expect(stored.displayName).toBe("Employment");
    const { order: _order, layout: _layout, ...withoutFiles } = model;
    expect(readWaDocuments(stored)).toEqual({ model: withoutFiles, ordering, layout });
  });

  it("should drop the model's order and layout file names when storing", () => {
    expect(model.order).toBeDefined();
    expect(waDocuments({ service: "employment", model }).model).not.toMatch(/^(order|layout):/m);
  });

  it("should refuse when the display name is empty or over the limit", () => {
    const named = (displayName: string) => ({ ...model, service: { ...model.service, displayName } });
    expect(() => waDocuments({ service: "employment", model: named("") })).toThrow(/display name/);
    expect(() => waDocuments({ service: "employment", model: named("x".repeat(201)) })).toThrow(/display name/);
  });

  it("should refuse when a document reads back differently, naming the first difference", () => {
    const lossy = { ...layout, files: { ...layout.files, extra: undefined } } as unknown as typeof layout;
    expect(() => waDocuments({ service: "employment", model, layout: lossy })).toThrow(/would not read back the same: layout\.files/);
  });

  it("should refuse when a document would not read back", () => {
    const broken = { version: 1, files: "no" } as unknown as typeof layout;
    expect(() => waDocuments({ service: "employment", model, layout: broken })).toThrow(/would not read back/);
  });

  it("should store no ordering or layout when there are none", () => {
    const stored = waDocuments({ service: "employment", model });
    expect(stored.ordering).toBeNull();
    expect(readWaDocuments(stored).layout).toBeUndefined();
  });

  it("should refuse when a document is over the limit", () => {
    const huge = { ...model, tasks: [{ ...model.tasks[0], name: "x".repeat(MAX_WA_DOCUMENT_BYTES) }] } as typeof model;
    expect(() => waDocuments({ service: "employment", model: huge })).toThrow(/over 2 MiB/);
  });
});

describe("WA_SERVICE_PATTERN", () => {
  it("should accept hyphens and underscores when the slug is lowercase and refuse a leading hyphen", () => {
    expect(WA_SERVICE_PATTERN.test("family-private-law")).toBe(true);
    expect(WA_SERVICE_PATTERN.test("possession_service")).toBe(true);
    expect(WA_SERVICE_PATTERN.test("-x")).toBe(false);
  });
});
