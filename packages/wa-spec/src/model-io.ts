import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { exists, readText } from "./file-io.ts";
import type { Layout } from "./layout.ts";
import { Model, Ordering, validateModel } from "./model.ts";
import { compileModel } from "./model-compile.ts";
import type { Spec } from "./schema.ts";
import { layoutPathFor, parseLayout, specFromDocument, toYaml } from "./spec-io.ts";

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

/**
 * Where a model's ordering file is: its `order` field, which must exist, else `<name>.order.yaml` beside it when that
 * exists. A named file that is missing would compile the rows in another order without a word, so it is an error.
 */
export function orderPathFor(modelPath: string, model: Model): string | undefined {
  if (model.order) {
    const named = resolve(dirname(modelPath), model.order);
    if (!exists(named)) {
      throw new Error(`names the ordering file ${model.order}, which does not exist`);
    }
    return named;
  }
  const beside = orderPathBeside(modelPath);
  return exists(beside) ? beside : undefined;
}

/** Where the ordering file of a model file goes when the model does not name one. */
export const orderPathBeside = (modelPath: string): string => `${modelPath.replace(/\.ya?ml$/, "")}.order.yaml`;

/** Where a layout file is: the one named (by `--layout` or the model's `layout` field), which must exist, else `<name>.layout.yaml` beside the file when that exists. */
export function layoutPathOf(path: string, named: string | undefined, base: string): string | undefined {
  if (named) {
    const resolved = resolve(base, named);
    if (!exists(resolved)) {
      throw new Error(`the layout file ${named} does not exist`);
    }
    return resolved;
  }
  const beside = layoutPathFor(path);
  return exists(beside) ? beside : undefined;
}

export const modelLayoutPath = (modelPath: string, model: Model): string | undefined => layoutPathOf(modelPath, model.layout, dirname(modelPath));

export interface LoadedSpec {
  spec: Spec;
  layout: Layout | undefined;
  /** The layout file's path, for copying it beside a compiled spec. */
  layoutPath: string | undefined;
  isModel: boolean;
}

/** Reads a spec file, or a model file compiled with its ordering, without its layout, which only DMN generation needs. */
function readSpecFile(path: string): { spec: Spec; model: Model | undefined } {
  return explained(path, () => readSpecText(path));
}

/** Runs a read that parses a file, naming the file in whatever goes wrong and, for a schema failure, each field at fault. */
export function explained<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`${path} is not valid:\n${error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
    }
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const readLayout = (path: string): Layout => explained(path, () => parseLayout(readText(path)));

function readSpecText(path: string): { spec: Spec; model: Model | undefined } {
  const text = readText(path);
  const document: unknown = parse(text);
  if (isModelDocument(document)) {
    // compileModel validates, so the model is checked once.
    const model = Model.parse(document);
    const orderPath = orderPathFor(path, model);
    return { spec: compileModel(model, orderPath ? explained(orderPath, () => parseOrdering(readText(orderPath))) : undefined), model };
  }
  return { spec: specFromDocument(document), model: undefined };
}

export const loadSpecOnly = (path: string): Spec => readSpecFile(path).spec;

/** Reads a spec file or a model file as a spec, with the layout beside it, compiling a model with its ordering. */
export function loadSpecFile(path: string, layoutOverride?: string): LoadedSpec {
  const { spec, model } = readSpecFile(path);
  if (model) {
    const layoutPath = layoutOverride ? layoutPathOf(path, layoutOverride, process.cwd()) : modelLayoutPath(path, model);
    return { spec, layout: layoutPath ? readLayout(layoutPath) : undefined, layoutPath, isModel: true };
  }
  const layoutPath = layoutPathOf(path, layoutOverride, process.cwd());
  return { spec, layout: layoutPath ? readLayout(layoutPath) : undefined, layoutPath, isModel: false };
}
