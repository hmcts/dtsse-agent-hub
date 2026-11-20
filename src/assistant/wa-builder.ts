import { isDeepStrictEqual } from "node:util";
import {
  compileModel,
  type Layout,
  type Model,
  type Ordering,
  parseLayout,
  parseModel,
  parseOrdering,
  stringifyLayout,
  stringifyModel,
  stringifyOrdering,
  validateModel
} from "@hmcts-cft/wa-spec";

/**
 * Work Allocation specs for the builder pages: what a stored version may hold and the checks a save must pass. Pure;
 * `wa-builder-store.ts` keeps the versions. A spec is stored as the YAML text `@hmcts-cft/wa-spec` writes for its
 * model, ordering and layout, which round-trips them without loss.
 */

/** The same pattern as the `wa_spec_version` CHECK on `service`, so the database is never the first to refuse one. */
export const WA_SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The largest stored document. ET's layout is about 300 KB, its model about 150 KB. */
export const MAX_WA_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** The longest display name the `wa_spec_version` CHECK allows. */
export const MAX_WA_DISPLAY_NAME = 200;

export class InvalidWaSpec extends Error {}

export class WaVersionConflict extends Error {
  constructor(
    readonly latest: number,
    readonly basedOn: number
  ) {
    super(`the spec has moved on to version ${latest}; this edit is based on version ${basedOn}`);
  }
}

export interface WaSpecInput {
  service: string;
  model: Model;
  ordering?: Ordering;
  layout?: Layout;
}

export interface WaSpecDocuments {
  displayName: string;
  model: string;
  ordering: string | null;
  layout: string | null;
}

/** Everything wrong with a spec that would stop it being saved: its slug, its references, and whether it compiles. */
export function waSpecProblems({ service, model, ordering }: WaSpecInput): string[] {
  if (!WA_SERVICE_PATTERN.test(service)) {
    return [`"${service}" is not a service: use lowercase letters, digits, hyphens and underscores, starting with a letter or digit, at most 64 characters`];
  }
  if (model.service.slug !== service) {
    return [`the model is for "${model.service.slug}", not "${service}"`];
  }
  const problems = validateModel(model);
  if (problems.length > 0) {
    return problems;
  }
  try {
    compileModel(model, ordering);
  } catch (error) {
    return [`does not compile: ${error instanceof Error ? error.message : String(error)}`];
  }
  return [];
}

/**
 * The documents to store, refusing any over the size limit or that would not read back. The model's `order` and
 * `layout` file names are dropped: the ordering and layout are columns of their own.
 */
export function waDocuments({ model, ordering, layout }: WaSpecInput): WaSpecDocuments {
  const { order: _order, layout: _layout, ...stored } = model;
  const displayName = model.service.displayName ?? model.service.slug;
  if (displayName.length < 1 || displayName.length > MAX_WA_DISPLAY_NAME) {
    throw new InvalidWaSpec(`the service's display name must be 1 to ${MAX_WA_DISPLAY_NAME} characters`);
  }
  const documents = {
    displayName,
    model: stringifyModel(stored),
    ordering: ordering === undefined ? null : stringifyOrdering(ordering),
    layout: layout === undefined ? null : stringifyLayout(layout)
  };
  for (const [name, text] of [
    ["model", documents.model],
    ["ordering", documents.ordering],
    ["layout", documents.layout]
  ] as const) {
    if (text !== null && Buffer.byteLength(text) > MAX_WA_DOCUMENT_BYTES) {
      throw new InvalidWaSpec(`the ${name} is over ${MAX_WA_DOCUMENT_BYTES / 1024 / 1024} MiB`);
    }
  }
  let read: ReturnType<typeof readWaDocuments>;
  try {
    read = readWaDocuments(documents);
  } catch (error) {
    throw new InvalidWaSpec(`would not read back: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [name, written, parsed] of [
    ["model", stored, read.model],
    ["ordering", ordering, read.ordering],
    ["layout", layout, read.layout]
  ] as const) {
    if (!sameDocument(written, parsed)) {
      throw new InvalidWaSpec(`would not read back the same: ${firstDifference(name, written, parsed)}`);
    }
  }
  return documents;
}

/** Whether two documents are the same once a key set to `undefined` is ignored, as YAML ignores it. */
const sameDocument = (left: unknown, right: unknown): boolean => isDeepStrictEqual(plain(left), plain(right));
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

/** The first top-level entry of a document that differs after a round trip, or the document when it is not an object in both. */
function firstDifference(name: string, written: unknown, parsed: unknown): string {
  if (typeof written === "object" && written !== null && typeof parsed === "object" && parsed !== null) {
    const keys = [...new Set([...Object.keys(written), ...Object.keys(parsed)])];
    const key = keys.find((k) => !sameDocument((written as Record<string, unknown>)[k], (parsed as Record<string, unknown>)[k]));
    if (key !== undefined) {
      return `${name}.${key}`;
    }
  }
  return name;
}

/** A stored row read back as the objects the builder works with. */
export function readWaDocuments(row: { model: string; ordering: string | null; layout: string | null }): {
  model: Model;
  ordering: Ordering | undefined;
  layout: Layout | undefined;
} {
  return {
    model: parseModel(row.model),
    ordering: row.ordering === null ? undefined : parseOrdering(row.ordering),
    layout: row.layout === null ? undefined : parseLayout(row.layout)
  };
}
