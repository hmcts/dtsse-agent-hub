import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { ITEMS_CREATE_REFUSED_DOCMOSIS, MAX_DOCX_BYTES } from "./docmosis.ts";
import { basename, DOCMOSIS_LOAD, docmosisLoadArgs, docmosisLoadResult, loadedSummary, pickRefusal, STALE_PICK } from "./docmosis-load.ts";
import { checkPodJobArgs, checkPodJobResult } from "./pod-jobs.ts";

const BLOB = "b".repeat(40);
const ARGS = { path: "Templates/Base/Claim form.docx", blob_sha: BLOB, base_version: 0, base_revision: 0 };
const LIBRARY = { owner: "hmcts", repo: "rdo-docmosis", folder: "Templates" };

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * A database whose one raw query answers `rows`, recording what it was asked, and which holds the conversation's
 * templates `held`, oldest first, on a pod whose client claims `claims`.
 */
function databaseAnswering(
  rows: unknown[],
  { held = [], claims = ["items"] }: { held?: string[]; claims?: string[] } = {}
): { db: Database; asked: unknown[][] } {
  const asked: unknown[][] = [];
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.push(values);
      return rows;
    },
    assistantDocmosis: {
      findFirst: async () => (held[0] === undefined ? null : { id: held[0] }),
      count: async ({ where }: { where: { id: string } }) => (held.includes(where.id) ? 1 : 0)
    },
    assistantConversation: { findUnique: async () => ({ id: "c", virtualAgentId: "v", ownerOid: "oid-a" }) },
    virtualAgent: { findUnique: async () => ({ status: "running", clientFeatures: claims, agent: null }) }
  } as unknown as Database;
  return { db, asked };
}

describe("the docmosis.load kind", () => {
  it("should be one at a time, under two minutes and 20 loads in ten minutes when registered", () => {
    expect(DOCMOSIS_LOAD.kind).toBe("docmosis.load");
    expect(DOCMOSIS_LOAD.oneAtATime).toBe(true);
    expect(DOCMOSIS_LOAD.timeoutMs).toBe(120_000);
    expect(DOCMOSIS_LOAD.rateLimit).toEqual({ limit: 20, windowMs: 600_000 });
    expect(DOCMOSIS_LOAD.errors).toEqual(["signed_out", "sso", "not_found", "rate_limited", "too_large", "not_docx", "checksum", "schema_failed", "conflict"]);
  });

  it("should take a library path, a blob and the base, and add the library, when the args are a pick", () => {
    expect(checkPodJobArgs(DOCMOSIS_LOAD, ARGS)).toEqual({ ...LIBRARY, ...ARGS });
  });

  it("should take the template to replace as an optional item when the args name one", () => {
    expect(checkPodJobArgs(DOCMOSIS_LOAD, { ...ARGS, item: PRIMARY })).toEqual({ ...LIBRARY, ...ARGS, item: PRIMARY });
    expect(() => checkPodJobArgs(DOCMOSIS_LOAD, { ...ARGS, item: "nope" })).toThrow(/^args\.item: /);
  });

  it("should keep the library when stored args that carry it are parsed again", () => {
    const stored = checkPodJobArgs(DOCMOSIS_LOAD, ARGS);

    expect(docmosisLoadArgs.parse(stored)).toEqual(stored);
  });

  it.each([
    ["a path outside the library", { ...ARGS, path: "Other/Claim form.docx" }, /^args\.path: /],
    ["a path that is not a .docx", { ...ARGS, path: "Templates/Base/notes.txt" }, /^args\.path: /],
    ["a blob that is not a SHA-1", { ...ARGS, blob_sha: "B".repeat(40) }, /^args\.blob_sha: /],
    ["a negative base", { ...ARGS, base_version: -1 }, /^args\.base_version: /],
    ["a missing base revision", { path: ARGS.path, blob_sha: BLOB, base_version: 0 }, /^args\.base_revision: /],
    ["a field the pod would not read", { ...ARGS, name: "x" }, /^args/],
    ["another owner", { ...ARGS, owner: "someone" }, /^args\.owner: /],
    ["another repository", { ...ARGS, repo: "elsewhere" }, /^args\.repo: /],
    ["another folder", { ...ARGS, folder: "Base" }, /^args\.folder: /]
  ])("should refuse the args when they have %s", (_label, args, message) => {
    expect(() => checkPodJobArgs(DOCMOSIS_LOAD, args)).toThrow(message);
  });

  it("should take the version and revision written as its result, and nothing else, when the pod answers", () => {
    expect(checkPodJobResult(DOCMOSIS_LOAD, { version: 3, revision: 0 })).toEqual({ version: 3, revision: 0 });
    expect(checkPodJobResult(DOCMOSIS_LOAD, { item: PRIMARY, version: 3, revision: 0 })).toEqual({ item: PRIMARY, version: 3, revision: 0 });
    expect(docmosisLoadResult.safeParse({ version: 0, revision: 0 }).success).toBe(false);
    expect(docmosisLoadResult.safeParse({ version: 1, revision: 0, extra: true }).success).toBe(false);
    expect(docmosisLoadArgs.safeParse(ARGS).success).toBe(true);
  });
});

describe("pickRefusal", () => {
  it("should let a pick through when the index holds it and it is small enough", () => {
    expect(pickRefusal(MAX_DOCX_BYTES)).toBeUndefined();
  });

  it("should refuse with 409 when the index no longer holds the pick", () => {
    expect(pickRefusal(undefined)).toEqual({ status: 409, error: STALE_PICK });
  });

  it("should refuse with 413 when the template is over the .docx cap", () => {
    expect(pickRefusal(MAX_DOCX_BYTES + 1)?.status).toBe(413);
  });
});

describe("the docmosis.load precheck", () => {
  it("should look the pick up in the viewer's own index and pass it when it is there", async () => {
    const { db, asked } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }]);

    const refused = await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS });

    expect(refused).toBeUndefined();
    expect(asked[0]).toEqual(expect.arrayContaining(["oid-a", ARGS.path, BLOB]));
  });

  it("should pass a load that makes the first template when the conversation holds none", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [], claims: [] });

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS })).toBeUndefined();
  });

  it("should refuse a load into a template the conversation does not hold with 404", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [PRIMARY] });

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: { ...ARGS, item: OTHER } })).toEqual({
      status: 404,
      error: "that chat has no such template"
    });
  });

  it("should pass a load that makes a second template when the pod's client claims items", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [PRIMARY], claims: ["items"] });

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS })).toBeUndefined();
  });

  it("should refuse a load that makes a second template when the pod's client is older than items", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [PRIMARY], claims: [] });

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS })).toEqual({
      status: 409,
      error: ITEMS_CREATE_REFUSED_DOCMOSIS
    });
  });

  it("should refuse a load into a template other than the primary when the pod's client is older than items", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [PRIMARY, OTHER], claims: [] });

    expect((await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: { ...ARGS, item: OTHER } }))?.status).toBe(409);
  });

  it("should pass a load into the primary when the pod's client is older than items", async () => {
    const { db } = databaseAnswering([{ owner_oid: "oid-a", size: 1200 }], { held: [PRIMARY, OTHER], claims: [] });

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: { ...ARGS, item: PRIMARY } })).toBeUndefined();
  });

  it("should send the args without the primary's item to a pod older than items, which refuses an argument it does not know", async () => {
    const { db } = databaseAnswering([], { held: [PRIMARY], claims: [] });
    const args = { ...LIBRARY, ...ARGS, item: PRIMARY };

    expect(await DOCMOSIS_LOAD.storedArgs?.(db, { viewerOid: "oid-a", conversationId: "c", args })).toEqual({ ...LIBRARY, ...ARGS });
  });

  it("should send the args as they are to a pod that claims items, and when they name no item", async () => {
    const { db } = databaseAnswering([], { held: [PRIMARY], claims: ["items"] });
    const named = { ...LIBRARY, ...ARGS, item: PRIMARY };
    const unnamed = { ...LIBRARY, ...ARGS };

    expect(await DOCMOSIS_LOAD.storedArgs?.(db, { viewerOid: "oid-a", conversationId: "c", args: named })).toEqual(named);
    expect(await DOCMOSIS_LOAD.storedArgs?.(db, { viewerOid: "oid-a", conversationId: "c", args: unnamed })).toEqual(unnamed);
  });

  it("should refuse when the viewer's index does not hold the pick", async () => {
    const { db } = databaseAnswering([]);

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS })).toEqual({ status: 409, error: STALE_PICK });
  });
});

describe("loadedSummary", () => {
  it("should name the file without its folders when the path has some", () => {
    expect(basename("Templates/Base/Claim form.docx")).toBe("Claim form.docx");
    expect(loadedSummary("Templates/Base/Claim form.docx")).toBe("Loaded Claim form.docx");
  });

  it("should cut the summary to the column's 200 characters when the file's name is long", () => {
    const summary = loadedSummary(`Templates/${"x".repeat(300)}.docx`);

    expect(summary).toHaveLength(200);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("should never split a surrogate pair when the cut falls inside one", () => {
    // "Loaded a" is 8 units, so the 199th unit of the summary is the first half of the 96th emoji.
    const summary = loadedSummary(`Templates/a${"😀".repeat(150)}.docx`);

    expect(summary.isWellFormed()).toBe(true);
    expect(summary).toBe(`Loaded a${"😀".repeat(95)}…`);
  });
});
