import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.ts";
import { caseTypeFields, fitFields, listCaseTypes, SCRIPT_MISSING, scriptFailure } from "./ccd-case-types.ts";
import { ccdCaseTypeFields, ccdCaseTypes, POD_JOB_HANDLERS } from "./pod-job-handlers.ts";
import type { PodJobContext } from "./pod-jobs.ts";

const context = (): PodJobContext =>
  ({
    jobId: "j",
    conversationId: "c",
    agentId: undefined,
    signal: new AbortController().signal,
    api: {} as never,
    env: { VIRTUAL_AGENT_WORKSPACE: "/ws" } as Env,
    say: () => undefined
  }) as PodJobContext;

const answering = (stdout: string, code = 0, stderr = "") => ({ run: vi.fn(async () => ({ code, stdout, stderr })), exists: () => true });

describe("the CCD pod-job handlers", () => {
  it("should be registered with budgets inside the hub's times for them", () => {
    expect(POD_JOB_HANDLERS).toEqual(expect.arrayContaining([ccdCaseTypes, ccdCaseTypeFields]));
    expect(ccdCaseTypes.budgetMs).toBeLessThan(60_000);
    expect(ccdCaseTypeFields.budgetMs).toBeLessThan(180_000);
  });
});

describe("listCaseTypes", () => {
  it("should answer the case types the script lists, in the hub's shape", async () => {
    const deps = answering(
      JSON.stringify([{ product: "sptribs", service: "sptribs", caseType: "CriminalInjuriesCompensation", repo: "apps/x", ccdConfig: "config-generator" }])
    );

    expect(await listCaseTypes({}, context(), deps)).toEqual({
      case_types: [{ product: "sptribs", service: "sptribs", case_type: "CriminalInjuriesCompensation", config: "config-generator" }]
    });
    expect(deps.run).toHaveBeenCalledWith("/ws/scripts/ccd-case-types", ["list"], expect.objectContaining({ timeoutMs: 40_000 }));
  });

  it("should leave out a row whose case type or product is not one the hub accepts", async () => {
    const deps = answering(
      JSON.stringify([
        { product: "Bad", caseType: "A" },
        { product: "ok", caseType: "-x" },
        { product: "ok", caseType: "Good", ccdConfig: "other" }
      ])
    );

    expect(await listCaseTypes({}, context(), deps)).toEqual({ case_types: [{ product: "ok", service: "ok", case_type: "Good", config: null }] });
  });

  it("should answer script_missing when the workspace has no such script", async () => {
    await expect(listCaseTypes({}, context(), { ...answering("[]"), exists: () => false })).rejects.toMatchObject({
      code: "script_missing",
      detail: SCRIPT_MISSING
    });
  });

  it("should refuse arguments it cannot run", async () => {
    await expect(listCaseTypes({ product: "x" }, context(), answering("[]"))).rejects.toThrow("not ones this client can run");
  });

  it("should answer unreadable when the script prints something that is not a list", async () => {
    await expect(listCaseTypes({}, context(), answering("{}"))).rejects.toMatchObject({ code: "unreadable" });
    await expect(listCaseTypes({}, context(), answering("nope"))).rejects.toMatchObject({ code: "unreadable" });
  });
});

describe("caseTypeFields", () => {
  it("should pass the case type and product as their own arguments", async () => {
    const deps = answering("[]");

    await caseTypeFields({ case_type: "NFD", product: "nfdiv" }, context(), deps);

    expect(deps.run).toHaveBeenCalledWith(
      "/ws/scripts/ccd-case-types",
      ["fields", "NFD", "--product", "nfdiv"],
      expect.objectContaining({ timeoutMs: 160_000 })
    );
  });

  it.each([{ case_type: "--product" }, { case_type: "A", product: "Bad" }, { case_type: "A", other: 1 }, {}, null])(
    "should refuse arguments it cannot run: %j",
    async (args) => {
      await expect(caseTypeFields(args, context(), answering("[]"))).rejects.toThrow("not ones this client can run");
    }
  );

  it("should drop label rows and absent values and keep what matching reads", async () => {
    const rows = [
      { ID: "H", Label: "### Heading", FieldType: "Label", FieldTypeParameter: null, HintText: null },
      { ID: "a", Label: "A", FieldType: "Text", FieldTypeParameter: null, HintText: "hint" }
    ];

    expect(await caseTypeFields({ case_type: "T" }, context(), answering(JSON.stringify(rows)))).toEqual({
      fields: [{ ID: "a", Label: "A", FieldType: "Text", HintText: "hint" }],
      total: 2,
      omitted: 0
    });
  });

  it.each([
    ["unknown case type: Nope. Run: ccd-case-types list", "unknown_case_type"],
    ["NFD is defined by more than one product (a, b). Pass --product.", "ambiguous_case_type"],
    ["apps/x/y is not cloned. Clone it with: ./scripts/add-repo", "not_cloned"],
    ["generateCCDConfig failed in apps/x/y.", "generation_failed"],
    ["something else", "failed"]
  ])("should answer %s as %s", async (stderr, code) => {
    await expect(caseTypeFields({ case_type: "T" }, context(), answering("", 1, stderr))).rejects.toMatchObject({ code });
  });
});

describe("fitFields", () => {
  const big = (id: string, extra = 150) => ({ ID: id, Label: "L".repeat(extra), FieldType: "Text" });

  it("should clip text to the hub's limits", () => {
    const [row] = fitFields([{ ID: "a", Label: "x".repeat(500), FieldType: "Text", HintText: "y".repeat(500) }]).fields;
    expect(row?.Label).toHaveLength(200);
    expect(row?.HintText).toHaveLength(200);
  });

  it("should drop the Parent.Child members first when the answer is over its size", () => {
    const rows = [big("a"), big("a.b"), big("c")];
    const limit = JSON.stringify([big("a"), big("c")]).length + 2;

    expect(fitFields(rows, limit)).toMatchObject({ fields: [{ ID: "a" }, { ID: "c" }], total: 3, omitted: 1 });
  });

  it("should cut from the end when the top-level fields alone are over its size, and say how many", () => {
    const rows = Array.from({ length: 10 }, (_, i) => big(`f${i}`));
    const result = fitFields(rows, 5 * (JSON.stringify(big("f0")).length + 1) + 2);

    expect(result.fields.map((f) => f.ID)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
    expect(result.omitted).toBe(5);
  });

  it("should keep every row when they fit, members included", () => {
    expect(fitFields([big("a"), big("a.b")])).toMatchObject({ omitted: 0, fields: [{ ID: "a" }, { ID: "a.b" }] });
  });
});

describe("scriptFailure", () => {
  it("should report the script's own words for exit 127, not that the script is missing", () => {
    const failure = scriptFailure("/ws/scripts/ccd-case-types: line 40: gradlew: command not found", 127);

    expect(failure.code).toBe("failed");
    expect(failure.detail).toContain("gradlew: command not found");
  });

  it.each([
    ["yq not on PATH. Install via the devcontainer feature", "yq"],
    ["jq not on PATH.", "jq"]
  ])("should name the missing tool when the script says %s", (stderr, tool) => {
    const failure = scriptFailure(stderr, 1);

    expect(failure.code).toBe("tool_missing");
    expect(failure.detail).toContain(tool);
  });

  it("should still cut long words", () => {
    expect(scriptFailure("x".repeat(1000), 1).detail).toHaveLength(280);
  });
});
