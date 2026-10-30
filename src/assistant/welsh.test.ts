import { describe, expect, it } from "vitest";
import {
  fileIdsOf,
  hasWelshPlugin,
  isRepoOf,
  isWelshKind,
  isWelshProduct,
  isXlsx,
  MAX_WELSH_RESULT_BYTES,
  resultFits,
  WELSH_JOB_TIMEOUT_MS,
  welshAnswerBody,
  welshArgs,
  welshFileName,
  welshResponse
} from "./welsh.ts";

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("welshArgs", () => {
  it("should take a search with its mode defaulted when only the query is given", () => {
    expect(welshArgs("search", "cath", { query: " back to top " })).toEqual({ args: { query: "back to top", mode: "contains" } });
  });

  it("should refuse a field the kind does not take, so nothing unexpected reaches the pod", () => {
    expect(welshArgs("search", "cath", { query: "x", shell: "rm -rf /" })).toHaveProperty("error");
    expect(welshArgs("info", "cath", { anything: 1 })).toHaveProperty("error");
  });

  it("should take a repo only when it is one of the product's own", () => {
    expect(welshArgs("scan", "cath", { repo: "apps/cath/cath-service" })).toEqual({ args: { repo: "apps/cath/cath-service" } });
    expect(welshArgs("scan", "cath", { repo: "apps/pcs/pcs-frontend" })).toEqual({ error: "that is not one of cath's repos" });
    expect(welshArgs("scan", "cath", { repo: "apps/cath/../../etc" })).toHaveProperty("error");
  });

  it("should need a file for an import and a Jira key for a story", () => {
    expect(welshArgs("import", "cath", { file_id: FILE })).toEqual({ args: { file_id: FILE } });
    expect(welshArgs("import", "cath", { file_id: "../x" })).toHaveProperty("error");
    expect(welshArgs("story_candidates", "cath", { key: "PUB-1234" })).toEqual({ args: { key: "PUB-1234" } });
    expect(welshArgs("story_candidates", "cath", { key: "pub 1234" })).toEqual({ error: "that is not a Jira key, like PUB-1234" });
  });

  it("should need at least one English string for a story preview, and check each choice's shape", () => {
    expect(welshArgs("story_preview", "cath", { key: "PUB-1", strings: [] })).toEqual({ error: "pick at least one English string" });
    expect(welshArgs("story_preview", "cath", { key: "PUB-1", strings: ["Continue"], choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] })).toEqual({
      args: { key: "PUB-1", strings: ["Continue"], choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] }
    });
    expect(welshArgs("apply", "cath", { choices: [{ ref: "CY-1", row_id: "x" }] })).toHaveProperty("error");
  });
});

describe("the small checks", () => {
  it("should offer only public-facing services", () => {
    expect(isWelshProduct("cath")).toBe(true);
    expect(isWelshProduct("ccd")).toBe(false);
    expect(isWelshProduct("xui")).toBe(false);
    expect(isWelshProduct("general")).toBe(false);
    expect(isWelshProduct("platform")).toBe(false);
    expect(isWelshProduct(7)).toBe(false);
  });

  it("should know its kinds and nothing else", () => {
    expect(isWelshKind("story_write")).toBe(true);
    expect(isWelshKind("translate")).toBe(false);
  });

  it("should read a repo path as apps/<product>/<name> only", () => {
    expect(isRepoOf("cath", "apps/cath/cath-service")).toBe(true);
    expect(isRepoOf("cath", "apps/cath/..")).toBe(false);
    expect(isRepoOf("cath", "apps/cath/a/b")).toBe(false);
    expect(isRepoOf("cath", "libs/cath/a")).toBe(false);
  });

  it("should name the files a job reads", () => {
    expect(fileIdsOf({ file_id: FILE })).toEqual([FILE]);
    expect(fileIdsOf({})).toEqual([]);
  });

  it("should know an xlsx by its zip header", () => {
    expect(isXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toBe(true);
    expect(isXlsx(new TextEncoder().encode("English,Welsh"))).toBe(false);
  });

  it("should keep a file name's last part, safe characters and accents, and only for an xlsx", () => {
    expect(welshFileName("C%3A%5Cfakepath%5CDychweliad%20Cymraeg.xlsx")).toBe("Dychweliad Cymraeg.xlsx");
    expect(welshFileName('../../etc/a"b;.xlsx')).toBe("a_b_.xlsx");
    expect(welshFileName("ymateb-ŵ.xlsx")).toBe("ymateb-ŵ.xlsx");
    expect(welshFileName("return.csv")).toBeNull();
    expect(welshFileName("%E0%A4%A")).toBeNull();
    expect(welshFileName(undefined)).toBeNull();
  });

  it("should refuse a result over the cap", () => {
    expect(resultFits({ hits: [] })).toBe(true);
    expect(resultFits({ big: "x".repeat(MAX_WELSH_RESULT_BYTES) })).toBe(false);
  });

  it("should take a result object or an error, and nothing else, as the pod's answer", () => {
    expect(welshAnswerBody.safeParse({ result: { total: 1 } }).success).toBe(true);
    expect(welshAnswerBody.safeParse({ error: "signed_out", detail: "Sign in to GitHub" }).success).toBe(true);
    expect(welshAnswerBody.safeParse({ error: "translated" }).success).toBe(false);
    expect(welshAnswerBody.safeParse({ result: [1] }).success).toBe(false);
  });
});

describe("welshResponse", () => {
  const created = new Date("2026-10-28T10:00:00Z");
  const row = { id: "j1", kind: "scan", status: "pending", result: null, error: null, detail: null, createdAt: created };

  it("should answer pending while a job runs, and timeout once it has run too long", () => {
    expect(welshResponse(row, [], new Date(created.getTime() + 1000))).toEqual({ status: "pending", job_id: "j1" });
    expect(welshResponse(row, [], new Date(created.getTime() + WELSH_JOB_TIMEOUT_MS + 1))).toEqual({ status: "timeout" });
  });

  it("should answer a finished job with its result and files", () => {
    const files = [{ file_id: FILE, name: "request.xlsx", bytes: 10 }];
    expect(welshResponse({ ...row, status: "done", result: { summary: {} } }, files)).toEqual({ status: "done", kind: "scan", result: { summary: {} }, files });
  });

  it("should answer a failure in the pod's words, and a sign-in it needs as signed_out", () => {
    expect(welshResponse({ ...row, status: "failed", error: "signed_out", detail: "Sign in to GitHub in Settings" }, [])).toEqual({
      status: "signed_out",
      detail: "Sign in to GitHub in Settings"
    });
    expect(welshResponse({ ...row, status: "failed", error: "signed_out" }, [])).toEqual({
      status: "signed_out",
      detail: "Your assistant needs you to sign in again."
    });
    expect(welshResponse({ ...row, status: "failed", error: "failed", detail: "No such repo" }, [])).toEqual({ status: "failed", detail: "No such repo" });
    expect(welshResponse({ ...row, status: "done", result: "not an object" }, [])).toEqual({ status: "failed", detail: "That did not work. Try again." });
  });
});

describe("the public-facing services", () => {
  it("should each be a product the Assistant knows", async () => {
    const { PUBLIC_FACING_SERVICES, WELSH_PRODUCTS } = await import("./welsh.ts");
    expect(WELSH_PRODUCTS.map((p) => p.slug).sort((a, b) => (a < b ? -1 : 1))).toEqual([...PUBLIC_FACING_SERVICES].sort((a, b) => (a < b ? -1 : 1)));
  });
});

describe("hasWelshPlugin", () => {
  it("should be true only when the welsh plugin is among the ticked ones", () => {
    expect(hasWelshPlugin({ plugins: ["dtsse", "welsh"] })).toBe(true);
    expect(hasWelshPlugin({ plugins: ["pcs"] })).toBe(false);
    expect(hasWelshPlugin({ plugins: [] })).toBe(false);
  });
});
