import { z } from "zod";
import type { Database } from "../store/prisma.ts";
import { OLDEST_FIRST, podLacksItems } from "./artefact-store.ts";
import { ITEMS_CREATE_REFUSED_DOCMOSIS, MAX_DOCX_BYTES, MAX_SUMMARY } from "./docmosis.ts";
import { DOCMOSIS_LIBRARY, isLibraryPath } from "./docmosis-library.ts";
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

/**
 * What the browser sends, and the library it is from, which the hub adds as it accepts the request so the pod reads the
 * blob from the library the precheck found the pick in. The browser may leave the library out, and nothing but
 * `DOCMOSIS_LIBRARY` is taken for it.
 */
export const docmosisLoadArgs = z.strictObject({
  owner: z.literal(DOCMOSIS_LIBRARY.owner).default(DOCMOSIS_LIBRARY.owner),
  repo: z.literal(DOCMOSIS_LIBRARY.repo).default(DOCMOSIS_LIBRARY.repo),
  folder: z.literal(DOCMOSIS_LIBRARY.path).default(DOCMOSIS_LIBRARY.path),
  path: z.string().refine((path) => isLibraryPath(path), { message: "must be a .docx in the template library" }),
  blob_sha: z.string().regex(/^[0-9a-f]{40}$/, "must be the blob's git SHA-1, 40 lowercase hex digits"),
  /** The template the load replaces; left out, it makes a new one. */
  item: z.uuid().optional(),
  base_version: z.number().int().nonnegative(),
  base_revision: z.number().int().nonnegative()
});

export type DocmosisLoadArgs = z.output<typeof docmosisLoadArgs>;

export const docmosisLoadResult = z.strictObject({
  /** The template written; absent from a job that finished before a conversation held several. */
  item: z.uuid().optional(),
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

/**
 * `Loaded <name>`, the summary of a version a pick wrote, from the file's name without its folders, cut to the
 * column's cap between code points, since a split surrogate pair is text the hub refuses to store.
 */
export function loadedSummary(path: string): string {
  const summary = `Loaded ${basename(path)}`;
  if (summary.length <= MAX_SUMMARY) {
    return summary;
  }
  let cut = "";
  for (const point of summary) {
    if (cut.length + point.length > MAX_SUMMARY - 1) {
      break;
    }
    cut += point;
  }
  return `${cut}…`;
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

/**
 * A load into template `item`, or into a new one without it, must name a template the conversation holds, and on a pod
 * whose client is older than `items` can only replace the primary or make the first: that client writes the primary, so
 * any other load would overwrite the wrong template.
 */
async function targetRefusal(db: Database, conversationId: string, item: string | undefined): Promise<PodJobRefusal | undefined> {
  const primary = await db.assistantDocmosis.findFirst({ where: { conversationId, version: { gt: 0 } }, select: { id: true }, orderBy: [...OLDEST_FIRST] });
  if (item !== undefined && (await db.assistantDocmosis.count({ where: { id: item, conversationId, version: { gt: 0 } } })) === 0) {
    return { status: 404, error: "that chat has no such template" };
  }
  if (item !== undefined ? item === primary?.id : primary === null) {
    return undefined;
  }
  const conversation = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { id: true, virtualAgentId: true, ownerOid: true } });
  return conversation !== null && (await podLacksItems(db, conversation)) ? { status: 409, error: ITEMS_CREATE_REFUSED_DOCMOSIS } : undefined;
}

/**
 * A load into the primary template for a pod on a client older than `items` is sent without `item`, which that client
 * refuses as an unknown argument and writes the primary anyway.
 */
async function withoutPrimaryItem(db: Database, conversationId: string, args: DocmosisLoadArgs): Promise<DocmosisLoadArgs> {
  if (args.item === undefined) {
    return args;
  }
  const conversation = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: { id: true, virtualAgentId: true, ownerOid: true } });
  if (conversation === null || !(await podLacksItems(db, conversation))) {
    return args;
  }
  const { item: _item, ...rest } = args;
  return rest;
}

export const DOCMOSIS_LOAD = definePodJobKind({
  kind: DOCMOSIS_LOAD_KIND,
  args: docmosisLoadArgs,
  result: docmosisLoadResult,
  errors: DOCMOSIS_LOAD_ERRORS,
  timeoutMs: 2 * 60_000,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  oneAtATime: true,
  storedArgs: (db, { conversationId, args }) => withoutPrimaryItem(db, conversationId, args as DocmosisLoadArgs),
  precheck: async (db, { viewerOid, conversationId, args }) => {
    const { path, blob_sha, item } = args as DocmosisLoadArgs;
    return pickRefusal(await libraryEntrySize(db, viewerOid, path, blob_sha)) ?? (await targetRefusal(db, conversationId, item));
  }
});
