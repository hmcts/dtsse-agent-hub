import { describe, expect, it } from "vitest";
import {
  fileIdsOf,
  hasWelshPlugin,
  isRepoOf,
  isSetupKind,
  isTranslationsJson,
  isWelshKind,
  isWelshProduct,
  isXlsx,
  MAX_WELSH_RESULT_BYTES,
  resultFits,
  WELSH_JOB_TIMEOUT_MS,
  welshAnswerBody,
  welshArgs,
  welshFeature,
  welshFileName,
  welshResponse
} from "./welsh.ts";

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FILE_2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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

  it("should take a setup's repo and one or more uploads, but no repo of another product or a file twice", () => {
    const many = Array.from({ length: 50 }, (_, i) => `0f8fad5b-d9cb-469f-a165-${String(i).padStart(12, "0")}`);
    expect(welshArgs("setup_check", "pcs", { repo: "apps/pcs/pcs-frontend" })).toHaveProperty("error");
    expect(welshArgs("setup_check", "pcs", { repo: "apps/pcs/pcs-frontend", file_ids: [] })).toHaveProperty("error");
    expect(welshArgs("setup_check", "pcs", { repo: "apps/pcs/pcs-frontend", file_ids: [FILE] })).toEqual({
      args: { repo: "apps/pcs/pcs-frontend", file_ids: [FILE] }
    });
    expect(welshArgs("setup", "pcs", { repo: "apps/pcs/pcs-frontend", file_ids: many })).toEqual({ args: { repo: "apps/pcs/pcs-frontend", file_ids: many } });
    expect(welshArgs("setup", "pcs", { file_ids: [FILE] })).toHaveProperty("error");
    expect(welshArgs("setup", "pcs", { repo: "apps/cath/cath-service", file_ids: [FILE] })).toEqual({ error: "that is not one of pcs's repos" });
    expect(welshArgs("setup", "pcs", { repo: "apps/pcs/pcs-frontend", file_ids: [FILE, FILE] })).toEqual({ error: "that file is listed twice" });
    expect(welshArgs("setup", "pcs", { repo: "apps/pcs/pcs-frontend", file_ids: ["nope"] })).toEqual({ error: "that is not a file id" });
  });

  it("should refuse a Jira key when its number has more digits than the pod accepts", () => {
    expect(welshArgs("story_candidates", "cath", { key: "PUB-1234567" })).toEqual({ args: { key: "PUB-1234567" } });
    expect(welshArgs("story_candidates", "cath", { key: "PUB-12345678" })).toEqual({ error: "that is not a Jira key, like PUB-1234" });
  });

  it("should need at least one English string for a story preview, and check each choice's shape", () => {
    expect(welshArgs("story_preview", "cath", { key: "PUB-1", strings: [] })).toEqual({ error: "pick at least one English string" });
    expect(welshArgs("story_preview", "cath", { key: "PUB-1", strings: ["Continue"], choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] })).toEqual({
      args: { key: "PUB-1", strings: ["Continue"], choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] }
    });
    expect(welshArgs("apply", "cath", { choices: [{ ref: "CY-1", row_id: "x" }] })).toHaveProperty("error");
  });

  it("should take the refs a request leaves out, and refuse one that is not a ref or a repo of another product", () => {
    expect(welshArgs("request", "cath", { repo: "apps/cath/cath-service", leave_out: ["CY-ABCDEF12"] })).toEqual({
      args: { repo: "apps/cath/cath-service", leave_out: ["CY-ABCDEF12"] }
    });
    expect(welshArgs("request", "cath", {})).toEqual({ args: {} });
    expect(welshArgs("request", "cath", { leave_out: ["--pr"] })).toEqual({ error: "that is not a ref" });
    expect(welshArgs("request", "cath", { leave_out: Array.from({ length: 301 }, () => "CY-ABCDEF12") })).toEqual({ error: "leave out at most 300" });
    expect(welshArgs("request", "cath", { repo: "apps/pcs/pcs-frontend" })).toHaveProperty("error");
  });

  it("should need at least one line of English to keep", () => {
    expect(welshArgs("keep_english", "cath", { strings: [" Rolls Building "] })).toEqual({ args: { strings: ["Rolls Building"] } });
    expect(welshArgs("keep_english", "cath", { strings: [] })).toEqual({ error: "choose at least one" });
    expect(welshArgs("keep_english", "cath", { strings: ["two\nlines"] })).toEqual({ error: "one line each" });
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

  it("should need welsh-review for the kinds an older client ignores, and welsh for the rest", () => {
    expect(welshFeature("request")).toBe("welsh-review");
    expect(welshFeature("keep_english")).toBe("welsh-review");
    expect(welshFeature("scan")).toBe("welsh");
  });

  it("should list the rows to review with nothing, and approve at least one row id", () => {
    expect(welshArgs("review_list", "cath", {})).toEqual({ args: {} });
    expect(welshArgs("review_apply", "cath", { approve: ["0123456789"] })).toEqual({ args: { approve: ["0123456789"] } });
    expect(welshArgs("review_apply", "cath", { approve: [] })).toHaveProperty("error");
    expect(welshArgs("review_apply", "cath", { approve: ["--pr"] })).toEqual({ error: "that is not a catalogue row" });
    expect(welshFeature("review_list")).toBe("welsh-setup");
    expect(welshFeature("review_apply")).toBe("welsh-setup");
  });

  it("should need welsh-setup to set a service up, the only kinds that read a JSON copy", () => {
    expect(welshFeature("setup_check")).toBe("welsh-setup");
    expect(welshFeature("setup")).toBe("welsh-setup");
    expect(isSetupKind("setup")).toBe(true);
    expect(isSetupKind("import")).toBe(false);
  });

  it("should know its kinds and nothing else", () => {
    expect(isWelshKind("story_write")).toBe(true);
    expect(isWelshKind("request")).toBe(true);
    expect(isWelshKind("keep_english")).toBe(true);
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
    expect(fileIdsOf({ file_ids: [FILE, FILE_2, 3] })).toEqual([FILE, FILE_2]);
  });

  it("should know an xlsx by its zip header and the entries a spreadsheet has, and refuse any other zip", () => {
    const zip = (names: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(names)]);
    expect(isXlsx(zip("[Content_Types].xml xl/workbook.xml"))).toBe(true);
    expect(isXlsx(zip("word/document.xml [Content_Types].xml"))).toBe(false);
    expect(isXlsx(zip("photo.jpg"))).toBe(false);
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

  it("should keep a JSON file's name only when JSON is allowed", () => {
    expect(welshFileName("copy.json")).toBeNull();
    expect(welshFileName("copy.json", { json: true })).toBe("copy.json");
    expect(welshFileName("Hen gatalog.xlsx", { json: true })).toBe("Hen gatalog.xlsx");
    expect(welshFileName("copy.txt", { json: true })).toBeNull();
  });

  it("should know a JSON copy of translations by its being an object, and refuse anything else", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(isTranslationsJson(bytes(JSON.stringify({ Back: "Yn ôl" })))).toBe(true);
    expect(isTranslationsJson(bytes("[]"))).toBe(false);
    expect(isTranslationsJson(bytes(JSON.stringify({ Back: "Yn ôl", page: { title: "Teitl" } })))).toBe(false);
    expect(isTranslationsJson(bytes(JSON.stringify({ Count: 3 })))).toBe(false);
    expect(isTranslationsJson(bytes("null"))).toBe(false);
    expect(isTranslationsJson(bytes("{not json"))).toBe(false);
    expect(isTranslationsJson(new Uint8Array([0x7b, 0xff, 0x7d]))).toBe(false);
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
