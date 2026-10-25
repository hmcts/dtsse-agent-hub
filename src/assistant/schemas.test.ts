import { describe, expect, it } from "vitest";
import { artefactPutBody, MAX_ARTEFACT_MARKDOWN, sessionsReportBody } from "./schemas.ts";

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
