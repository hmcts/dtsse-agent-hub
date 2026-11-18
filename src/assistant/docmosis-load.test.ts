import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { MAX_DOCX_BYTES } from "./docmosis.ts";
import { basename, DOCMOSIS_LOAD, docmosisLoadArgs, docmosisLoadResult, loadedSummary, pickRefusal, STALE_PICK } from "./docmosis-load.ts";
import { checkPodJobArgs, checkPodJobResult } from "./pod-jobs.ts";

const BLOB = "b".repeat(40);
const ARGS = { path: "Templates/Base/Claim form.docx", blob_sha: BLOB, base_version: 0, base_revision: 0 };

/** A database whose one query answers `rows`, recording what it was asked. */
function databaseAnswering(rows: unknown[]): { db: Database; asked: unknown[][] } {
  const asked: unknown[][] = [];
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      asked.push(values);
      return rows;
    }
  } as unknown as Database;
  return { db, asked };
}

describe("the docmosis.load kind", () => {
  it("should be one at a time, under two minutes and 20 loads in ten minutes", () => {
    expect(DOCMOSIS_LOAD.kind).toBe("docmosis.load");
    expect(DOCMOSIS_LOAD.oneAtATime).toBe(true);
    expect(DOCMOSIS_LOAD.timeoutMs).toBe(120_000);
    expect(DOCMOSIS_LOAD.rateLimit).toEqual({ limit: 20, windowMs: 600_000 });
    expect(DOCMOSIS_LOAD.errors).toEqual(["signed_out", "sso", "not_found", "rate_limited", "too_large", "not_docx", "checksum", "schema_failed", "conflict"]);
  });

  it("should take a library path, a blob and the base when the args are a pick", () => {
    expect(checkPodJobArgs(DOCMOSIS_LOAD, ARGS)).toEqual(ARGS);
  });

  it.each([
    ["a path outside the library", { ...ARGS, path: "Other/Claim form.docx" }, /^args\.path: /],
    ["a path that is not a .docx", { ...ARGS, path: "Templates/Base/notes.txt" }, /^args\.path: /],
    ["a blob that is not a SHA-1", { ...ARGS, blob_sha: "B".repeat(40) }, /^args\.blob_sha: /],
    ["a negative base", { ...ARGS, base_version: -1 }, /^args\.base_version: /],
    ["a missing base revision", { path: ARGS.path, blob_sha: BLOB, base_version: 0 }, /^args\.base_revision: /],
    ["a field the pod would not read", { ...ARGS, name: "x" }, /^args/]
  ])("should refuse %s", (_label, args, message) => {
    expect(() => checkPodJobArgs(DOCMOSIS_LOAD, args)).toThrow(message);
  });

  it("should take the version and revision written as its result, and nothing else", () => {
    expect(checkPodJobResult(DOCMOSIS_LOAD, { version: 3, revision: 0 })).toEqual({ version: 3, revision: 0 });
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

  it("should refuse when the viewer's index does not hold the pick", async () => {
    const { db } = databaseAnswering([]);

    expect(await DOCMOSIS_LOAD.precheck?.(db, { viewerOid: "oid-a", conversationId: "c", args: ARGS })).toEqual({ status: 409, error: STALE_PICK });
  });
});

describe("loadedSummary", () => {
  it("should name the file without its folders", () => {
    expect(basename("Templates/Base/Claim form.docx")).toBe("Claim form.docx");
    expect(loadedSummary("Templates/Base/Claim form.docx")).toBe("Loaded Claim form.docx");
  });

  it("should cut the summary to the column's 200 characters when the file's name is long", () => {
    const summary = loadedSummary(`Templates/${"x".repeat(300)}.docx`);

    expect(summary).toHaveLength(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});
