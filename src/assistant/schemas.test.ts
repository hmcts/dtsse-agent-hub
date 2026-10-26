import { describe, expect, it } from "vitest";
import { artefactPutBody, MAX_ARTEFACT_MARKDOWN, sessionsReportBody, uploadsReportBody } from "./schemas.ts";
import { MAX_REPORTED_FILES } from "./upload-report.ts";

describe("artefactPutBody", () => {
  it("should accept markdown and a base version when the title is left out", () => {
    expect(artefactPutBody.parse({ markdown: "# Draft", base_version: 0 })).toEqual({ markdown: "# Draft", base_version: 0 });
  });

  it("should trim the title when one is sent", () => {
    expect(artefactPutBody.parse({ title: "  Plan  ", markdown: "", base_version: 3 }).title).toBe("Plan");
  });

  it.each([
    [{ markdown: "x".repeat(MAX_ARTEFACT_MARKDOWN + 1), base_version: 0 }],
    [{ markdown: "", base_version: -1 }],
    [{ markdown: "", base_version: 1.5 }],
    [{ markdown: "", base_version: 0, title: " " }],
    [{ base_version: 0 }]
  ])("should refuse %j when it breaks the contract's limits", (body) => {
    expect(artefactPutBody.safeParse(body).success).toBe(false);
  });
});

describe("sessionsReportBody", () => {
  it("should accept the supervisor's report when it lists its sessions", () => {
    const report = { sessions: [{ conversation_id: "c1", state: "queued", detail: "waiting" }], max: 2 };

    expect(sessionsReportBody.parse(report)).toEqual(report);
  });

  it.each([
    [{ sessions: [], max: 0 }],
    [{ sessions: [], max: 21 }],
    [{ sessions: [{ conversation_id: "c1", state: "stopping" }], max: 2 }],
    [{ sessions: Array.from({ length: 51 }, (_, index) => ({ conversation_id: `c${index}`, state: "live" })), max: 2 }]
  ])("should refuse %j when it breaks the contract's limits", (body) => {
    expect(sessionsReportBody.safeParse(body).success).toBe(false);
  });

  it("should raise one issue rather than one per session when the report is over the cap", () => {
    const result = sessionsReportBody.safeParse({ sessions: Array.from({ length: 5000 }, () => ({})), max: 2 });

    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.code).toBe("too_big");
  });
});

describe("uploadsReportBody", () => {
  const report = {
    uploads_bytes: 2048,
    volume_used_bytes: 30 * 1024 ** 3,
    volume_total_bytes: 32 * 1024 ** 3,
    files_total: 1,
    files: [{ upload_id: "0f8a6a1e-0000-4000-8000-000000000001", bytes: 2048 }],
    deleted: ["0f8a6a1e-0000-4000-8000-000000000002"]
  };

  it("should take a pod's report of its volume when every figure and list is there", () => {
    expect(uploadsReportBody.parse(report)).toEqual(report);
  });

  it("should take a report of an empty volume, which is a real answer rather than a missing one", () => {
    expect(uploadsReportBody.safeParse({ ...report, uploads_bytes: 0, files_total: 0, files: [], deleted: [] }).success).toBe(true);
  });

  // Leaving a list out would read as an authoritative empty one, and the hub acts on both: `deleted` is what ends a
  // deletion request, and `files` is what it shows. So absence is refused rather than defaulted.
  it.each([
    "files",
    "deleted",
    "files_total",
    "uploads_bytes",
    "volume_used_bytes",
    "volume_total_bytes"
  ] as const)("should refuse a report with no %s at all", (field) => {
    const { [field]: _omitted, ...without } = report;

    expect(uploadsReportBody.safeParse(without).success).toBe(false);
  });

  it.each([
    ["files", "not an array"],
    ["deleted", { "0": "an id" }],
    ["files_total", -1],
    ["uploads_bytes", 1.5],
    ["volume_total_bytes", "lots"]
  ])("should refuse a report whose %s is not the shape the contract gives", (field, value) => {
    expect(uploadsReportBody.safeParse({ ...report, [field]: value }).success).toBe(false);
  });

  it("should refuse a report naming more files than one carries, rather than quietly cut it", () => {
    const files = Array.from({ length: MAX_REPORTED_FILES + 1 }, () => ({ upload_id: "0f8a6a1e-0000-4000-8000-000000000001", bytes: 1 }));

    expect(uploadsReportBody.safeParse({ ...report, files }).success).toBe(false);
  });
});
