import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { exists, readText } from "./file-io.ts";
import type { Layout } from "./layout.ts";
import { Model, Ordering, validateModel } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import type { Spec } from "./schema.ts";
import { layoutPathFor, parseLayout, parseSpec, toYaml } from "./spec-io.ts";

/** Whether a parsed YAML document is a model rather than a table-centric spec. */
export const isModelDocument = (document: unknown): boolean =>
  typeof document === "object" && document !== null && (document as { kind?: unknown }).kind === "wa-model";

/** Parses and checks a model: the shape first, then the references between its parts. */
export function parseModel(yamlText: string): Model {
  const model = Model.parse(parse(yamlText));
  const problems = validateModel(model);
  if (problems.length > 0) {
    throw new Error(`Invalid model:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return model;
}

/** Lists of up to a dozen short values (permissions, case types, events) stay on one line, so a task reads as a few lines. */
const MODEL_SHORT_LIST = 12;

export const stringifyModel = (model: Model): string => toYaml(model, MODEL_SHORT_LIST);

export function parseOrdering(yamlText: string): Ordering {
  return Ordering.parse(parse(yamlText));
}

export const stringifyOrdering = (ordering: Ordering): string => toYaml(ordering);

/** Where a model's ordering file is: its `order` field, else `<name>.order.yaml` beside it, when that exists. */
export function orderPathFor(modelPath: string, model: Model): string | undefined {
  const path = model.order ? resolve(dirname(modelPath), model.order) : `${modelPath.replace(/\.ya?ml$/, "")}.order.yaml`;
  return exists(path) ? path : undefined;
}

/** Where a model's layout file is: its `layout` field, else `<name>.layout.yaml` beside it, when that exists. */
export function modelLayoutPath(modelPath: string, model: Model): string | undefined {
  const path = model.layout ? resolve(dirname(modelPath), model.layout) : layoutPathFor(modelPath);
  return exists(path) ? path : undefined;
}

export interface LoadedSpec {
  spec: Spec;
  layout: Layout | undefined;
  /** The layout file's path, for copying it beside a compiled spec. */
  layoutPath: string | undefined;
  isModel: boolean;
}

/** Reads a spec file or a model file as a spec, with the layout beside it, compiling a model with its ordering. */
export function loadSpecFile(path: string, layoutOverride?: string): LoadedSpec {
  const text = readText(path);
  if (isModelDocument(parse(text))) {
    const model = parseModel(text);
    const orderPath = orderPathFor(path, model);
    const spec = compileModel(model, orderPath ? parseOrdering(readText(orderPath)) : undefined);
    const layoutPath = layoutOverride ? resolve(layoutOverride) : modelLayoutPath(path, model);
    return { spec, layout: layoutPath ? parseLayout(readText(layoutPath)) : undefined, layoutPath, isModel: true };
  }
  const layoutPath = layoutOverride ? resolve(layoutOverride) : layoutPathFor(path);
  return {
    spec: parseSpec(text),
    layout: exists(layoutPath) ? parseLayout(readText(layoutPath)) : undefined,
    layoutPath: exists(layoutPath) ? layoutPath : undefined,
    isModel: false
  };
}
