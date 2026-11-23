import { describe, expect, it } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { CCD_CASE_TYPE_FIELDS, CCD_CASE_TYPES, MAX_CASE_TYPE_FIELDS, MAX_FIELDS_BYTES } from "./ccd-jobs.ts";
import { POD_JOB_REGISTRY } from "./pod-job-kinds.ts";
import { checkPodJobAnswer, checkPodJobArgs, checkPodJobResult, MAX_POD_JOB_RESULT_BYTES, podJobFeature } from "./pod-jobs.ts";

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).message;
  }
  throw new Error("expected a refusal");
};

describe("the CCD pod-job kinds", () => {
  it("should be registered, with claims that fit a client feature's name, when the registry is built", () => {
    expect(POD_JOB_REGISTRY.get("ccd.case-types")).toBe(CCD_CASE_TYPES);
    expect(POD_JOB_REGISTRY.get("ccd.case-type-fields")).toBe(CCD_CASE_TYPE_FIELDS);
    expect(podJobFeature(CCD_CASE_TYPE_FIELDS.kind).length).toBeLessThanOrEqual(50);
  });

  it("should take only the case type id and product the script takes when args are checked", () => {
    expect(checkPodJobArgs(CCD_CASE_TYPE_FIELDS, { case_type: "NFD", product: "nfdiv" })).toEqual({ case_type: "NFD", product: "nfdiv" });
    expect(refusal(() => checkPodJobArgs(CCD_CASE_TYPE_FIELDS, { case_type: "--x" }))).toContain("args.case_type");
    expect(refusal(() => checkPodJobArgs(CCD_CASE_TYPE_FIELDS, { case_type: "A", extra: 1 }))).toContain("args");
    expect(refusal(() => checkPodJobArgs(CCD_CASE_TYPES, { product: "x" }))).toContain("args");
  });

  it("should keep the pod's cap under the hub's cap when the two are compared", () => {
    expect(MAX_FIELDS_BYTES).toBeLessThan(MAX_POD_JOB_RESULT_BYTES);
    expect(CCD_CASE_TYPE_FIELDS.maxResultBytes).toBe(MAX_POD_JOB_RESULT_BYTES);
  });

  it("should accept an answer of fields when it is at the pod's cap", () => {
    const row = { ID: "x".repeat(50), Label: "L".repeat(200), FieldType: "Text" };
    const rows = Array.from({ length: Math.floor(MAX_FIELDS_BYTES / (JSON.stringify(row).length + 1)) }, () => row);

    expect(checkPodJobResult(CCD_CASE_TYPE_FIELDS, { fields: rows, total: rows.length, omitted: 0 })).toMatchObject({ total: rows.length });
  });

  it("should refuse an answer when it is over its size or its row count", () => {
    const row = { ID: "x".repeat(300), Label: "L".repeat(200), FieldType: "T".repeat(60), FieldTypeParameter: "P".repeat(100), HintText: "H".repeat(200) };
    const rows = Array.from({ length: 2200 }, () => row);

    expect(refusal(() => checkPodJobResult(CCD_CASE_TYPE_FIELDS, { fields: rows, total: 1, omitted: 0 }))).toContain("at most");
    expect(
      refusal(() =>
        checkPodJobResult(CCD_CASE_TYPE_FIELDS, {
          fields: Array.from({ length: MAX_CASE_TYPE_FIELDS + 1 }, () => ({ ID: "a", FieldType: "Text" })),
          total: 1,
          omitted: 0
        })
      )
    ).toContain("at most");
  });

  it("should store the code as failed when it is not one the script's wording maps to", () => {
    expect(checkPodJobAnswer(CCD_CASE_TYPE_FIELDS, { status: "failed", error: "unknown_case_type", detail: "unknown case type: X" })).toMatchObject({
      error: "unknown_case_type"
    });
    expect(checkPodJobAnswer(CCD_CASE_TYPE_FIELDS, { status: "failed", error: "made_up" })).toMatchObject({ error: "failed" });
  });

  it("should list a case type with its product, service and configuration when the pod answers", () => {
    const result = { case_types: [{ product: "sptribs", service: "sptribs", case_type: "CriminalInjuriesCompensation", config: "config-generator" }] };
    expect(checkPodJobResult(CCD_CASE_TYPES, result)).toEqual(result);
  });

  it("should read a configuration it does not know as none when the pod passes one through", () => {
    const result = { case_types: [{ product: "sptribs", service: "sptribs", case_type: "X", config: "something-new" }] };

    expect(checkPodJobResult(CCD_CASE_TYPES, result)).toEqual({ case_types: [{ product: "sptribs", service: "sptribs", case_type: "X", config: null }] });
  });
});
