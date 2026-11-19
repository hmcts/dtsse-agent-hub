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
export const WA_SERVICE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The largest stored document. ET's layout is about 300 KB, its model about 150 KB. */
export const MAX_WA_DOCUMENT_BYTES = 2 * 1024 * 1024;

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
  ordering?: Ordering | undefined;
  layout?: Layout | undefined;
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
    return [`"${service}" is not a service: use lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters`];
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

/** The documents to store, refusing any over the size limit. */
export function waDocuments({ model, ordering, layout }: WaSpecInput): WaSpecDocuments {
  const documents = {
    displayName: model.service.displayName ?? model.service.slug,
    model: stringifyModel(model),
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
  return documents;
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
