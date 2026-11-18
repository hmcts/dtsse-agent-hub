import { z } from "zod";
import { MAX_DOCX_BYTES, MAX_SUMMARY } from "./docmosis.ts";
import { isLibraryPath } from "./docmosis-library.ts";
import { libraryEntrySize } from "./docmosis-library-store.ts";
import { definePodJobKind, type PodJobRefusal } from "./pod-jobs.ts";

/**
 * Loading a template from the person's template library into a conversation: the `docmosis.load` pod job. The pod
 * fetches the blob with the person's own `gh` sign-in, reads its schema and publishes it through the agent API with
 * `pick` naming the job, and the hub records that write as the person's and finishes the job in the same
 * transaction (`writeAgentDocmosis`). See "Docmosis template library" in docs/agent-api.md.
 */

export const DOCMOSIS_LOAD_KIND = "docmosis.load";

export const STALE_PICK = "the template list has changed; pick again";

export const docmosisLoadArgs = z.strictObject({
  path: z.string().refine((path) => isLibraryPath(path), { message: "must be a .docx in the template library" }),
  blob_sha: z.string().regex(/^[0-9a-f]{40}$/, "must be the blob's git SHA-1, 40 lowercase hex digits"),
  base_version: z.number().int().nonnegative(),
  base_revision: z.number().int().nonnegative()
});

export type DocmosisLoadArgs = z.output<typeof docmosisLoadArgs>;

export const docmosisLoadResult = z.strictObject({
  version: z.number().int().positive(),
  revision: z.number().int().nonnegative()
});

export const DOCMOSIS_LOAD_ERRORS = [
  "signed_out",
  "sso",
  "not_found",
  "rate_limited",
  "too_large",
  "not_docx",
  "checksum",
  "schema_failed",
  "conflict"
] as const;

/** `Loaded <name>`, the summary of a version a pick wrote, from the file's name without its folders, cut to the column's cap. */
export function loadedSummary(path: string): string {
  const summary = `Loaded ${basename(path)}`;
  return summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Only a pair the person's own index holds now may be loaded, and only one the hub would store, so a pick from a list
 * that has moved on, or of a file too big for a template, starts nothing on the pod.
 */
export function pickRefusal(size: number | undefined): PodJobRefusal | undefined {
  if (size === undefined) {
    return { status: 409, error: STALE_PICK };
  }
  if (size > MAX_DOCX_BYTES) {
    return { status: 413, error: `that template is larger than ${MAX_DOCX_BYTES} bytes, more than the Assistant can open` };
  }
  return undefined;
}

export const DOCMOSIS_LOAD = definePodJobKind({
  kind: DOCMOSIS_LOAD_KIND,
  args: docmosisLoadArgs,
  result: docmosisLoadResult,
  errors: DOCMOSIS_LOAD_ERRORS,
  timeoutMs: 2 * 60_000,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  oneAtATime: true,
  precheck: async (db, { viewerOid, args }) => {
    const { path, blob_sha } = args as DocmosisLoadArgs;
    return pickRefusal(await libraryEntrySize(db, viewerOid, path, blob_sha));
  }
});
