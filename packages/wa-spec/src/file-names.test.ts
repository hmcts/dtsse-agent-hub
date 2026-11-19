import { describe, expect, it } from "vitest";
import { decisionKeyOf, fileNameOf, isWaTaskDmn, parseFileName } from "./file-names.ts";
import { KINDS } from "./schema.ts";

describe("file names", () => {
  it.each(KINDS)("should give back the kind, service and case type of a %s file name when it is built and parsed", (kind) => {
    expect(parseFileName(fileNameOf("care-supervision", kind, "ct_a"))).toEqual({ kind, service: "care-supervision", caseType: "ct_a" });
  });

  it("should end the service at the last hyphen when the service holds hyphens", () => {
    expect(parseFileName("wa-task-completion-a-b-ct.dmn")).toEqual({ kind: "completion", service: "a-b", caseType: "ct" });
    expect(decisionKeyOf("a-b", "task-types", "ct")).toBe("wa-task-types-a-b-ct");
  });

  it("should refuse a name that is not a task DMN when the kind or shape is wrong", () => {
    expect(parseFileName("wa-task-bogus-demo-ct.dmn")).toBeUndefined();
    expect(parseFileName("court_location_for_tasks.dmn")).toBeUndefined();
    expect(parseFileName("wa-task-completion-ct.dmn")).toBeUndefined();
  });

  it("should recognise a task DMN by its prefix and extension when filtering a directory", () => {
    expect(isWaTaskDmn("wa-task-completion-demo-ct.dmn")).toBe(true);
    expect(isWaTaskDmn("wa-task-allowed-days-demo-ct.dmn")).toBe(true);
    expect(isWaTaskDmn("wa-task-x.dmn")).toBe(false);
    expect(isWaTaskDmn("wa-task-completion-demo-ct.xml")).toBe(false);
    expect(isWaTaskDmn("other.dmn")).toBe(false);
  });
});
